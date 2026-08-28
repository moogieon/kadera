import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimCache, hostEvidenceCacheKey } from "./cache.js";
import { buildClaimSignature } from "./claimSignature.js";
import { buildQueryTerms, normalizeQuestion } from "./text.js";
import type { ClaimAnswer, EvidenceSearchResult, Paper } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("privacy-preserving claim cache", () => {
  it("normalizes Korean counter words and keeps different doses separate", () => {
    const three = signatureFor("하루에 커피 세 잔 마시면 혈압에 안 좋아?");
    const ten = signatureFor("하루에 커피 열 잔 마시면 혈압에 안 좋아?");

    expect(three.numericSignature).toBe("3잔");
    expect(ten.numericSignature).toBe("10잔");
    expect(three.direction).toBe("harm");
  });

  it("separates prevention benefits from disease-risk increases", () => {
    expect(signatureFor("오메가3가 심혈관질환 예방에 효과 있어?").direction).toBe("benefit");
    expect(signatureFor("오메가3가 심혈관질환 위험을 높여?").direction).toBe("harm");
  });

  it("reuses only the exact question, never a close paraphrase", () => {
    const { cache } = newCache();
    const question = "하루에 커피 세 잔 마시면 혈압에 안 좋아?";
    const stored = cache.save(normalizeQuestion(question), signatureFor(question), sampleAnswer());

    const paraphrase = "커피 세 잔을 매일 마시는 건 혈압에 나쁜가?";
    const differentDose = "커피 열 잔을 매일 마시는 건 혈압에 나쁜가?";
    const exact = cache.get(normalizeQuestion(question), signatureFor(question));
    const reused = cache.get(normalizeQuestion(paraphrase), signatureFor(paraphrase));
    const rejected = cache.get(normalizeQuestion(differentDose), signatureFor(differentDose));
    const mismatchedId = cache.getByClaimId(stored.claim_id!, signatureFor(differentDose));

    expect(exact?.claim_id).toBe(stored.claim_id);
    expect(exact?.cached).toBe(true);
    expect(reused).toBeUndefined();
    expect(rejected).toBeUndefined();
    expect(mismatchedId).toBeUndefined();
    cache.close();
  });

  it("stores a hash and semantic signature without the raw question", () => {
    const { cache, path } = newCache();
    const question = "하루에 커피 세 잔 마시면 혈압에 안 좋아?";
    cache.save(normalizeQuestion(question), signatureFor(question), sampleAnswer());
    cache.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const cacheRows = db.prepare("SELECT signature_text, query_terms_json, answer_json FROM claim_cache_v2").all();
    const aliasRows = db.prepare("SELECT question_hash FROM claim_aliases_v2").all() as Array<{ question_hash: string }>;
    const serialized = JSON.stringify({ cacheRows, aliasRows });
    db.close();

    expect(serialized).not.toContain(question);
    expect(aliasRows[0]?.question_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("host evidence retrieval cache", () => {
  function retrieval(overrides: Partial<EvidenceSearchResult> = {}): EvidenceSearchResult {
    return {
      category: "nutrition",
      queryTerms: ["tirzepatide semaglutide"],
      retrievedPaperCount: 40,
      sourceErrors: [],
      sourceTraces: [
        { source: "pubmed", status: "fulfilled", paperCount: 15, message: "" },
        { source: "europe_pmc", status: "fulfilled", paperCount: 15, message: "" }
      ],
      papers: [],
      ...overrides
    };
  }

  // The host rephrases the same question on every call. Keying on the raw
  // string made the cache miss almost always, which put the average tool
  // latency at the cost of a live four-database search.
  it("collapses word order, plurals and filler words onto one key", () => {
    const key = hostEvidenceCacheKey("nutrition", ["tirzepatide versus semaglutide obesity systematic review"]);
    expect(hostEvidenceCacheKey("nutrition", ["systematic reviews of obesity: semaglutide vs tirzepatide"])).toBe(key);
    expect(hostEvidenceCacheKey("nutrition", ["semaglutide obesity systematic review"])).not.toBe(key);
    expect(hostEvidenceCacheKey("health", ["tirzepatide versus semaglutide obesity systematic review"])).not.toBe(key);
  });

  it("marks a served retrieval as a cache hit", () => {
    const { cache } = newCache();
    const key = hostEvidenceCacheKey("nutrition", ["a"]);
    expect(cache.getHostEvidence(key)).toBeUndefined();
    cache.saveHostEvidence(key, retrieval(), 60_000);
    expect(cache.getHostEvidence(key)?.evidenceCacheHit).toBe(true);
    cache.close();
  });

  it("does not freeze one caller's labels into a shared retrieval", () => {
    const { cache } = newCache();
    const key = hostEvidenceCacheKey("nutrition", ["b"]);
    cache.saveHostEvidence(key, retrieval({
      hostTopicTerms: ["tirzepatide"],
      hostParentTerms: ["GLP-1 receptor agonist"],
      hostOutcomeTerms: ["body weight"]
    }), 60_000);

    const served = cache.getHostEvidence(key);
    expect(served?.hostTopicTerms).toBeUndefined();
    expect(served?.hostParentTerms).toBeUndefined();
    expect(served?.hostOutcomeTerms).toBeUndefined();
    cache.close();
  });

  it("stops serving a retrieval once its TTL has passed", () => {
    const { cache } = newCache();
    const key = hostEvidenceCacheKey("nutrition", ["c"]);
    const storedAt = new Date("2026-08-21T00:00:00Z");
    cache.saveHostEvidence(key, retrieval(), 60_000, storedAt);

    expect(cache.getHostEvidence(key, new Date("2026-08-21T00:00:30Z"))).toBeDefined();
    expect(cache.getHostEvidence(key, new Date("2026-08-21T00:02:00Z"))).toBeUndefined();
    cache.close();
  });
});

describe("paper references", () => {
  it("stores a stable short key and resolves bracketed or uppercase input", () => {
    const { cache } = newCache();
    const paper = samplePaper({
      sourceId: "38956175",
      doi: "10.1016/j.clnu.2024.05.001",
      title: "Intermittent fasting in adults with diabetes",
      raw: { providerOnly: "not needed after retrieval" }
    });

    const first = cache.savePaperReferences([paper]);
    const second = cache.savePaperReferences([paper]);
    const paperId = first[0]?.paperId;

    expect(paperId).toMatch(/^\d{4}-[a-z]$/);
    expect(second[0]?.paperId).toBe(paperId);
    expect(cache.getPaperReference(`[${paperId?.toUpperCase()}]`)?.paper.title).toBe(paper.title);
    expect(cache.getPaperReference(paperId!)?.paper.abstract).toBe(paper.abstract);
    expect(cache.getPaperReference(paperId!)?.paper.raw).toBeNull();
    cache.close();
  });

  it("assigns distinct stable keys to distinct papers", () => {
    const { cache } = newCache();
    const papers = [
      samplePaper({ sourceId: "one", title: "First paper" }),
      samplePaper({ sourceId: "two", title: "Second paper" })
    ];
    const references = cache.savePaperReferences(papers);
    const repeated = cache.savePaperReferences([papers[1]!, papers[0]!]);

    expect(references).toHaveLength(2);
    expect(references[0]?.paperId).not.toBe(references[1]?.paperId);
    expect(repeated[0]?.paperId).toBe(references[1]?.paperId);
    expect(repeated[1]?.paperId).toBe(references[0]?.paperId);
    cache.close();
  });

  it("rejects malformed or invented keys", () => {
    const { cache } = newCache();
    const known = cache.savePaperReferences([samplePaper({ sourceId: "known" })]);
    const knownId = known[0]!.paperId;
    const unusedSuffix = `${knownId.slice(0, -1)}${knownId.endsWith("z") ? "a" : "z"}`;

    expect(cache.getPaperReference("1번 논문")).toBeUndefined();
    expect(cache.getPaperReference("12345-a")).toBeUndefined();
    expect(cache.getPaperReference(unusedSuffix)).toBeUndefined();
    cache.close();
  });
});

function newCache(): { cache: ClaimCache; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kadera-cache-test-"));
  tempDirs.push(dir);
  const path = join(dir, "cache.sqlite");
  return { cache: new ClaimCache(path), path };
}

function signatureFor(question: string) {
  const terms = buildQueryTerms(question, "health");
  return buildClaimSignature(question, "health", terms);
}

function sampleAnswer(): ClaimAnswer {
  return {
    answer_ko: "규칙적인 중등도 커피 섭취가 장기 고혈압 위험을 높인다고 단정하기 어렵습니다.",
    summary_ko: "규칙적인 중등도 커피 섭취가 장기 고혈압 위험을 높인다고 단정하기 어렵습니다.",
    evidence_basis_ko: "체계적 문헌고찰을 중심으로 종합했습니다.",
    evidence_status: "verified",
    verdict: "not_supported",
    evidence_level: "systematic_review",
    citations: [],
    limitations: [],
    safety_note: "일반 정보입니다.",
    cached: false,
    category: "health",
    query_terms: ["coffee blood pressure", "coffee hypertension"]
  };
}

function samplePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    source: "pubmed",
    sourceId: "paper-1",
    title: "A systematic review of intermittent fasting",
    authors: ["Kim A", "Lee B"],
    year: 2025,
    url: "https://pubmed.ncbi.nlm.nih.gov/38956175/",
    evidenceLevel: "systematic_review",
    publicationTypes: ["Systematic Review", "Meta-Analysis"],
    abstract: "RESULTS: Intermittent fasting reduced body weight by 1.14 kg compared with control.",
    raw: {},
    ...overrides
  };
}

describe("host evidence cache key stability", () => {
  const key = (query: string) => hostEvidenceCacheKey("nutrition", [query]);

  // Measured live: the host asked the same question twice and phrased it as
  // "...consumption health outcomes systematic review" then "health outcomes
  // of processed meats systematic reviews", missing the cache and paying a
  // second 2.4s search.
  it("ignores study-design boilerplate the host adds inconsistently", () => {
    expect(key("health outcomes of processed meats systematic reviews"))
      .toBe(key("processed meat consumption health outcomes systematic review"));
  });

  it("still separates questions that want different literature", () => {
    expect(key("processed meat colorectal cancer")).not.toBe(key("processed meat cardiovascular disease"));
    expect(key("semaglutide efficacy")).not.toBe(key("semaglutide safety"));
    expect(key("creatine hair loss")).not.toBe(key("creatine kidney function"));
  });

  it("invalidates cache entries written by the previous retrieval algorithm", () => {
    expect(key("carbonated beverages digestion gastric emptying dyspepsia reflux systematic review"))
      .not.toBe("5717923831c3740329c7a99f58b0a3ea2cd95aec0b7ab67ab2fa52740f49fdac");
    expect(key("carbonated beverages digestion gastric emptying dyspepsia reflux systematic review"))
      .not.toBe("30d65a072b023469138bde826ab03f608ce6c798fc96585eb268e35759d1d0a8");
  });
});
