import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { signatureSimilarity, type ClaimSignature } from "./claimSignature.js";
import type { ClaimAnswer, EvidenceSearchResult, PopularClaim } from "./types.js";

const answerFormatVersion = "research_story_v91";
// Bump when the shape of a stored retrieval changes, so a deploy cannot serve
// papers that the current renderer can no longer interpret.
const hostEvidenceFormatVersion = "host_evidence_v1";
// Bump when SearchPlan's shape changes so a stored plan cannot be replayed
// into a pipeline that no longer understands it.
// v2: planner labels are now split on parenthetical glosses, RxNorm may no
// longer replace a food with a pharmaceutical product, and the Korean brand
// table settles more names. Plans cached before those changes carry the old
// defects, so they must not be replayed.
const searchPlanFormatVersion = "search_plan_v2";

interface CacheRow {
  claim_id: string;
  answer_json: string;
  signature_tokens_json: string;
  category: ClaimSignature["category"];
  direction: ClaimSignature["direction"];
  numeric_signature: string;
}

export class ClaimCache {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  get(normalizedQuestion: string, signature: ClaimSignature, now = new Date()): ClaimAnswer | undefined {
    const exact = this.db
      .prepare(
        `SELECT c.claim_id, c.answer_json, c.signature_tokens_json, c.category, c.direction, c.numeric_signature
         FROM claim_aliases_v2 a
         JOIN claim_cache_v2 c ON c.claim_id = a.claim_id
         WHERE a.question_hash = ? AND c.format_version = ? AND datetime(c.expires_at) > datetime(?)
         LIMIT 1`
    )
      .get(questionHash(normalizedQuestion), answerFormatVersion, now.toISOString()) as CacheRow | undefined;
    if (exact) return this.hydrate(exact, now);
    return undefined;
  }

  getByClaimId(claimId: string, signature?: ClaimSignature, now = new Date()): ClaimAnswer | undefined {
    const row = this.db
      .prepare(
        `SELECT claim_id, answer_json, signature_tokens_json, category, direction, numeric_signature
         FROM claim_cache_v2
         WHERE claim_id = ? AND format_version = ? AND datetime(expires_at) > datetime(?)
         LIMIT 1`
      )
      .get(claimId, answerFormatVersion, now.toISOString()) as CacheRow | undefined;
    if (!row) return undefined;
    if (signature && !isCompatibleSignature(row, signature)) return undefined;
    return this.hydrate(row, now);
  }

