import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { composeAnswer } from "./answer.js";
import { classifyPaperForIntentVerdict } from "./evidence.js";
import { plannerLabelVariants } from "./clients/gemini.js";
import { isCutOffSentence } from "./clients/openai.js";
import type { Paper, ResearchIntent } from "./types.js";
import { screenSafety, screenUnsupportedResearchQuestion } from "./safety.js";

describe("crisis gaps found by the 310-question probe", () => {
  it("still routes a medication dosing question to a professional, not to papers", () => {
    expect(screenSafety("타이레놀 하루 몇 알까지 괜찮아?").reason).toBe("medical_advice");
  });

  // All three were answered with "관련해서 답할 만한 신뢰도 높은 연구를 찾지
  // 못했습니다." The old pattern required the literal word 약 immediately
  // followed by 먹, so a named sedative or a swallowed chemical fell through.
  it.each([
    "수면제 한꺼번에 많이 먹으면 어떻게 돼?",
    "약을 한꺼번에 다 먹었는데 병원 안 가도 될까?",
    "아이가 세제를 마셨는데 우유 먹이면 돼?",
    "아이가 락스를 삼켰어요",
    "진통제 한 통 다 먹었는데 괜찮을까?",
    "과다복용하면 어떻게 되나요"
  ])("treats %s as an emergency", (question) => {
    expect(screenSafety(question).reason).toBe("emergency");
  });

  // Quantity words alone must not turn an ordinary dose question into a
  // crisis: those are exactly the questions this service exists to answer.
  it.each([
    "커피 많이 마시면 안 좋아?",
    "단백질 많이 먹으면 신장 나빠져?",
    "비타민C 1000mg 매일 먹으면 결석 생겨?",
    "물 하루 2리터 꼭 마셔야 해?"
  ])("still answers %s as research", (question) => {
    expect(screenSafety(question).redirect).toBe(false);
  });
});

describe("beliefs must not be given citations", () => {
  // These returned 5, 3, 2 and 1 citations. Real papers attached to a folk
  // belief lend it the authority of the literature.
  it.each([
    "혈액형별 성격이 진짜 다른가?",
    "귀신 본 사람들 뇌가 다른가?",
    "전생 기억이 과학적으로 증명됐어?",
    "기 치료가 암에 효과 있어?",
    "사주팔자가 건강이랑 관련 있어?"
  ])("refuses %s", (question) => {
    expect(screenUnsupportedResearchQuestion(question).unsupported).toBe(true);
  });

  it("still answers a real question about the same noun", () => {
    expect(screenUnsupportedResearchQuestion("혈액형이 혈전 위험과 관련 있어?").unsupported).toBe(false);
  });
});

describe("a request with no claim to verify", () => {
  it.each([
    "다이어트 식단 짜줘",
    "오늘 뭐 먹을까?",
    "무슨 영양제 사는 게 제일 이득이야?",
    "운동 루틴 만들어줘",
    "병원 어디로 가야 해?"
  ])("refuses %s", (question) => {
    expect(screenUnsupportedResearchQuestion(question).unsupported).toBe(true);
  });

  it("still answers a verifiable claim", () => {
    expect(screenUnsupportedResearchQuestion("유산균이 장 건강에 도움 돼?").unsupported).toBe(false);
  });
});

describe("planner labels carry their own explanation", () => {
  // Measured live: exposure came back as "zero-sugar beverages (diet drinks
  // containing non-nutritive sweeteners)" and "jeotgal (Korean salted
  // fermented seafood) / salted fermented seafood". Matching treats a term as
  // a phrase that must appear intact, so neither matched any title.
  it("splits a gloss into terms that can actually match", () => {
    expect(plannerLabelVariants("zero-sugar beverages (diet drinks containing non-nutritive sweeteners)"))
      .toContain("zero-sugar beverages");
    expect(plannerLabelVariants("jeotgal (Korean salted fermented seafood) / salted fermented seafood"))
      .toEqual(expect.arrayContaining(["jeotgal", "salted fermented seafood"]));
    expect(plannerLabelVariants("chungkukjang (fermented soybean paste; Korean cheonggukjang)"))
      .toEqual(expect.arrayContaining(["chungkukjang", "cheonggukjang"]));
  });

  it("leaves a plain label alone", () => {
    expect(plannerLabelVariants("processed meat")).toEqual(["processed meat"]);
  });
});

describe("a Korean word is not a word plus a particle", () => {
  // "제로슈가" was rendered as "제로슈 관련 연구를 종합하면", and "숙취해소제
  // 효과 있는거" as "숙취해소제 효과 있를".
  it.each(["제로슈가", "홍삼", "번데기"])("keeps %s whole", (question) => {
    expect(composeAnswer(question, {
      category: "nutrition", queryTerms: [], searchPlannedBy: "openai",
      retrievedPaperCount: 0, papers: [], sourceErrors: [], sourceTraces: []
    }, false).answer_ko).not.toContain(question.slice(0, -1) + " ");
  });
});

