import { describe, expect, it } from "vitest";
import { formatHostEvidenceForMcp, noUsableEvidenceNotice, searchPaperEvidenceDescription, untranslatedQueryNotice } from "./mcp.js";
import type { EvidenceSearchResult, Paper } from "./types.js";

describe("Kakao Tools tool manifest", () => {
  it("keeps the description inside the 1,024-character Kakao Tools limit", () => {
    expect(searchPaperEvidenceDescription.length).toBeLessThanOrEqual(1_024);
  });

  it("names the service in English and Korean so the host can attribute it", () => {
    expect(searchPaperEvidenceDescription).toContain("Kadera(카더라 말고)");
  });

  it("spends the budget on the calling decision, not on answer-writing policy", () => {
    // These belong in the tool result. In the manifest they only crowd out
    // the Korean trigger utterances that decide whether the tool is called.
    expect(searchPaperEvidenceDescription).not.toMatch(/after the tool returns/i);
    expect(searchPaperEvidenceDescription).not.toMatch(/academic_query/);
  });
});

function paper(overrides: Partial<Paper>): Paper {
  return {
    source: "pubmed",
    sourceId: overrides.sourceId ?? "1",
    title: overrides.title ?? "Energy drink study",
    authors: [],
    year: 2024,
    url: overrides.url ?? "https://pubmed.ncbi.nlm.nih.gov/1/",
    evidenceLevel: "systematic_review",
    publicationTypes: ["Systematic Review"],
    abstract: overrides.abstract ?? "RESULTS: Energy drink consumption increased systolic blood pressure by 4.71 mmHg.",
    raw: {},
    ...overrides
  };
}