  save(
    normalizedQuestion: string,
    signature: ClaimSignature,
    answer: ClaimAnswer,
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    now = new Date()
  ): ClaimAnswer {
    const hash = questionHash(normalizedQuestion);
    const alias = this.db.prepare("SELECT claim_id FROM claim_aliases_v2 WHERE question_hash = ? LIMIT 1").get(hash) as
      | { claim_id: string }
      | undefined;
    const claimId = answer.claim_id || alias?.claim_id || randomUUID();
    const existing = this.db.prepare("SELECT hit_count FROM claim_cache_v2 WHERE claim_id = ? LIMIT 1").get(claimId) as
      | { hit_count: number }
      | undefined;
    const hitCount = existing?.hit_count ?? 0;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const storedAnswer: ClaimAnswer = { ...answer, claim_id: claimId, cached: false };

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO claim_cache_v2
            (claim_id, signature_text, signature_tokens_json, category, direction, numeric_signature,
             query_terms_json, answer_json, evidence_status, format_version, hit_count, status, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(claim_id) DO UPDATE SET
             signature_text = excluded.signature_text,
             signature_tokens_json = excluded.signature_tokens_json,
             category = excluded.category,
             direction = excluded.direction,
             numeric_signature = excluded.numeric_signature,
             query_terms_json = excluded.query_terms_json,
             answer_json = excluded.answer_json,
             evidence_status = excluded.evidence_status,
             format_version = excluded.format_version,
             updated_at = excluded.updated_at,
             expires_at = excluded.expires_at`
        )
        .run(
          claimId,
          signature.text,
          JSON.stringify(signature.tokens),
          signature.category,
          signature.direction,
          signature.numericSignature,
          JSON.stringify(answer.query_terms),
          JSON.stringify(storedAnswer),
          answer.evidence_status ?? "verified",
          answerFormatVersion,
          hitCount,
          hitCount >= 2 ? "promoted" : "temporary",
          now.toISOString(),
          now.toISOString(),
          expiresAt
        );
      this.db
        .prepare(
          `INSERT INTO claim_aliases_v2 (question_hash, claim_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(question_hash) DO UPDATE SET claim_id = excluded.claim_id`
        )
        .run(hash, claimId, now.toISOString());
      this.db.prepare("DELETE FROM claim_cache_fts_v2 WHERE claim_id = ?").run(claimId);
      this.db.prepare("INSERT INTO claim_cache_fts_v2 (claim_id, signature_text) VALUES (?, ?)").run(claimId, signature.text);
      const topicKey = signature.tokens.slice(0, 8).join(" ") || signature.category;
      this.db
        .prepare(
          `INSERT INTO anonymous_claim_stats_v2 (topic_key, category, count, first_seen_at, last_seen_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(topic_key, category) DO UPDATE SET
             count = count + 1,
             last_seen_at = excluded.last_seen_at`
        )
        .run(topicKey, signature.category, now.toISOString(), now.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return storedAnswer;
  }

  /**
   * Retrieval cache for the MCP host path. Kakao Tools requires an average
   * tool latency of 100ms, which a live four-database search cannot meet; a
   * repeated question must be answered from the last retrieval instead.
   *
   * This stores what was retrieved for a set of search queries, never a
   * rendered answer. The host's topic, parent and outcome labels are reapplied
   * to the cached papers on every request, so filtering and scope labelling
   * stay live even on a hit.
   */
  getHostEvidence(cacheKey: string, now = new Date()): EvidenceSearchResult | undefined {
    const row = this.db
      .prepare(
        `SELECT evidence_json FROM host_evidence_cache_v1
         WHERE cache_key = ? AND format_version = ? AND datetime(expires_at) > datetime(?)
         LIMIT 1`
      )
      .get(cacheKey, hostEvidenceFormatVersion, now.toISOString()) as { evidence_json: string } | undefined;
    if (!row) return undefined;
    this.db
      .prepare("UPDATE host_evidence_cache_v1 SET hit_count = hit_count + 1 WHERE cache_key = ?")
      .run(cacheKey);
    return { ...(JSON.parse(row.evidence_json) as EvidenceSearchResult), evidenceCacheHit: true };
  }

  saveHostEvidence(cacheKey: string, evidence: EvidenceSearchResult, ttlMs: number, now = new Date()): void {
    // The host's own labels are request-scoped and must not be frozen into a
    // shared retrieval: a later question with different labels reuses these
    // papers and filters them itself.
    const { hostTopicTerms, hostParentTerms, hostOutcomeTerms, evidenceCacheHit, ...retrieval } = evidence;
    void hostTopicTerms, hostParentTerms, hostOutcomeTerms, evidenceCacheHit;
    this.db
      .prepare(
        `INSERT INTO host_evidence_cache_v1 (cache_key, evidence_json, format_version, hit_count, created_at, expires_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           evidence_json = excluded.evidence_json,
           format_version = excluded.format_version,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .run(
        cacheKey,
        JSON.stringify(retrieval),
        hostEvidenceFormatVersion,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString()
      );
  }

  /**
   * A retrieval plan is a pure function of the question, but the planner is a
   * language model and answers differently every call: five runs of "계란 하루
   * 몇개까지 ㄱㅊ?" produced five different term sets, swinging the candidate
   * pool between 20 and 37 papers and the answer between one and five
   * citations. Reusing the first plan makes the same question give the same
   * answer, and skips the slowest step in the request.
   */
  getSearchPlan(normalizedQuestion: string, category: string, now = new Date()): unknown | undefined {
    const row = this.db
      .prepare(
        `SELECT plan_json FROM search_plan_cache_v1
         WHERE question_hash = ? AND format_version = ? AND datetime(expires_at) > datetime(?)
         LIMIT 1`
      )
      .get(searchPlanHash(normalizedQuestion, category), searchPlanFormatVersion, now.toISOString()) as
      | { plan_json: string }
      | undefined;
    if (!row) return undefined;
    this.db
      .prepare("UPDATE search_plan_cache_v1 SET hit_count = hit_count + 1 WHERE question_hash = ?")
      .run(searchPlanHash(normalizedQuestion, category));
    return JSON.parse(row.plan_json) as unknown;
  }

  saveSearchPlan(normalizedQuestion: string, category: string, plan: unknown, ttlMs: number, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO search_plan_cache_v1 (question_hash, plan_json, format_version, hit_count, created_at, expires_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(question_hash) DO UPDATE SET
           plan_json = excluded.plan_json,
           format_version = excluded.format_version,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .run(
        searchPlanHash(normalizedQuestion, category),
        JSON.stringify(plan),
        searchPlanFormatVersion,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString()
      );
  }

  addAlias(normalizedQuestion: string, claimId: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO claim_aliases_v2 (question_hash, claim_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(question_hash) DO UPDATE SET claim_id = excluded.claim_id`
      )
      .run(questionHash(normalizedQuestion), claimId, now.toISOString());
  }

  popular(category: string | undefined, limit: number): PopularClaim[] {
    const sql = category
      ? `SELECT topic_key AS normalized_topic, category, count, last_seen_at
         FROM anonymous_claim_stats_v2 WHERE category = ?
         ORDER BY count DESC, datetime(last_seen_at) DESC LIMIT ?`
      : `SELECT topic_key AS normalized_topic, category, count, last_seen_at
         FROM anonymous_claim_stats_v2
         ORDER BY count DESC, datetime(last_seen_at) DESC LIMIT ?`;
    const rows = category ? this.db.prepare(sql).all(category, limit) : this.db.prepare(sql).all(limit);
    return rows as unknown as PopularClaim[];
  }

  close(): void {
    this.db.close();
  }

  private hydrate(row: CacheRow, now: Date): ClaimAnswer {
    this.db
      .prepare(
        `UPDATE claim_cache_v2
         SET hit_count = hit_count + 1,
             status = CASE WHEN hit_count + 1 >= 2 THEN 'promoted' ELSE status END,
             updated_at = ?
         WHERE claim_id = ?`
      )
      .run(now.toISOString(), row.claim_id);
    const answer = JSON.parse(row.answer_json) as ClaimAnswer;
    return { ...answer, claim_id: row.claim_id, cached: true };
  }

  private migrate(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS claim_cache;
      DROP TABLE IF EXISTS anonymous_claim_stats;

      CREATE TABLE IF NOT EXISTS claim_cache_v2 (
        claim_id TEXT PRIMARY KEY,
        signature_text TEXT NOT NULL,
        signature_tokens_json TEXT NOT NULL,
        category TEXT NOT NULL,
        direction TEXT NOT NULL,
        numeric_signature TEXT NOT NULL,
        query_terms_json TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        format_version TEXT NOT NULL DEFAULT 'legacy',
        hit_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'temporary',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim_aliases_v2 (
        question_hash TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(claim_id) REFERENCES claim_cache_v2(claim_id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS claim_cache_fts_v2 USING fts5(
        claim_id UNINDEXED,
        signature_text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS search_plan_cache_v1 (
        question_hash TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        format_version TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS host_evidence_cache_v1 (
        cache_key TEXT PRIMARY KEY,
        evidence_json TEXT NOT NULL,
        format_version TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS host_evidence_cache_v1_expires
        ON host_evidence_cache_v1 (expires_at);

      CREATE TABLE IF NOT EXISTS anonymous_claim_stats_v2 (
        topic_key TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(topic_key, category)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(claim_cache_v2)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "format_version")) {
      this.db.exec("ALTER TABLE claim_cache_v2 ADD COLUMN format_version TEXT NOT NULL DEFAULT 'legacy'");
    }
  }
}

/** Only a hash of the question is stored, never the question itself. */
function searchPlanHash(normalizedQuestion: string, category: string): string {
  return createHash("sha256").update(`${category}|${normalizedQuestion}`).digest("hex");
}

function questionHash(normalizedQuestion: string): string {
  return createHash("sha256").update(normalizedQuestion).digest("hex");
}

const searchQueryStopwords = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "with", "vs", "versus",
  // Study-design and filler words are boilerplate the host sprinkles
  // inconsistently: "processed meat health outcomes systematic review" and
  // "health outcomes of processed meats systematic reviews" retrieve the same
  // literature, and keeping these words made the second one miss the cache.
  // Words that change which literature is wanted -- an outcome, a population
  // restriction, safety versus efficacy -- are deliberately not listed here.
  "study", "studies", "systematic", "review", "reviews", "meta", "metaanalysis",
  "analysis", "analyses", "randomized", "randomised", "controlled", "trial", "trials",
  "cohort", "prospective", "retrospective", "observational", "umbrella", "evidence",
  "research", "effect", "effects", "outcome", "outcomes", "health", "consumption",
  "intake", "comparison", "comparative"
]);

/**
 * The host rewrites the same question differently on every call: "energy drink
 * blood pressure systematic review" one time, "blood pressure of energy drinks
 * meta analysis" the next. Keying on the raw string would make the cache miss
 * almost always. Reduce each query to a sorted, singularised token bag so
 * queries that retrieve the same literature share one entry.
 */
export function hostEvidenceCacheKey(category: string, searchQueries: string[]): string {
  // Keep persistent Railway volume entries from an older retrieval algorithm
  // from surviving a deploy. Bump this token whenever the source query or
  // selection contract changes in a way that makes old evidence stale.
  const normalized = ["host retrieval v3", ...searchQueries]
    .map((query) => (query.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
      .filter((token) => token.length > 1 && !searchQueryStopwords.has(token))
      .map(singularise)
      .sort()
      .join(" "))
    .filter(Boolean)
    .sort();
  return createHash("sha256").update(`${category} ${[...new Set(normalized)].join("")}`).digest("hex");
}

function singularise(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function numericSignaturesMatch(cached: string, requested: string): boolean {
  if (!cached && !requested) return true;
  return cached === requested;
}

function isCompatibleSignature(row: CacheRow, signature: ClaimSignature): boolean {
  const tokens = JSON.parse(row.signature_tokens_json) as string[];
  return (
    row.category === signature.category &&
    row.direction === signature.direction &&
    numericSignaturesMatch(row.numeric_signature, signature.numericSignature) &&
    signatureSimilarity(signature, tokens) >= 0.75
  );
}