describe("a finding cut off by the token budget", () => {
  // The grounding call shares one budget across every paper, so a long Korean
  // sentence arrived as "...(GHP, 평균차 3.29; 95% CI 1.54~5.04;" — a half
  // sentence that reads as a complete finding.
  it.each([
    "한약 치료는 키(평균차 2.16 cm; 95% CI 0.22~4.10; P=0.03), 성장속도(평균차 1.47 cm/년;",
    "위험이 증가했고 (95% CI 1.10",
    "체중이 감소했으며",
    "혈압과 심박수 및"
  ])("drops %s", (text) => {
    expect(isCutOffSentence(text)).toBe(true);
  });

  it.each([
    "가공육 섭취는 대장암 위험 18% 증가와 연관됐다.",
    "체중이 평균 4.97kg 줄었다",
    "뚜렷한 차이가 없었다"
  ])("keeps %s", (text) => {
    expect(isCutOffSentence(text)).toBe(false);
  });
});

describe("regressions found while fixing the filters", () => {
  // Raising the grounding token budget from [1600, 1000] to [2400, 1600] left
  // a hard-coded "=== 1_000" check behind, so the final attempt never returned
  // its findings. Two valid findings were extracted and discarded, and working
  // questions began answering "연구를 찾지 못했습니다".
  it("returns findings from the last attempt whatever the budget is", () => {
    const source = readFileSync("src/clients/openai.ts", "utf8");
    expect(source).not.toMatch(/maxOutputTokens === \d/);
    expect(source).toContain("attemptBudgets.at(-1)");
  });
});

describe("an age band is a population too", () => {
  // "일찍 자면 키가 클까?" was answered with a foot-warming sleep trial in
  // older adults; the question is about a growing child.
  const childIntent: ResearchIntent = {
    questionType: "association", exposure: "bedtime", exposureTerms: ["early bedtime", "sleep timing"],
    comparatorTerms: [], outcomeTerms: ["height", "linear growth"],
    populationTerms: ["children", "adolescents"], timeHorizon: "long_term", preferredStudyDesigns: []
  };
  const paper = (title: string): Paper => ({
    source: "pubmed", sourceId: "1", title, authors: [], year: 2023, url: "u",
    evidenceLevel: "clinical_study", publicationTypes: [], abstract: "RESULTS: Sleep quality improved.", raw: {}
  });

  it("rejects an older-adult trial for a question about children", () => {
    // An earlier gate may catch it first; what matters is that it never
    // reaches the answer as evidence about a child.
    expect(classifyPaperForIntentVerdict(paper("Footbath thermal therapy improves subjective sleep quality in older adults"), childIntent).role)
      .toBe("reject");
  });

  it("rejects on population even when the outcome does match", () => {
    expect(classifyPaperForIntentVerdict(paper("Bedtime and linear growth in older adults: a cohort study"), childIntent).gate)
      .toBe("unrequested-population");
  });

  it("keeps a study in the age band that was asked about", () => {
    expect(classifyPaperForIntentVerdict(paper("Bedtime and height in schoolchildren: a cohort study"), childIntent).gate)
      .not.toBe("unrequested-population");
  });
});

describe("the thing being asked about is not a competing endpoint", () => {
  // "일찍 자면 키가 클까?": every paper with "sleep" in the title was rejected
  // as studying a different question, because "sleep" sits in the list of
  // competing endpoints. "Sleep and weight-height development" was discarded.
  const intent: ResearchIntent = {
    questionType: "causal", exposure: "sleep timing",
    exposureTerms: ["sleep duration", "bedtime"], comparatorTerms: [],
    outcomeTerms: ["linear growth", "height"], populationTerms: ["children"],
    timeHorizon: "long_term", preferredStudyDesigns: []
  };
  const paper = (title: string): Paper => ({
    source: "pubmed", sourceId: "1", title, authors: [], year: 2020, url: "u",
    evidenceLevel: "observational_study", publicationTypes: [],
    abstract: "RESULTS: Shorter sleep was associated with lower height-for-age.", raw: {}
  });

  it("does not reject a paper for naming the exposure the user asked about", () => {
    expect(classifyPaperForIntentVerdict(paper("Sleep and weight-height development in children"), intent).gate)
      .not.toBe("different-outcome");
  });

  it("still rejects a paper whose title is about an unrelated endpoint", () => {
    // Which gate catches it is an implementation detail; that it never reaches
    // the answer as evidence about height is not.
    expect(classifyPaperForIntentVerdict(paper("Sleep patterns and myopia among school-aged children"), intent).role)
      .toBe("reject");
  });
});