describe("MCP evidence package", () => {
  it("asks the host to preserve the detailed local Kadera answer structure", () => {
    const text = formatHostEvidenceForMcp({
      category: "nutrition",
      queryTerms: ["intermittent fasting weight loss systematic review"],
      hostTopicTerms: ["intermittent fasting"],
      retrievedPaperCount: 1,
      sourceErrors: [],
      sourceTraces: [],
      papers: [paper({
        sourceId: "fasting-format",
        title: "Intermittent fasting and body weight: a systematic review",
        abstract: "RESULTS: Intermittent fasting reduced body weight by 1.29 kg."
      })]
    });

    expect(text).toContain("최종 답변은 다음 로컬 Kadera 형식을 유지");
    expect(text).toContain("## 현재 판단");
    expect(text).toContain("**한줄 결론:**");
    expect(text).toContain("숫자 없이 평이한 한 문장");
    expect(text).toContain("## 이번 판단에 사용한 근거");
    expect(text).toContain("## 연구 결과 한눈에 보기");
    expect(text).toContain("## 대표 논문 N편");
    expect(text).toContain("## 연구를 읽을 때");
    expect(text).toContain("짧은 일반론으로 축약하지 마세요");
  });

  it("keeps a quantified result sentence and removes adjacent-topic or no-result papers", () => {
    const evidence: EvidenceSearchResult = {
      category: "health",
      queryTerms: ["energy drink adverse effects blood pressure systematic review"],
      hostTopicTerms: ["energy drink"],
      hostOutcomeTerms: ["blood pressure"],
      retrievedPaperCount: 4,
      sourceErrors: [],
      sourceTraces: [],
      papers: [
        paper({
          sourceId: "energy-1",
          abstract: "DATA ANALYSIS: A total of 17 trials were included. More pronounced effects were seen on systolic blood pressure at 60 minutes (4.71 mmHg; 95% CI: 2.97-6.45). CONCLUSIONS: Acute consumption increased blood pressure."
        }),
        paper({
          sourceId: "ppi-1",
          title: "Relationship between Proton Pump Inhibitors and Adverse Effects in Hemodialysis Patients",
          abstract: "RESULTS: PPI use was associated with bone fracture (OR 1.29)."
        }),
        paper({
          sourceId: "aim-only",
          title: "Energy drink use in students",
          abstract: "AIM: This study aimed to describe energy drink use and adverse effects."
        }),
        paper({
          sourceId: "protocol",
          title: "Energy drink cardiovascular study protocol",
          abstract: "RESULTS: This protocol will evaluate blood pressure."
        })
      ]
    };

    const text = formatHostEvidenceForMcp(evidence);

    expect(text).toContain("4.71 mmHg");
    expect(text).toContain("More pronounced effects");
    expect(text).not.toContain("Proton Pump Inhibitors");
    expect(text).not.toContain("Energy drink use in students");
    expect(text).not.toContain("study protocol");
  });

  it("keeps exact and explicitly requested parent evidence separate without admitting sibling oils or preprints", () => {
    const evidence: EvidenceSearchResult = {
      category: "nutrition",
      queryTerms: ["lard health effects saturated fat cardiovascular systematic review"],
      hostTopicTerms: ["lard", "pork fat"],
      hostParentTerms: ["saturated fat"],
      hostOutcomeTerms: ["LDL cholesterol", "cardiovascular disease"],
      retrievedPaperCount: 8,
      sourceErrors: [],
      sourceTraces: [],
      papers: [
        paper({
          sourceId: "lard-direct",
          title: "Lard consumption and serum cholesterol in adults: a controlled trial",
          evidenceLevel: "clinical_study",
          abstract: "RESULTS: Adults assigned to lard had higher LDL cholesterol by 0.20 mmol/L than controls."
        }),
        paper({
          sourceId: "sat-fat-1",
          title: "Reduction in saturated fat intake for cardiovascular disease",
          abstract: "RESULTS: Replacing saturated fat reduced cardiovascular events in randomized trials."
        }),
        paper({
          sourceId: "sat-fat-2",
          title: "Saturated fat intake and LDL cholesterol: systematic review and meta-analysis",
          abstract: "RESULTS: Saturated fat intake was associated with higher LDL cholesterol across 22 trials."
        }),
        paper({
          sourceId: "sat-fat-3",
          title: "Saturated fatty acid chain length and cardiovascular disease risk: meta-analysis of cohort studies",
          abstract: "RESULTS: Higher saturated fatty acid intake was associated with cardiovascular disease risk."
        }),
        paper({
          sourceId: "coconut",
          title: "Coconut oil and cardiovascular risk factors: a systematic review",
          abstract: "RESULTS: Coconut oil increased LDL cholesterol compared with non-tropical vegetable oils."
        }),
        paper({
          sourceId: "palm",
          title: "Tropical oils and cardiovascular risk: a meta-analysis",
          abstract: "RESULTS: Palm oil produced higher LDL cholesterol than unsaturated oils."
        }),
        paper({
          source: "crossref",
          sourceId: "research-square",
          title: "Saturated fat intake and cardiovascular disease: systematic review",
          url: "https://doi.org/10.21203/rs.3.rs-123456/v1",
          abstract: "RESULTS: Saturated fat intake increased cardiovascular disease risk."
        }),
        paper({
          sourceId: "preservation",
          title: "Reduction of oxidative rancidification in pork lard preservation",
          abstract: "RESULTS: The coated film reduced rancidification by 5.76%."
        })
      ]
    };

    const text = formatHostEvidenceForMcp(evidence);

    expect(text).toContain("Lard consumption and serum cholesterol");
    expect(text).toContain("Reduction in saturated fat intake");
    expect(text).toContain("Saturated fatty acid chain length");
    expect(text).toContain("상위 주제 보완 근거");
    expect(text).not.toContain("Coconut oil");
    expect(text).not.toContain("Tropical oils");
    expect(text).not.toContain("Research Square");
    expect(text).not.toContain("rancidification");
    expect(text).not.toContain("10.21203");
  });

  describe("host label mismatch must not be reported as missing research", () => {
    const meatReview = paper({
      sourceId: "processed-meat",
      title: "Processed meat consumption and colorectal cancer risk: a meta-analysis",
      abstract: "RESULTS: Processed meat intake was associated with an 18% higher risk of colorectal cancer (RR 1.18, 95% CI 1.10-1.28)."
    });

    function evidenceWith(hostTopicTerms: string[]): EvidenceSearchResult {
      return {
        category: "nutrition",
        queryTerms: ["processed meat colorectal cancer meta-analysis"],
        hostTopicTerms,
        retrievedPaperCount: 1,
        sourceErrors: [],
        sourceTraces: [],
        papers: [meatReview]
      };
    }

    // The host writes the canonical label freely. Every one of these reached
    // the user as "관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다."
    it.each([
      ["singular", ["processed meat"]],
      ["plural", ["processed meats"]],
      ["extra qualifier", ["red and processed meat"]],
      ["Korean label", ["가공육"]],
      ["Korean and English", ["가공육", "processed meat"]]
    ])("keeps the retrieved review for a %s topic label", (_case, hostTopicTerms) => {
      const text = formatHostEvidenceForMcp(evidenceWith(hostTopicTerms));
      expect(text).toContain("Processed meat consumption and colorectal cancer");
      expect(text).toContain("18% higher risk");
    });

    it("labels a paper the supplied topic cannot be matched against as unverified scope", () => {
      const text = formatHostEvidenceForMcp({
        ...evidenceWith(["energy drink"]),
        papers: [paper({
          sourceId: "cohort",
          title: "Dietary patterns and cancer incidence in a Korean cohort",
          abstract: "RESULTS: Higher intake was associated with a 12% higher risk of colorectal cancer."
        })]
      });
      expect(text).toContain("주제 관련 근거(정확 일치는 확인되지 않음)");
      expect(text).toContain("참고 근거로만 소개하고");
      expect(text).not.toContain("- 근거 범위: 직접 주제");
    });

    it("still reports no evidence when nothing was retrieved at all", () => {
      const text = formatHostEvidenceForMcp({ ...evidenceWith(["processed meat"]), papers: [], retrievedPaperCount: 0 });
      expect(text).toBe("관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다.");
    });

    // Measured live: academic_query "lard" retrieved 25 papers, every one of
    // them soap formulation, detection chemistry or a rat diet study. All were
    // correctly discarded, and the user was then told pork fat is unstudied.
    it("separates a too-broad query from an absence of research", () => {
      const notice = noUsableEvidenceNotice({ ...evidenceWith(["lard"]), papers: [], retrievedPaperCount: 25 });
      expect(notice).toContain("25편");
      expect(notice).toContain("더 구체적인 영어 학술 검색어");
      expect(notice).toContain("사용자에게 관련 연구가 없다고 답하지 마세요");
      expect(notice).not.toContain("찾지 못했습니다");
    });
  });

  describe("a null or uncertain result is a finding, not a missing one", () => {
    const strongPositive = paper({
      sourceId: "positive",
      title: "Processed meat and colorectal cancer: dose-response meta-analysis",
      abstract: "RESULTS: Each 50 g/day increment was associated with an 18% higher risk of colorectal cancer (RR 1.18, 95% CI 1.10-1.28)."
    });

    // Reported live as "위고비와 마운자로 차이" style answers that only ever
    // showed the alarming side: whenever one paper reported a strong effect,
    // every paper reporting no difference was scored as having no result and
    // dropped, which is confirmation bias baked into the renderer.
    it.each([
      ["confidence interval spanning the null", "RESULTS: The certainty of evidence was low to very low. Reductions of three servings per week showed a small and uncertain reduction in all-cause mortality (RR 0.93, 95% CI 0.85-1.02), and the confidence interval included no effect."],
      ["explicit non-association", "RESULTS: Processed meat intake was not associated with all-cause mortality (HR 0.98, 95% CI 0.92-1.05)."],
      ["qualitative non-association", "RESULTS: Processed meat intake showed no consistent association with all-cause mortality across the included cohorts."]
    ])("keeps a paper reporting a %s next to a strong positive result", (_case, abstract) => {
      const text = formatHostEvidenceForMcp({
        category: "nutrition",
        queryTerms: ["processed meat"],
        hostTopicTerms: ["processed meat"],
        retrievedPaperCount: 2,
        sourceErrors: [],
        sourceTraces: [],
        papers: [strongPositive, paper({
          sourceId: "null-result",
          title: "Processed meat intake and all-cause mortality: systematic review",
          abstract
        })]
      });
      expect(text).toContain("all-cause mortality");
      expect(text).toContain("18% higher risk");
    });
  });

  describe("a Korean academic_query is a host mistake, not absent research", () => {
    it("asks the host to retry in English instead of searching", () => {
      const notice = untranslatedQueryNotice("위고비 마운자로 차이 비교");
      expect(notice).toContain("semaglutide");
      expect(notice).toContain("사용자에게 관련 연구가 없다고 답하지 마세요");
    });

    it.each([
      "semaglutide versus tirzepatide weight loss",
      "위고비 semaglutide tirzepatide comparison",
      "creatine"
    ])("runs the search for %s", (query) => {
      expect(untranslatedQueryNotice(query)).toBeUndefined();
    });
  });

  it("does not present an included-study count as a paper result when an outcome sentence exists", () => {
    const evidence: EvidenceSearchResult = {
      category: "nutrition",
      queryTerms: ["processed meat colorectal cancer systematic review"],
      hostTopicTerms: ["processed meat"],
      hostOutcomeTerms: ["colorectal cancer"],
      retrievedPaperCount: 1,
      sourceErrors: [],
      sourceTraces: [],
      papers: [paper({
        sourceId: "processed-meat",
        title: "Processed meat intake and colorectal cancer: systematic review",
        abstract: "We conducted an overview of prospective studies on processed meat and cancer risk. We included 29 prospective studies with relative risk estimates. Higher processed meat intake was associated with a 17% higher risk of colorectal cancer."
      })]
    };

    const text = formatHostEvidenceForMcp(evidence);

    expect(text).toContain("17% higher risk");
    expect(text).not.toContain("We conducted an overview");
    expect(text).not.toContain("relative risk estimates");
    expect(text).not.toContain("included 29 prospective studies");
  });

  describe("host outcome terms", () => {
    it("keeps intermittent-fasting evidence when the host uses consumer outcome labels", () => {
      const evidence: EvidenceSearchResult = {
        category: "nutrition",
        queryTerms: ["intermittent fasting time restricted eating effects safety systematic review randomized controlled trial"],
        hostTopicTerms: ["intermittent fasting", "time-restricted eating"],
        hostOutcomeTerms: ["weight loss", "metabolic health", "safety"],
        retrievedPaperCount: 38,
        sourceErrors: [],
        sourceTraces: [],
        papers: [
          paper({
            sourceId: "fasting-meta",
            title: "Intermittent fasting and cardiometabolic risk factors: a systematic review and meta-analysis",
            abstract: "RESULTS: Intermittent fasting reduced body weight and fasting glucose compared with control diets. Adverse events were uncommon and similar between groups."
          }),
          paper({
            sourceId: "tre-trial",
            title: "Time-restricted eating in adults with metabolic syndrome: a randomized controlled trial",
            evidenceLevel: "clinical_study",
            abstract: "METHODS: Height and weight were recorded at baseline. RESULTS: Time-restricted eating reduced body weight by 3.2 kg and improved glycemic control."
          }),
          paper({
            sourceId: "cognition",
            title: "Intermittent fasting and cognitive performance in healthy adults",
            abstract: "RESULTS: Intermittent fasting did not improve memory or attention scores."
          })
        ]
      };

      const text = formatHostEvidenceForMcp(evidence);

      expect(text).toContain("Intermittent fasting and cardiometabolic risk factors");
      expect(text).toContain("Time-restricted eating in adults with metabolic syndrome");
      expect(text).not.toContain("cognitive performance");
      expect(text).not.toContain("대표 논문 0편");
    });

    it("does not treat height recorded in BMI methods as a height outcome", () => {
      const evidence: EvidenceSearchResult = {
        category: "health",
        queryTerms: ["sleep duration final adult height children"],
        hostTopicTerms: ["sleep duration"],
        hostOutcomeTerms: ["final adult height"],
        retrievedPaperCount: 2,
        sourceErrors: [],
        sourceTraces: [],
        papers: [
          paper({
            sourceId: "sleep-bmi",
            title: "Sleep timing and body mass index in children",
            abstract: "METHODS: Height and weight were measured to calculate BMI. RESULTS: Later sleep timing was associated with higher BMI."
          }),
          paper({
            sourceId: "sleep-growth",
            title: "Sleep duration and linear growth in school-aged children",
            evidenceLevel: "observational_study",
            abstract: "RESULTS: Longer sleep duration was associated with greater height velocity during follow-up."
          })
        ]
      };

      const text = formatHostEvidenceForMcp(evidence);

      expect(text).toContain("Sleep duration and linear growth");
      expect(text).not.toContain("body mass index");
    });

    it("returns an explicit non-empty diagnostic when retrieval succeeds but selection is empty", () => {
      const notice = noUsableEvidenceNotice({
        category: "nutrition",
        queryTerms: ["intermittent fasting"],
        hostTopicTerms: ["intermittent fasting"],
        hostOutcomeTerms: ["unmatched endpoint"],
        retrievedPaperCount: 38,
        sourceErrors: [],
        sourceTraces: [],
        papers: []
      });

      expect(notice).toContain("문헌 38편");
      expect(notice).toContain("대표 논문은 0편");
      expect(notice).toContain("빈 목록을 만들지 마세요");
      expect(notice).toContain("outcome_terms");
    });
  });
});
