import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GeminiRagClient } from "./clients/gemini.js";
import { SemanticScholarClient } from "./clients/semanticScholar.js";
import { rankPapers } from "./evidence.js";
import { ClaimCheckerService } from "./service.js";
import type { ClaimAnswer, EvidenceSearchResult } from "./types.js";
import { buildLooseSearchQuery, buildQueryTerms, buildSearchQuery, classifyCategory } from "./text.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("text pipeline", () => {
  it("classifies Korean questions into MVP categories", () => {
    expect(classifyCategory("우리 애가 고기를 안 먹는데 괜찮아?", "auto")).toBe("childcare");
    expect(classifyCategory("공복 유산소가 살 더 빠져?", "auto")).toBe("exercise");
    expect(classifyCategory("간헐적 단식 효과 있어?", "auto")).toBe("nutrition");
    expect(classifyCategory("단백질 파우더 하루에 100g 이상 먹는 거 많아?", "auto")).toBe("nutrition");
    expect(classifyCategory("제로 탄산이 설탕 탄산보다 몸에 더 안 좋아?", "auto")).toBe("nutrition");
  });

  it("builds English research query terms", () => {
    expect(buildQueryTerms("공복 유산소가 살 더 빠져?", "exercise")).toEqual(
      expect.arrayContaining(["fasted exercise", "fasted cardio", "aerobic exercise", "weight loss"])
    );
    expect(buildQueryTerms("단백질 파우더 하루에 100g 이상 먹으면 근성장과 신장에 어때?", "nutrition")).toEqual(
      expect.arrayContaining([
        "protein supplementation resistance training meta-analysis",
        "dietary protein muscle mass meta-analysis",
        "protein intake renal function healthy adults"
      ])
    );
    expect(buildQueryTerms("단백질 파우더가 탈모에 안 좋고 신장에도 안 좋아?", "nutrition")).toEqual(
      expect.arrayContaining(["protein intake renal function healthy adults", "protein supplement hair loss"])
    );
    expect(buildQueryTerms("제로 탄산이 설탕 탄산보다 더 나쁘고 감미료가 혈당에 안 좋아?", "nutrition")).toEqual(
      expect.arrayContaining([
        "non-sugar sweeteners",
        "sugar-sweetened beverages",
        "aspartame",
        "sucralose",
        "gut microbiome",
        "glucose metabolism"
      ])
    );
  });

  it("builds focused conjunctive queries for multi-concept claims", () => {
    const proteinTerms = buildQueryTerms("단백질 파우더 하루에 100g 이상 먹으면 근성장과 신장에 어때?", "nutrition");
    const proteinQuery = buildSearchQuery(proteinTerms, "nutrition");

    expect(proteinQuery).toContain(" AND ");
    expect(proteinQuery).toContain("kidney");
    expect(proteinQuery).toContain("protein");

    const sweetenerTerms = buildQueryTerms("제로 탄산이 설탕 탄산보다 더 나쁘고 감미료가 혈당에 안 좋아?", "nutrition");
    const sweetenerQuery = buildSearchQuery(sweetenerTerms, "nutrition");

    expect(sweetenerQuery).toContain(" AND ");
    expect(sweetenerQuery).toContain("sweeteners");
    expect(sweetenerQuery).toContain("glucose");

    expect(buildLooseSearchQuery(proteinTerms, "nutrition")).not.toContain(" AND ");
  });

  it("maps infant eye contact concerns to developmental evidence terms", () => {
    expect(classifyCategory("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "auto")).toBe("childcare");
    expect(classifyCategory("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "nutrition")).toBe("childcare");
    expect(buildQueryTerms("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "childcare")).toEqual(
      expect.arrayContaining(["eye contact", "gaze behavior", "social attention", "autism spectrum disorder", "developmental screening", "infant", "toddler"])
    );
  });
});

describe("evidence ranking", () => {
  it("keeps weaker but relevant developmental papers when strong matches are few", () => {
    const papers = [
      testPaper("1", "Early development of social attention in toddlers at high familial risk for autism spectrum disorder"),
      testPaper("2", "Response to name and joint attention in infants"),
      testPaper("3", "Infant neurodevelopmental screening in primary care"),
      testPaper("4", "Language and social communication delay in toddlers"),
      testPaper("5", "Nonhuman primate behavioral development"),
      testPaper("6", "Caregiver mediated intervention for toddlers with early signs of autism")
    ];

    const ranked = rankPapers(papers, [
      "infant eye contact development",
      "social communication delay in toddlers",
      "joint attention development"
    ]);

    expect(ranked.map((paper) => paper.sourceId)).toEqual(expect.arrayContaining(["1", "2", "3", "4", "6"]));
    expect(ranked.map((paper) => paper.sourceId)).not.toContain("5");
  });
});

describe("ClaimCheckerService", () => {
  it("redirects prescription-like questions without external search", async () => {
    const service = newService(async () => {
      throw new Error("fetch should not be called");
    });

    const answer = await service.checkClaim({ question: "아기 감기약 몇 알 먹어도 돼?" });

    expect(answer.verdict).toBe("safety_redirect");
    expect(answer.citations).toEqual([]);
    service.close();
  });

  it("uses only fetched papers as citations and caches repeat questions", async () => {
    let calls = 0;
    const service = newService(async (input) => {
      calls++;
      const url = String(input);
      if (url.includes("esearch.fcgi")) {
        return jsonResponse({ esearchresult: { idlist: ["123"] } });
      }
      if (url.includes("efetch.fcgi")) {
        return textResponse(`
          <PubmedArticleSet>
            <PubmedArticle>
              <MedlineCitation>
                <PMID>123</PMID>
                <Article>
                  <ArticleTitle>Fasted aerobic exercise and body weight: a systematic review</ArticleTitle>
                  <Abstract><AbstractText>Review abstract.</AbstractText></Abstract>
                  <Journal><Title>Journal of Exercise Evidence</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
                  <AuthorList>
                    <Author>
                      <LastName>Kim</LastName>
                      <ForeName>Min</ForeName>
                      <AffiliationInfo><Affiliation>Department of Sports Medicine, Yonsei University, Seoul, Korea.</Affiliation></AffiliationInfo>
                    </Author>
                  </AuthorList>
                  <PublicationTypeList><PublicationType>Systematic Review</PublicationType></PublicationTypeList>
                </Article>
              </MedlineCitation>
              <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/test</ArticleId></ArticleIdList></PubmedData>
            </PubmedArticle>
          </PubmedArticleSet>
        `);
      }
      if (url.includes("semanticscholar.org")) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const first = await service.checkClaim({ question: "공복 유산소가 살 더 빠져?" });
    const second = await service.checkClaim({ question: "공복 유산소가 살 더 빠져?" });

    expect(first.verdict).toBe("insufficient_evidence");
    expect(first.cached).toBe(false);
    expect(first.citations).toHaveLength(1);
    expect(first.evidence_interpretation?.[0]?.stance).toBe("unclear");
    expect(first.citations[0]?.sourceId).toBe("123");
    expect(first.citations[0]?.title).toContain("Fasted aerobic exercise");
    expect(first.answer_ko).toContain("대표 연구를 짧게 보면");
    expect(first.answer_ko).toContain("Journal of Exercise Evidence");
    expect(first.answer_ko).toContain("Yonsei University");
    expect(first.answer_ko).toContain("기관/소속");
    expect(first.answer_ko).toContain("무엇을 했나");
    expect(first.answer_ko).toContain("적용 한계");
    expect(first.practical_checks?.length).toBeGreaterThan(0);
    expect(second.cached).toBe(true);
    expect(calls).toBe(8);
    service.close();
  });

  it("adds concrete g/kg examples for protein amount questions", async () => {
    const service = newService(async (input) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: ["123"] } });
      if (url.includes("efetch.fcgi")) {
        return textResponse(`
          <PubmedArticleSet>
            <PubmedArticle>
              <MedlineCitation>
                <PMID>123</PMID>
                <Article>
                  <ArticleTitle>Whey protein supplementation and resistance training: a systematic review</ArticleTitle>
                  <Abstract><AbstractText>Protein supplementation improved lean mass with resistance training.</AbstractText></Abstract>
                  <Journal><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
                  <PublicationTypeList><PublicationType>Systematic Review</PublicationType></PublicationTypeList>
                </Article>
              </MedlineCitation>
            </PubmedArticle>
          </PubmedArticleSet>
        `);
      }
      if (url.includes("semanticscholar.org")) return jsonResponse({ data: [] });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await service.checkClaim({
      question: "단백질 파우더 하루에 100g 이상 먹는 거 많아?",
      category: "nutrition",
      skipCache: true
    });

    expect(result.answer_ko).toContain("50kg=2.00g/kg/day");
    expect(result.answer_ko).toContain("70kg=1.43g/kg/day");
    expect(result.answer_ko).toContain("55kg 성인 여성");
    expect(result.answer_ko).toContain("75kg 성인 남성");
    expect(result.answer_ko).toContain("약 120g/day");
    expect(result.answer_ko).toContain("대상자별로 보면");
    expect(result.answer_ko).toContain("임신/수유");
    expect(result.answer_ko).toContain("노인");
    expect(result.answer_ko).toContain("대표 연구를 짧게 보면");
    expect(result.answer_ko).not.toContain("더 정확히 보려면");
    service.close();
  });

  it("adds label-level context for zero-sugar drink questions", async () => {
    const service = newService(async (input) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: ["123"] } });
      if (url.includes("efetch.fcgi")) {
        return textResponse(`
          <PubmedArticleSet>
            <PubmedArticle>
              <MedlineCitation>
                <PMID>123</PMID>
                <Article>
                  <ArticleTitle>Non-sugar sweeteners and metabolic health: a systematic review</ArticleTitle>
                  <Abstract><AbstractText>Non-sugar sweeteners were associated with mixed metabolic outcomes.</AbstractText></Abstract>
                  <Journal><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal>
                  <PublicationTypeList><PublicationType>Systematic Review</PublicationType></PublicationTypeList>
                </Article>
              </MedlineCitation>
            </PubmedArticle>
          </PubmedArticleSet>
        `);
      }
      if (url.includes("semanticscholar.org")) return jsonResponse({ data: [] });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await service.checkClaim({
      question: "제로 탄산이 설탕 탄산보다 더 안 좋고 감미료가 위험해?",
      category: "auto",
      skipCache: true
    });

    expect(result.answer_ko).toContain("감미료별로 보면");
    expect(result.answer_ko).toContain("아스파탐");
    expect(result.answer_ko).toContain("수크랄로스");
    expect(result.answer_ko).toContain("원재료명");
    expect(result.answer_ko).toContain("대상자별로 보면");
    expect(result.answer_ko).toContain("소아/청소년");
    expect(result.answer_ko).toContain("대표 연구를 짧게 보면");
    expect(result.answer_ko).not.toContain("더 정확히 보려면");
    expect(result.practical_checks?.map((item) => item.label)).toContain("원재료명에서 감미료 찾기");
    service.close();
  });
});

describe("GeminiRagClient", () => {
  it("merges AI synthesis without allowing invented citations", async () => {
    const client = new GeminiRagClient(
      loadConfig({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3.1-flash-lite" }),
      async () =>
        jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      answer_ko: "검색된 근거만 보면 효과가 있다는 방향이 더 강합니다[1]. 없는 출처는 제거됩니다[99].",
                      verdict: "supported",
                      limitations: ["개별 건강 상태에는 바로 적용할 수 없습니다."],
                      evidence_interpretation: [
                        { citationIndex: 1, stance: "supports", reason_ko: "초록에서 체중 감소 효과를 보고했습니다." },
                        { citationIndex: 99, stance: "supports", reason_ko: "이 인용은 없어야 합니다." }
                      ],
                      practical_checks: [
                        {
                          label: "짧은 체크",
                          what_to_try_ko: "기록합니다.",
                          what_to_watch_ko: "변화를 봅니다.",
                          why_it_matters_ko: "근거 적용 조건 확인이 필요합니다.",
                          urgency: "routine_observation"
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
    );

    const answer = await client.synthesizeClaim("공복 유산소가 살 더 빠져?", sampleEvidence(), sampleFallback());

    expect(answer.answer_ko).toContain("효과가 있다는 방향");
    expect(answer.answer_ko).toContain("[1]");
    expect(answer.answer_ko).not.toContain("[99]");
    expect(answer.verdict).toBe("supported");
    expect(answer.citations).toHaveLength(1);
    expect(answer.evidence_interpretation).toHaveLength(1);
    expect(answer.evidence_interpretation?.[0]?.citationIndex).toBe(1);
    expect(answer.practical_checks).toHaveLength(2);
  });
});

describe("SemanticScholarClient", () => {
  it("collects recent Semantic Scholar papers across years when an API key is configured", async () => {
    const requestedYears: string[] = [];
    const currentYear = new Date().getFullYear();
    const client = new SemanticScholarClient(
      loadConfig({ SEMANTIC_SCHOLAR_API_KEY: "test-key" }),
      async (input) => {
        const url = new URL(String(input));
        requestedYears.push(url.searchParams.get("year") ?? "none");
        const year = url.searchParams.get("year");
        if (year === String(currentYear)) {
          return jsonResponse({ data: [] });
        }
        if (year !== String(currentYear - 1)) {
          return jsonResponse({ data: [] });
        }
        return jsonResponse({
          data: [
            {
              paperId: "s2-1",
              title: "Recent child development paper",
              year: currentYear - 1,
              authors: [{ name: "A Researcher" }],
              url: "https://www.semanticscholar.org/paper/s2-1",
              publicationTypes: ["JournalArticle"]
            }
          ]
        });
      }
    );

    const papers = await client.search("infant eye contact", 3, "childcare");

    expect(requestedYears.slice(0, 2)).toEqual([String(currentYear), String(currentYear - 1)]);
    expect(requestedYears).toContain(String(currentYear - 2));
    expect(papers).toHaveLength(1);
    expect(papers[0]?.title).toContain("Recent child development");
  });
});

function newService(fetchFn: typeof fetch): ClaimCheckerService {
  const dir = mkdtempSync(join(tmpdir(), "kadera-malgo-test-"));
  tempDirs.push(dir);
  return new ClaimCheckerService(
    loadConfig({
      DATABASE_PATH: join(dir, "test.sqlite")
    }),
    fetchFn
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" }
  });
}

function sampleEvidence(): EvidenceSearchResult {
  return {
    category: "exercise",
    queryTerms: ["fasted exercise", "weight loss"],
    sourceErrors: [],
    sourceTraces: [],
    papers: [
      {
        source: "pubmed",
        sourceId: "123",
        title: "Fasted aerobic exercise and weight loss",
        authors: ["A Researcher"],
        year: 2024,
        doi: "10.1000/test",
        url: "https://pubmed.ncbi.nlm.nih.gov/123/",
        abstract: "The intervention was associated with reduced body weight in adults.",
        publicationTypes: ["Clinical Trial"],
        evidenceLevel: "clinical_study",
        raw: {}
      }
    ]
  };
}

function sampleFallback(): ClaimAnswer {
  return {
    answer_ko: "fallback",
    verdict: "mixed",
    evidence_level: "clinical_study",
    citations: [
      {
        source: "pubmed",
        sourceId: "123",
        title: "Fasted aerobic exercise and weight loss",
        authors: ["A Researcher"],
        year: 2024,
        doi: "10.1000/test",
        url: "https://pubmed.ncbi.nlm.nih.gov/123/",
        evidenceLevel: "clinical_study"
      }
    ],
    practical_checks: [
      {
        label: "목표 확인",
        what_to_try_ko: "목표를 적습니다.",
        what_to_watch_ko: "변화를 봅니다.",
        why_it_matters_ko: "운동 연구는 목표에 따라 다릅니다.",
        urgency: "routine_observation"
      },
      {
        label: "강도 기록",
        what_to_try_ko: "강도를 적습니다.",
        what_to_watch_ko: "통증을 봅니다.",
        why_it_matters_ko: "용량이 중요합니다.",
        urgency: "routine_observation"
      }
    ],
    limitations: ["fallback limitation"],
    safety_note: "safety",
    cached: false,
    category: "exercise",
    query_terms: ["fasted exercise", "weight loss"]
  };
}

function testPaper(sourceId: string, title: string) {
  return {
    source: "openalex" as const,
    sourceId,
    title,
    authors: [],
    year: 2024,
    url: `https://example.com/${sourceId}`,
    publicationTypes: [],
    evidenceLevel: "unknown" as const,
    raw: {}
  };
}
