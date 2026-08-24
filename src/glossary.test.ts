import { describe, expect, it } from "vitest";
import { composeAnswer, formatGlossaryFootnote, formatStudyComparisonTable } from "./answer.js";
import { classifyPaperForIntent, isOutcomeOpenComparison, rankPapers } from "./evidence.js";
import { hasUnnamedSubjectPlaceholder } from "./clients/openai.js";
import { ingredientForKoreanBrand, resolveKoreanBrandAliases } from "./clients/rxnav.js";
import type { EvidenceSearchResult, KeyStudyDetail, Paper, ResearchIntent } from "./types.js";

describe("brand-to-ingredient glossary", () => {
  // Reported from a live answer: the reader asked about 위고비 and 마운자로 and
  // got numbers for 티르제파타이드 and 세마글루타이드 with nothing tying the two
  // together, so a comparison answer was unreadable.
  it.each([
    ["위고비와 마운자로 차이", ["semaglutide", "tirzepatide"]],
    ["타이레놀이랑 부루펜 뭐가 달라?", ["acetaminophen", "ibuprofen"]],
    ["오젬픽 부작용 있어?", ["semaglutide"]],
    ["삭센다 맞으면 살 빠져?", ["liraglutide"]]
  ])("pairs the brand in %s with its ingredient", (question, ingredients) => {
    expect(resolveKoreanBrandAliases(question).map((alias) => alias.ingredient)).toEqual(ingredients);
  });

  it.each(["소시지 몸에 안 좋아?", "명상하면 불안 줄어?", "달걀 하루 두 개 괜찮아?"])(
    "adds no glossary to %s", (question) => {
      expect(resolveKoreanBrandAliases(question)).toEqual([]);
      expect(formatGlossaryFootnote([])).toBe("");
    }
  );

  // RxNorm's approximate match returns every ingredient of a matched product,
  // so a liquid Tylenol resolves to ethanol and 부루펜 to bupivacaine. That is
  // tolerable when it only steers retrieval and unacceptable when printed.
  it("never prints an approximate match, only the verified table", () => {
    expect(ingredientForKoreanBrand("타이레놀")).toBe("acetaminophen");
    expect(ingredientForKoreanBrand("차이")).toBeUndefined();
    expect(resolveKoreanBrandAliases("타이레놀이랑 부루펜 뭐가 달라?")
      .map((alias) => alias.ingredient)).not.toContain("ethanol");
  });

  it("keeps the Korean reading and the Latin name together", () => {
    const footnote = formatGlossaryFootnote([
      { term: "tirzepatide", askedAs: "마운자로" },
      { term: "semaglutide", askedAs: "위고비" }
    ]);
    expect(footnote).toContain("티르제파타이드(tirzepatide) = 마운자로");
    expect(footnote).toContain("세마글루타이드(semaglutide) = 위고비");
  });

  // A guessed transliteration can name a different drug, so an ingredient with
  // no verified Korean reading keeps its Latin name.
  it("does not invent a Korean reading for an unlisted ingredient", () => {
    expect(formatGlossaryFootnote([{ term: "empagliflozin", askedAs: "자디앙" }]))
      .toContain("empagliflozin = 자디앙");
  });
});

describe("an unplanned search is not an absence of research", () => {
  // Measured live with no OPENAI_API_KEY: every question, including ones the
  // MCP path answers with five papers, came back as "관련해서 답할 만한
  // 신뢰도 높은 연구를 찾지 못했습니다." because the rule-based fallback sent
  // Korean tokens to English-only databases.
  const empty = (searchPlannedBy: EvidenceSearchResult["searchPlannedBy"]): EvidenceSearchResult => ({
    category: "nutrition",
    queryTerms: ["돼지기름은 나쁜가", "systematic review", "health"],
    searchPlannedBy,
    retrievedPaperCount: 0,
    papers: [],
    sourceErrors: [],
    sourceTraces: []
  });

  it("says the search could not run when the planner was unavailable", () => {
    const answer = composeAnswer("돼지기름은 나쁜가", empty("fallback"), false);
    expect(answer.answer_ko).toContain("검색을 제대로 수행하지 못했습니다");
    expect(answer.answer_ko).toContain("관련 연구가 없다는 뜻은 아닙니다");
  });

  it("still reports absent research when the search really did run", () => {
    const answer = composeAnswer("돼지기름은 나쁜가", empty("openai"), false);
    expect(answer.answer_ko).toBe("관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다.");
  });
});

describe("a finding must stand on its own", () => {
  // Rendered live for "돼지기름은 나쁜가":
  //   "그러나(어떤 식품은) LDL과 중성지방을 증가시킬 수 있으며, 다만 그 변화는 작았다."
  // The leading "however" refers to a sentence the reader never sees, and the
  // parenthetical admits the model could not name what the result is about.
  it("drops a finding whose subject the model could not name", () => {
    expect(hasUnnamedSubjectPlaceholder("(어떤 식품은) LDL과 중성지방을 증가시킬 수 있다")).toBe(true);
    expect(hasUnnamedSubjectPlaceholder("(일부 제품은) 혈압을 올렸다")).toBe(true);
    expect(hasUnnamedSubjectPlaceholder("가공육 섭취는 대장암 위험과 연관됐다")).toBe(false);
    expect(hasUnnamedSubjectPlaceholder("세마글루타이드(위고비)는 체중을 줄였다")).toBe(false);
  });
});

