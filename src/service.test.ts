import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GeminiRagClient } from "./clients/gemini.js";
import { KciClient } from "./clients/kci.js";
import { SemanticScholarClient } from "./clients/semanticScholar.js";
import { rankPapers } from "./evidence.js";
import { ClaimCheckerService } from "./service.js";
import type { ClaimAnswer, EvidenceSearchResult } from "./types.js";
import {
  buildFocusedSearchQueries,
  buildKoreanSearchQueries,
  buildLooseSearchQueries,
  buildLooseSearchQuery,
  buildQueryTerms,
  buildSearchQuery,
  classifyCategory
} from "./text.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("text pipeline", () => {
  it("uses public-safe defaults for cost and diagnostic exposure", () => {
    const config = loadConfig({});

    expect(config.geminiModel).toBe("gemini-2.5-flash-lite");
    expect(config.maxQuestionLength).toBe(350);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.rateLimitMaxRequests).toBe(8);
    expect(config.exposeDiagnosticApis).toBe(false);
    expect(config.exposeDiagnosticTools).toBe(false);
  });

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

  it("expands obesity food questions into multiple evidence search axes", () => {
    const question = "비만에 안 좋은 음식이 뭐가 있어?";
    const terms = buildQueryTerms(question, "health");

    expect(terms).toEqual(
      expect.arrayContaining(["ultra-processed foods obesity", "sugar-sweetened beverages obesity", "fast food obesity"])
    );
    expect(buildFocusedSearchQueries(question, terms, "health")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ultra-processed foods"),
        expect.stringContaining("sugar-sweetened beverages")
      ])
    );
    expect(buildLooseSearchQueries(question, terms, "health")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ultra-processed foods"),
        expect.stringContaining("fast food")
      ])
    );
    expect(buildKoreanSearchQueries(question, "health")).toEqual(
      expect.arrayContaining(["비만 식습관", "가공식품", "당류 음료", "패스트푸드"])
    );
  });

  it("keeps creatine supplement questions on creatine-specific evidence", () => {
    const question = "크레아틴 보충제가 신장이나 탈모에 안 좋아?";
    const terms = buildQueryTerms(question, "nutrition");

    expect(terms).toEqual(
      expect.arrayContaining(["creatine supplementation", "creatine renal function", "creatine hair loss"])
    );
    expect(buildFocusedSearchQueries(question, terms, "nutrition")).toEqual(
      expect.arrayContaining([expect.stringContaining("creatine monohydrate"), expect.stringContaining("hair loss")])
    );
    expect(buildKoreanSearchQueries(question, "nutrition")).toEqual(expect.arrayContaining(["크레아틴", "크레아틴 보충제"]));
  });

  it("builds direct queries for common off-axis health questions", () => {
    expect(buildQueryTerms("간헐적 단식은 체중 감량에 실제로 효과 있어?", "nutrition")).toEqual(
      expect.arrayContaining(["intermittent fasting weight loss", "time-restricted eating weight loss"])
    );
    expect(buildFocusedSearchQueries("비타민 D를 먹으면 감기 예방에 도움이 돼?", buildQueryTerms("비타민 D를 먹으면 감기 예방에 도움이 돼?", "health"), "health")).toEqual(
      expect.arrayContaining([expect.stringContaining("vitamin D")])
    );
    expect(buildQueryTerms("커피를 많이 마시면 혈압이 올라가?", "health")).toEqual(
      expect.arrayContaining(["coffee blood pressure", "coffee hypertension"])
    );
  });

  it("maps infant eye contact concerns to developmental evidence terms", () => {
    expect(classifyCategory("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "auto")).toBe("childcare");
    expect(classifyCategory("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "nutrition")).toBe("childcare");
    expect(buildQueryTerms("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "childcare")).toEqual(
      expect.arrayContaining(["eye contact", "gaze behavior", "social attention", "autism spectrum disorder", "developmental screening", "infant", "toddler"])
    );
    expect(buildKoreanSearchQueries("12개월 아이가 눈 마주침이 잘 안되는데 문제가 있을까?", "childcare")).toEqual(
      expect.arrayContaining(["눈맞춤", "공동주의", "영유아 발달", "발달선별검사"])
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

  it("ranks Korean KCI papers using Korean query tokens", () => {
    const papers = [
      testPaper("1", "Unrelated adult nutrition review"),
      {
        ...testPaper("kci-1", "한국형 영유아 발달선별검사 부모용 도구 개발을 위한 예비연구"),
        source: "kci" as const,
        publicationTypes: ["KCI", "articleSearch"]
      },
      {
        ...testPaper("kci-2", "눈맞춤과 공동주의를 활용한 영유아 사회성 발달 연구"),
        source: "kci" as const,
        publicationTypes: ["KCI", "articleSearch"]
      }
    ];

    const ranked = rankPapers(papers, ["eye contact", "joint attention", "눈맞춤", "공동주의", "발달선별검사"]);

    expect(ranked.map((paper) => paper.sourceId)).toEqual(expect.arrayContaining(["kci-1", "kci-2"]));
  });

  it("uses topic anchors to prevent adjacent-topic papers from outranking direct matches", () => {
    const papers = [
      testPaper("vitamin-c", "The Long History of Vitamin C: From Prevention of the Common Cold to Treatment"),
      testPaper("vitamin-d-1", "Vitamin D supplementation to prevent acute respiratory tract infections: systematic review and meta-analysis"),
      testPaper("vitamin-d-2", "Cholecalciferol and respiratory infection risk in adults"),
      testPaper("vitamin-d-3", "Vitamin D and the common cold: randomized trial")
    ];

    const ranked = rankPapers(papers, ["vitamin D", "vitamin D common cold", "cholecalciferol respiratory infection"]);

    expect(ranked.map((paper) => paper.sourceId).slice(0, 3)).toEqual(
      expect.arrayContaining(["vitamin-d-1", "vitamin-d-2", "vitamin-d-3"])
    );
    expect(ranked.map((paper) => paper.sourceId)).not.toContain("vitamin-c");
  });

  it("requires both sides of a multi-concept intent when ranking", () => {
    const sleepRanked = rankPapers(
      [
        testPaper("sugar", "Sugar-sweetened beverages as risk factor of central obesity"),
        testPaper("gaming", "Sleep deprivation and problematic gaming among college students"),
        testPaper("sleep-weight-1", "Sleep Deprivation: Effects on Weight Loss and Weight Loss Maintenance"),
        testPaper("sleep-weight-2", "Short sleep duration and obesity risk in adults")
      ],
      ["short sleep duration obesity", "sleep deprivation weight gain", "sleep duration body weight"]
    );

    expect(sleepRanked.map((paper) => paper.sourceId).slice(0, 2)).toEqual(
      expect.arrayContaining(["sleep-weight-1", "sleep-weight-2"])
    );
    expect(sleepRanked.map((paper) => paper.sourceId)).not.toContain("sugar");
    expect(sleepRanked.map((paper) => paper.sourceId)).not.toContain("gaming");

    const coffeeRanked = rankPapers(
      [
        testPaper("energy", "The Effects of Energy Drinks on the Cardiovascular System: A Systematic Review"),
        testPaper("coffee-1", "Coffee consumption and blood pressure: systematic review"),
        testPaper("coffee-2", "Coffee intake and hypertension risk in adults")
      ],
      ["coffee blood pressure", "coffee hypertension", "caffeine blood pressure"]
    );

    expect(coffeeRanked.map((paper) => paper.sourceId)).toEqual(expect.arrayContaining(["coffee-1", "coffee-2"]));
    expect(coffeeRanked.map((paper) => paper.sourceId)).not.toContain("energy");
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

  it("redirects account action requests without external search", async () => {
    const service = newService(async () => {
      throw new Error("fetch should not be called");
    });

    const answer = await service.checkClaim({ question: "내 인스타 비밀번호 바꿔줘" });

    expect(answer.verdict).toBe("safety_redirect");
    expect(answer.citations).toEqual([]);
    expect(answer.answer_ko).toContain("카더라 말고 안전 기준");
    expect(answer.answer_ko).toContain("공식 앱이나 웹사이트");
    service.close();
  });

  it("rejects non-empirical fantasy subjects without attaching unrelated papers", async () => {
    const service = newService(async () => {
      throw new Error("fetch should not be called");
    });

    const answer = await service.checkClaim({ question: "외계인 발가락이 키 성장에 좋아?" });

    expect(answer.verdict).toBe("insufficient_evidence");
    expect(answer.citations).toEqual([]);
    expect(answer.query_terms).toEqual([]);
    expect(answer.answer_ko).toContain("석박사들도 모른다고카드라");
    expect(answer.answer_ko).toContain("연구로 검증 가능한 대상");
    service.close();
  });

  it("does not expose local runtime paths or popular user questions by default", () => {
    const service = newService(async () => jsonResponse({}));

    const status = service.runtimeStatus();

    expect(JSON.stringify(status)).not.toContain("DATABASE_PATH");
    expect(JSON.stringify(status)).not.toContain("test.sqlite");
    expect(status).toMatchObject({
      cache: { enabled: true },
      security: {
        allowSkipCache: false,
        exposePopularClaims: false,
        exposeDiagnosticApis: false,
        exposeDiagnosticTools: false,
        maxQuestionLength: 350,
        rateLimitMaxRequests: 8
      }
    });
    expect(service.popularClaims(undefined, 10)).toEqual([]);
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
    const callsAfterFirst = calls;
    const second = await service.checkClaim({ question: "공복 유산소가 살 더 빠져?" });

    expect(first.verdict).toBe("insufficient_evidence");
    expect(first.cached).toBe(false);
    expect(first.citations).toHaveLength(1);
    expect(first.evidence_interpretation?.[0]?.stance).toBe("unclear");
    expect(first.citations[0]?.sourceId).toBe("123");
    expect(first.citations[0]?.title).toContain("Fasted aerobic exercise");
    expect(first.answer_ko).toContain("카더라 말고 근거로 보면");
    expect(first.answer_ko).toContain("대표 연구를 짧게 보면");
    expect(first.answer_ko).toContain("Journal of Exercise Evidence");
    expect(first.answer_ko).toContain("Yonsei University");
    expect(first.answer_ko).toContain("기관/소속");
    expect(first.answer_ko).toContain("무엇을 했나");
    expect(first.answer_ko).toContain("적용 한계");
    expect(first.practical_checks?.length).toBeGreaterThan(0);
    expect(second.cached).toBe(true);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(calls).toBe(callsAfterFirst);
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
      loadConfig({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-2.5-flash-lite" }),
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

describe("KciClient", () => {
  it("parses articleSearch and referenceSearch records", async () => {
    const client = new KciClient(
      loadConfig({ KCI_API_KEY: "test-kci-key" }),
      async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("apiCode") === "articleSearch") {
          return textResponse(`
            <MetaData>
              <outputData>
                <result><total>1</total></result>
                <record>
                  <journalInfo>
                    <journal-name>아동학회지</journal-name>
                    <publisher-name>한국아동학회</publisher-name>
                    <pub-year>2025</pub-year>
                  </journalInfo>
                  <articleInfo article-id="ART123">
                    <article-categories>생활과학</article-categories>
                    <title-group><article-title lang="original"><![CDATA[한국형 영유아 발달선별검사 부모용 도구 개발]]></article-title></title-group>
                    <author-group><author>김연구</author></author-group>
                    <abstract-group><abstract><![CDATA[영유아 발달선별검사 도구를 개발했다.]]></abstract></abstract-group>
                  </articleInfo>
                </record>
              </outputData>
            </MetaData>
          `);
        }
        return textResponse(`
          <MetaData>
            <outputData>
              <result><total>1</total></result>
              <record article-id="ART456">홍순옥, 김인순, 박순호. 『영유아 발달』. 파주: 양서원, 2017.</record>
            </outputData>
          </MetaData>
        `);
      }
    );

    const papers = await client.search("영유아 발달", 5);

    expect(papers.map((paper) => paper.sourceId)).toEqual(expect.arrayContaining(["ART123", "ART456"]));
    expect(papers.find((paper) => paper.sourceId === "ART456")?.title).toBe("영유아 발달");
    expect(papers.find((paper) => paper.sourceId === "ART456")?.year).toBe(2017);
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
