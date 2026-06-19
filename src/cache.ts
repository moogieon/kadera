import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClaimAnswer, PopularClaim } from "./types.js";

export class ClaimCache {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  get(normalizedQuestion: string, now = new Date()): ClaimAnswer | undefined {
    const row = this.db
      .prepare(
        `SELECT answer_json
         FROM claim_cache
         WHERE normalized_question = ? AND datetime(expires_at) > datetime(?)
         LIMIT 1`
      )
      .get(normalizedQuestion, now.toISOString()) as { answer_json: string } | undefined;

    if (!row) return undefined;
    this.increment(normalizedQuestion, now);
    const answer = JSON.parse(row.answer_json) as ClaimAnswer;
    return { ...answer, cached: true };
  }

  save(normalizedQuestion: string, answer: ClaimAnswer, now = new Date()): void {
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const existing = this.db
      .prepare("SELECT hit_count FROM claim_cache WHERE normalized_question = ? LIMIT 1")
      .get(normalizedQuestion) as { hit_count: number } | undefined;

    const hitCount = existing ? existing.hit_count + 1 : 1;
    const status = hitCount >= 2 ? "promoted" : "temporary";
    this.db
      .prepare(
        `INSERT INTO claim_cache
          (normalized_question, category, query_terms_json, answer_json, hit_count, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(normalized_question) DO UPDATE SET
          category = excluded.category,
          query_terms_json = excluded.query_terms_json,
          answer_json = excluded.answer_json,
          hit_count = excluded.hit_count,
          status = excluded.status,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`
      )
      .run(
        normalizedQuestion,
        answer.category,
        JSON.stringify(answer.query_terms),
        JSON.stringify({ ...answer, cached: false }),
        hitCount,
        status,
        now.toISOString(),
        now.toISOString(),
        expiresAt
      );

    this.db
      .prepare(
        `INSERT INTO anonymous_claim_stats (normalized_topic, category, count, first_seen_at, last_seen_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(normalized_topic, category) DO UPDATE SET
          count = count + 1,
          last_seen_at = excluded.last_seen_at`
      )
      .run(normalizedQuestion, answer.category, now.toISOString(), now.toISOString());
  }

  popular(category: string | undefined, limit: number): PopularClaim[] {
    const sql = category
      ? `SELECT normalized_topic, category, count, last_seen_at
         FROM anonymous_claim_stats
         WHERE category = ?
         ORDER BY count DESC, datetime(last_seen_at) DESC
         LIMIT ?`
      : `SELECT normalized_topic, category, count, last_seen_at
         FROM anonymous_claim_stats
         ORDER BY count DESC, datetime(last_seen_at) DESC
         LIMIT ?`;
    const rows = category
      ? this.db.prepare(sql).all(category, limit)
      : this.db.prepare(sql).all(limit);
    return rows as unknown as PopularClaim[];
  }

  close(): void {
    this.db.close();
  }

  private increment(normalizedQuestion: string, now: Date): void {
    this.db
      .prepare(
        `UPDATE claim_cache
         SET hit_count = hit_count + 1,
             status = CASE WHEN hit_count + 1 >= 2 THEN 'promoted' ELSE status END,
             updated_at = ?
         WHERE normalized_question = ?`
      )
      .run(now.toISOString(), normalizedQuestion);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claim_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_question TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        query_terms_json TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'temporary',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS anonymous_claim_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_topic TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(normalized_topic, category)
      );
    `);
  }
}