describe("citation markers are stripped from the summary", () => {
  // "2021년 [2]은 ..." lost its marker and became "2021년은 ...", a sentence
  // about the year rather than about the study.
  it("leaves every timeline sentence grammatical without its marker", () => {
    const evidence: EvidenceSearchResult = {
      category: "nutrition",
      queryTerms: ["processed meat"],
      searchPlannedBy: "openai",
      retrievedPaperCount: 2,
      sourceErrors: [],
      sourceTraces: [],
      papers: [1, 2, 3].map((n) => ({
        source: "pubmed" as const, sourceId: String(n),
        title: `Processed meat and colorectal cancer ${n}`,
        authors: [], year: 2018 + n, url: `https://pubmed.ncbi.nlm.nih.gov/${n}/`,
        evidenceLevel: "systematic_review" as const, publicationTypes: ["Systematic Review"],
        abstract: `RESULTS: Processed meat intake was associated with a 1${n}% higher risk of colorectal cancer.`,
        groundedFindingKo: `가공육 섭취는 대장암 위험 1${n}% 증가와 연관됐다.`,
        raw: {}
      }))
    };
    const story = composeAnswer("소시지 몸에 안 좋아?", evidence, false).research_story;
    expect(story?.timeline_ko ?? "").not.toMatch(/\d{4}년은\s/);
    expect(story?.timeline_ko ?? "").not.toMatch(/^\s*은\s/);
  });
});

describe("a comparison the reader stated without an endpoint", () => {
  const intent = (outcomeTerms: string[]): ResearchIntent => ({
    questionType: "comparison",
    exposure: "semaglutide", exposureTerms: ["semaglutide", "Wegovy"],
    comparator: "tirzepatide", comparatorTerms: ["tirzepatide", "Mounjaro"],
    outcomeTerms, populationTerms: [], timeHorizon: "unspecified",
    preferredStudyDesigns: ["systematic review"],
    directEvidenceGroups: [["semaglutide", "Wegovy"], ["tirzepatide", "Mounjaro"]]
  });

  const headToHead: Paper = {
    source: "pubmed", sourceId: "1",
    title: "Subcutaneously administered tirzepatide vs semaglutide for adults with type 2 diabetes: a systematic review and network meta-analysis",
    authors: [], year: 2024, url: "https://pubmed.ncbi.nlm.nih.gov/1/",
    evidenceLevel: "systematic_review", publicationTypes: ["Systematic Review"],
    abstract: "RESULTS: Tirzepatide 15 mg reduced body weight by 9.57 kg more than placebo, and semaglutide 2.0 mg by 4.97 kg.",
    raw: {}
  };

  // "위고비와 마운자로 차이" states no endpoint, and the planner volunteered
  // outcome terms only on some calls. Without them this exact review was
  // classified "reject", so the same question answered with five papers or
  // with none depending on the draw.
  it("keeps a head-to-head review when no outcome was named", () => {
    expect(isOutcomeOpenComparison(intent([]))).toBe(true);
    expect(classifyPaperForIntent(headToHead, intent([]))).toBe("direct");
    expect(rankPapers([headToHead], ["semaglutide", "tirzepatide"], intent([]))).toHaveLength(1);
  });

  it("does not loosen a comparison that did name an endpoint", () => {
    expect(isOutcomeOpenComparison(intent(["body weight"]))).toBe(false);
    expect(classifyPaperForIntent(headToHead, intent(["body weight"]))).toBe("direct");
  });

  it("does not loosen a non-comparison question", () => {
    expect(isOutcomeOpenComparison({ ...intent([]), questionType: "safety" })).toBe(false);
  });
});

describe("a table cell must not cut through a statistic", () => {
  // Reported from a live answer: "제지방량은 0.21kg(95% CI…" ended inside the
  // confidence interval, hiding the number the reader came for.
  const cell = (study: Partial<KeyStudyDetail>) => formatStudyComparisonTable(
    [{ citationIndex: 1, title: "t", year: 2024, design_ko: "메타분석", population_ko: "", exposure_ko: "",
       result_ko: "", time_horizon: "mixed", limitation_ko: "", url: "", ...study } as KeyStudyDetail],
    []
  );

  it("never ends inside an unclosed parenthesis", () => {
    const text = cell({ result_ko: "우유 및 유제품 중재는 대조군과 비교해 체중을 0.48kg(95% CI: 0.19, 0.76kg) 더 증가시켰고, 제지방량은 0.21kg(95% CI: 0.02, 0.40kg) 더 늘었으며 신장에는 뚜렷한 차이가 없었다." });
    const truncated = text.split("\n").at(-1) ?? "";
    if (!truncated.includes("…")) return;
    const shown = truncated.slice(0, truncated.indexOf("…"));
    expect([...shown].filter((c) => c === "(").length).toBe([...shown].filter((c) => c === ")").length);
    expect(shown).not.toMatch(/95% CI[:\s]*$/);
  });

  it("keeps a short result untouched", () => {
    expect(cell({ result_ko: "빈혈 위험이 감소했다(OR 0.32)." })).toContain("빈혈 위험이 감소했다(OR 0.32).");
    expect(cell({ result_ko: "빈혈 위험이 감소했다(OR 0.32)." })).not.toContain("…");
  });
});
