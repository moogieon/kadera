import { describe, expect, it } from "vitest";
import { composeAnswer, formatAnswerForText } from "./answer.js";
import { buildIntentSearchQueries, buildSearchPlanFromModel } from "./clients/gemini.js";
import { sourceSentenceNamesSafetyExposure } from "./clients/openai.js";
import { classifyPaperForIntent, rankPapers } from "./evidence.js";
import { buildHostDirectPubMedQuery, enrichOutcomeVocabulary, needsBroadNutritionEvidenceLadder, normalizeTopicWideFoodSafetyPlan, rankGroundedPapers } from "./service.js";
import type { EvidenceSearchResult, Paper, ResearchIntent } from "./types.js";

const noEvidence = "관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다.";

describe("generic research-answer contract", () => {
  it("turns host topic and outcome lists into a non-conjunctive PubMed query", () => {
    const query = buildHostDirectPubMedQuery(
      ["carbonated beverages", "carbonated water", "soft drinks"],
      ["digestion", "gastric emptying", "dyspepsia", "gastroesophageal reflux"]
    );

    expect(query).toContain('"carbonated water"[Title]');
    expect(query).toContain('"dyspepsia"[Title/Abstract]');
    expect(query).toContain('"gastro-oesophageal reflux"[Title/Abstract]');
    expect(query).toContain(" OR ");
    expect(query).toContain(" AND ");
    expect(query).not.toContain("systematic review");
  });

  it("uses the planner's intent groups and excludes an unrelated adjacent paper", () => {
    const intent = causalIntent("exposure-alpha", "body weight");
    const ranked = rankPapers([
      paper("direct", "exposure-alpha and body weight: systematic review", "In 12 trials, body weight was reduced by 1.2 kg."),
      paper("adjacent", "exposure-beta and body weight: systematic review", "In 20 trials, body weight was reduced by 2.0 kg."),
      paper("wrong-outcome", "exposure-alpha and sleep: systematic review", "Sleep quality was improved.")
    ], ["exposure-alpha", "body weight"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(["direct"]);
  });

  it("builds direct and side-by-side searches for every comparison without a subject lookup", () => {
    const intent: ResearchIntent = {
      ...causalIntent("option-a", "body weight"),
      questionType: "comparison",
      comparator: "option-b",
      comparatorTerms: ["option-b"],
      directEvidenceGroups: [["option-a"], ["option-b"], ["body weight"]]
    };

    const queries = buildIntentSearchQueries(intent);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("option-a");
    expect(queries[0]).toContain("option-b");
    expect(queries[1]).toContain("option-a");
    expect(queries[2]).toContain("option-b");
  });

  it("accepts any model-planned endpoint-free topic overview without a Korean wording allowlist", () => {
    const plan = buildSearchPlanFromModel({
      category: "nutrition",
      claim_direction: "unclear",
      intent: {
        question_type: "other",
        exposure: "sausage",
        exposure_terms: ["sausage", "processed meat"],
        comparator_terms: [],
        outcome_terms: [],
        population_terms: [],
        time_horizon: "unspecified",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["sausage", "processed meat"]],
        evidence_strategy: "direct_then_contextual",
        contextual_evidence_terms: ["processed meat health outcomes"],
        direct_context_terms: ["sausage health outcomes"],
        parent_evidence_terms: ["processed meat cancer cardiovascular outcomes"]
      }
    }, "소시지는 몸에 진짜 안 좋을까?", "nutrition", ["health"], "openai");

    expect(plan.intent?.questionType).toBe("other");
    expect(plan.intent?.exposureTerms).toContain("sausage");
    expect(plan.searchQueries.join(" ")).toContain("processed meat");
  });

  it("normalizes equivalent measured safety endpoints before retrieval and ranking", () => {
    const intent: ResearchIntent = {
      ...causalIntent("topic-drink", "hypertension"),
      questionType: "safety"
    };
    const normalized = enrichOutcomeVocabulary(intent);
    const bloodPressureReview = paper(
      "bp",
      "Acute topic-drink consumption and blood pressure: systematic review",
      "Compared with control, systolic blood pressure increased by 4.4 mmHg."
    );

    expect(normalized.outcomeTerms).toContain("blood pressure");
    expect(classifyPaperForIntent(bloodPressureReview, normalized)).toBe("direct");
  });

  it("drops planner instruction echoes and unsupported scripts from search terms", () => {
    const plan = buildSearchPlanFromModel({
      category: "health",
      intent: {
        question_type: "safety",
        exposure: "energy drink",
        exposure_terms: ["energy drink", "饮料 energy drink synonyms in academic English"],
        comparator_terms: [],
        outcome_terms: ["blood pressure"],
        population_terms: [],
        time_horizon: "acute",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["energy drink"], ["blood pressure"]],
        evidence_strategy: "direct_only",
        contextual_evidence_terms: [],
        direct_context_terms: [],
        parent_evidence_terms: []
      }
    }, "에너지 드링크 가끔 마셔도 될까?", "health", [], "openai");

    expect(plan.intent?.exposureTerms).toEqual(["energy drink"]);
    expect(plan.searchQueries.join(" ")).not.toContain("synonyms in academic English");
  });

  it("keeps the possible entity but strips an unfinished canonicalization instruction", () => {
    const plan = buildSearchPlanFromModel({
      category: "health",
      intent: {
        question_type: "safety",
        exposure: "Maunjaro (resolve to canonical drug name)",
        exposure_terms: ["Maunjaro (resolve canonical)", "Maunjaro medication"],
        comparator_terms: [],
        outcome_terms: ["adverse events"],
        population_terms: [],
        time_horizon: "unspecified",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["Maunjaro", "Maunzzaro"], ["adverse events"]],
        evidence_strategy: "direct_only",
        contextual_evidence_terms: [],
        direct_context_terms: [],
        parent_evidence_terms: []
      }
    }, "마운자로 부작용", "health", [], "openai");

    expect(plan.intent?.exposure).toBe("Maunjaro");
    expect(plan.intent?.exposureTerms).toContain("Maunjaro");
    expect(plan.queryTerms.join(" ")).not.toMatch(/resolve|canonical/i);
  });

  it("preserves a zero-sugar beverage modifier when a planner returns an overly broad drink label", () => {
    const plan = buildSearchPlanFromModel({
      category: "nutrition",
      intent: {
        question_type: "other",
        exposure: "carbonated soft drink",
        exposure_terms: [
          "carbonated soft drink",
          "diet soft drink",
          "diet soda",
          "sugar-free soda",
          "zero-sugar soda",
          "zero-calorie fizzy drink",
          "low-calorie soda",
          "non-caloric soft drink"
        ],
        comparator_terms: [],
        outcome_terms: [],
        population_terms: [],
        time_horizon: "mixed",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["carbonated soft drink"]],
        evidence_strategy: "direct_then_contextual",
        contextual_evidence_terms: ["carbonated beverage health outcomes"],
        direct_context_terms: [],
        parent_evidence_terms: ["sugar-sweetened beverage cardiometabolic outcomes"]
      }
    }, "제로탄산은 나쁜가?", "nutrition", ["diet soda"], "openai");

    expect(plan.intent?.exposureTerms).toContain("zero-calorie carbonated beverage");
    expect(plan.intent?.exposureTerms).toContain("artificially sweetened beverage");
    expect((plan.intent?.contextualEvidenceTerms ?? []).join(" ")).toMatch(/zero-calorie|diet soda|sugar-free/i);
    expect(plan.intent?.contextualEvidenceTerms).toContain("artificially sweetened beverage health outcomes");
    expect((plan.intent?.parentEvidenceTerms ?? []).join(" ")).not.toMatch(/sugar-sweetened/i);
  });

  it("treats a broad food good-or-bad question as a topic review instead of discarding it as an adverse-event lookup", () => {
    const safetyPlan = buildSearchPlanFromModel({
      category: "nutrition",
      claim_direction: "harm",
      intent: {
        question_type: "safety",
        exposure: "zero-calorie carbonated beverage",
        exposure_terms: ["zero-calorie carbonated beverage", "diet soda", "artificially sweetened beverage"],
        comparator_terms: [],
        outcome_terms: ["adverse events", "body weight", "gut microbiome"],
        population_terms: [],
        time_horizon: "mixed",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["zero-calorie carbonated beverage"], ["adverse events"]],
        evidence_strategy: "direct_only",
        contextual_evidence_terms: ["artificially sweetened beverage health outcomes"],
        direct_context_terms: [],
        parent_evidence_terms: []
      }
    }, "제로 탄산은 몸에 나쁜가?", "nutrition", ["diet soda"], "openai");

    const normalized = normalizeTopicWideFoodSafetyPlan("제로 탄산은 몸에 나쁜가?", safetyPlan);

    expect(normalized.intent?.questionType).toBe("other");
    expect(normalized.intent?.outcomeTerms).toEqual([]);
    expect(normalized.intent?.directEvidenceGroups).toEqual([normalized.intent?.exposureTerms]);
    expect(needsBroadNutritionEvidenceLadder("제로 탄산은 몸에 나쁜가?", normalized)).toBe(true);
  });

  it("keeps an outcome-linked parent query for a broad named item instead of treating a bare parent category as an alias", () => {
    const plan = buildSearchPlanFromModel({
      category: "nutrition",
      claim_direction: "harm",
      intent: {
        question_type: "other",
        exposure: "pork fat (lard)",
        exposure_terms: ["pork fat", "lard"],
        comparator_terms: [],
        outcome_terms: [],
        population_terms: [],
        time_horizon: "unspecified",
        preferred_study_designs: ["systematic review", "randomized controlled trial"],
        direct_evidence_groups: [["pork fat", "lard"]],
        evidence_strategy: "direct_then_contextual",
        contextual_evidence_terms: ["animal fats"],
        direct_context_terms: ["lard fatty acid composition"],
        parent_evidence_terms: ["dietary saturated fat replacement LDL cholesterol cardiovascular events"]
      }
    }, "돼지기름은 나쁜가?", "nutrition", ["nutrition"], "openai");

    expect(plan.intent?.contextualEvidenceTerms).not.toContain("animal fats");
    expect(plan.intent?.directContextTerms).toContain("lard fatty acid composition");
    expect(plan.intent?.parentEvidenceTerms).toContain("dietary saturated fat replacement LDL cholesterol cardiovascular events");
    expect(plan.searchQueries.join(" ")).toContain("dietary saturated fat replacement LDL cholesterol cardiovascular events");
    expect(needsBroadNutritionEvidenceLadder("돼지기름은 나쁜가?", plan)).toBe(false);
  });

  it("uses an explicitly planned parent-topic review but rejects food manufacturing papers", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "sausage",
      exposureTerms: ["sausage"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["sausage"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["processed meat and colorectal cancer"]
    };
    const ranked = rankPapers([
      paper("manufacturing", "Sausage quality and storage stability", "The manufacturing process was evaluated."),
      paper("product-development", "Low-fat fresh sausage from rabbit meat: An alternative to traditional rabbit consumption", "The study aimed at the development of fresh sausages using rabbit as raw material."),
      paper("math-collision", "On the volume of the shrinking branching Brownian sausage", "The branching Brownian sausage was defined as a random subset of Euclidean space."),
      paper("industrial-collision", "Comparison of biodiesel extracted from animal fat", "Fuel properties and combustion performance were measured."),
      paper("abstract-mention", "Epidemiology of colorectal cancer: incidence, mortality, survival, and risk factors", "Dietary risk factors include processed meats such as sausages."),
      paper("parent", "Processed meat and colorectal cancer: systematic review", "Processed meat intake was associated with colorectal cancer risk."),
      paper("adjacent", "Ultra-processed food and gastric cancer: systematic review", "Ultra-processed food intake was associated with gastric cancer risk.")
    ], ["sausage", "processed meat", "colorectal cancer"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(["parent"]);
  });

  it("rejects food preservation and fermentation records when a broad food question asks about human health", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "pork lard",
      exposureTerms: ["pork lard", "lard", "pork fat"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review", "randomized controlled trial"],
      directEvidenceGroups: [["pork lard", "lard", "pork fat"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["lard effects on serum cholesterol humans"],
      parentEvidenceTerms: ["saturated fat cardiovascular disease systematic review"]
    };
    const preservation = paper(
      "lard-preservation",
      "Reduction of oxidative rancidification of fungal melanin-coated films in pork lard preservation in trading",
      "Rancidity was delayed in pork lard until day 11, with lower peroxide and acid values."
    );
    const fermentation = paper(
      "fermented-lard",
      "Metagenomic analysis of traditional fermented pork fat",
      "Bacterial families and antibiotic resistance genes were detected in the fermented product."
    );
    const supplyChain = paper(
      "pork-supply-chain",
      "Life cycle sustainability assessment of organic and conventional pork supply chains",
      "The environmental impact of pork production was estimated across the supply chain."
    );
    const animalComposition = paper(
      "pork-fat-composition",
      "Effect of Diet on the Fatty Acid Composition of Pork Fat",
      "Barrows and gilts were fed experimental diets, which changed palmitic acid and linoleic acid in backfat."
    );
    const nutrientSource = paper(
      "pork-omega-source",
      "Pork as a Source of Omega-3 Fatty Acids",
      "Feeding pigs omega-3 fatty acids increased the nutrient content of pork products."
    );
    const porkConsumption = paper(
      "pork-consumption",
      "Pork Consumption in Relation to Body Weight and Composition: A Systematic Review and Meta-analysis",
      "Across dietary trials, pork consumption was associated with changes in body weight."
    );
    const dietPatternBiomarker = paper(
      "diet-pattern-biomarker",
      "Identifying biomarkers of dietary patterns by using metabolomics",
      "Diet quality scores were associated with metabolite profiles in adult participants."
    );
    const humanTrial = paper(
      "lard-human-trial",
      "Pork lard and serum cholesterol in adults: randomized controlled trial",
      "In 80 adult participants, serum LDL cholesterol decreased after dietary pork lard consumption."
    );

    expect(classifyPaperForIntent(preservation, intent)).toBe("reject");
    expect(classifyPaperForIntent(fermentation, intent)).toBe("reject");
    expect(classifyPaperForIntent(supplyChain, intent)).toBe("reject");
    expect(classifyPaperForIntent(animalComposition, intent)).toBe("reject");
    expect(classifyPaperForIntent(nutrientSource, intent)).toBe("reject");
    expect(classifyPaperForIntent(porkConsumption, intent)).toBe("reject");
    expect(classifyPaperForIntent(dietPatternBiomarker, intent)).toBe("reject");
    expect(classifyPaperForIntent(humanTrial, intent)).toBe("direct");
  });

  it("does not let a generic cardiovascular fat review replace a planned saturated-fat bridge", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "pork lard",
      exposureTerms: ["pork lard", "lard", "pork fat"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["pork lard", "lard", "pork fat"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["lard effects on serum cholesterol humans"],
      parentEvidenceTerms: ["saturated fat cardiovascular disease systematic review"]
    };
    const omegaThree = paper(
      "omega-three",
      "Omega-3 fatty acids for the primary and secondary prevention of cardiovascular disease: systematic review",
      "In randomized trials, omega-3 intake was associated with a small change in cardiovascular events."
    );
    const saturatedFat = paper(
      "saturated-fat",
      "Reduction in saturated fat intake for cardiovascular disease: systematic review",
      "Randomized trials found cardiovascular outcomes after reducing saturated fat intake."
    );

    expect(classifyPaperForIntent(omegaThree, intent)).toBe("reject");
    expect(classifyPaperForIntent(saturatedFat, intent)).toBe("contextual");
  });

  it("does not let a generic parent phrase pull a different food into a broad answer", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "named cooking fat",
      exposureTerms: ["named cooking fat"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["named cooking fat"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["named cooking fat health outcomes"],
      parentEvidenceTerms: ["dietary fat intake cardiovascular disease risk", "saturated fat LDL cholesterol"]
    };
    const eggReview = paper(
      "egg-review",
      "Associations of Dietary Cholesterol and Egg Consumption With Mortality: Systematic Review",
      "Higher dietary cholesterol and egg consumption were associated with mortality risk."
    );
    const saturatedFatReview = paper(
      "saturated-review",
      "Saturated fat intake and LDL cholesterol: systematic review",
      "Reducing saturated fat reduced LDL cholesterol concentrations."
    );

    expect(classifyPaperForIntent(eggReview, intent)).toBe("reject");
    expect(classifyPaperForIntent(saturatedFatReview, intent)).toBe("contextual");
  });

  it("rejects an exact-topic seasonal or composition paper from a broad health answer", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "topic-aroma",
      exposureTerms: ["topic-aroma"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review", "randomized controlled trial"],
      directEvidenceGroups: [["topic-aroma"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["topic-aroma human health outcomes"]
    };
    const ranked = rankPapers([
      paper("seasonal", "Seasonal release of topic-aroma from tree leaves", "Topic-aroma release increased during spring and summer and declined in autumn."),
      paper("vehicle", "Topic-aroma as a solvent for colonoscopy preparation", "Taste scores were significantly higher in the topic-aroma group."),
      paper("human", "Topic-aroma exposure and stress in healthy adults", "In healthy adult participants, topic-aroma exposure significantly reduced stress scores."),
      paper("cell", "Topic-aroma induces immune-cell activity", "In an NK-92 cell line, topic-aroma significantly increased cytotoxic activity.")
    ], ["topic-aroma", "health outcomes"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["human", "cell"]));
    expect(ranked.map((item) => item.sourceId)).not.toContain("seasonal");
    expect(ranked.map((item) => item.sourceId)).not.toContain("vehicle");
    expect(ranked[0]?.sourceId).toBe("human");
  });

  it("does not substitute a sugar-sweetened sibling for a zero-sugar beverage", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "zero calorie carbonated beverage",
      exposureTerms: ["zero calorie carbonated beverage", "diet soda"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["zero calorie carbonated beverage", "diet soda"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["carbonated beverage health outcomes"]
    };
    const ranked = rankPapers([
      paper("sugar-sibling", "Sugar-sweetened carbonated beverages and body weight", "Higher intake was associated with higher body weight."),
      paper("unicode-sugar-sibling", "Sugar‐sweetened carbonated beverages and diabetes", "Higher intake was associated with higher diabetes risk."),
      paper("zero-direct", "Zero calorie carbonated beverage consumption and insulin sensitivity", "In adults, consumption did not alter insulin sensitivity.")
    ], ["zero calorie carbonated beverage", "health outcomes"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(["zero-direct"]);
  });

  it("labels a mixed beverage review by the requested no-sugar exposure", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "zero-calorie carbonated beverage",
      exposureTerms: ["zero-calorie carbonated beverage", "diet soda", "artificially sweetened beverage"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["zero-calorie carbonated beverage", "diet soda", "artificially sweetened beverage"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["artificially sweetened beverage health outcomes"]
    };
    const mixedReview = {
      ...paper(
        "mixed-beverage",
        "Sugar- and Artificially Sweetened Beverages and Health Outcomes: Systematic Review",
        "Artificially sweetened beverages were associated with higher diabetes risk."
      ),
      groundedFindingKo: "인공감미료 음료 섭취는 제2형 당뇨 위험 증가와 연관됐다.",
      groundedSourceSentence: "Artificially sweetened beverages were associated with higher diabetes risk."
    };
    const answer = composeAnswer("제로탄산은 나쁜가?", {
      ...evidenceFor(intent, [mixedReview]),
      searchPlannedBy: "openai"
    }, false);

    expect(answer.detail?.key_studies[0]?.exposure_ko).toBe("인공감미료·저칼로리 음료 섭취");
  });

  it("does not relabel a low-calorie fasting comparator as a no-sugar beverage", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "intermittent fasting",
      exposureTerms: ["intermittent fasting", "time-restricted eating", "alternate-day fasting"],
      comparatorTerms: ["continuous energy restriction", "low-calorie diet"],
      outcomeTerms: ["body weight", "metabolic health"],
      populationTerms: ["adults"],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["intermittent fasting", "time-restricted eating"], ["body weight", "metabolic health"]],
      evidenceStrategy: "direct_only",
      contextualEvidenceTerms: []
    };
    const fastingReview = {
      ...paper(
        "fasting-review",
        "Intermittent fasting versus continuous energy restriction: a systematic review",
        "Intermittent fasting reduced body weight by 1.29 kg compared with a low-calorie diet."
      ),
      groundedFindingKo: "간헐적 단식은 저칼로리 식단보다 체중을 1.29kg 더 감소시켰습니다.",
      groundedSourceSentence: "Intermittent fasting reduced body weight by 1.29 kg compared with a low-calorie diet."
    };
    const answer = composeAnswer("간헐적 단식에 대해 궁금해", {
      ...evidenceFor(intent, [fastingReview]),
      searchPlannedBy: "openai"
    }, false);

    expect(answer.detail?.key_studies[0]?.exposure_ko).toContain("간헐적 단식");
    expect(answer.detail?.key_studies[0]?.exposure_ko).not.toContain("음료");
  });

  it("keeps a contextual systematic review ahead of an exact-topic cohort in a broad overview", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "zero-calorie carbonated beverage",
      exposureTerms: ["zero-calorie carbonated beverage", "diet soda", "artificially sweetened beverage"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "mixed",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["zero-calorie carbonated beverage", "diet soda", "artificially sweetened beverage"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["artificially sweetened beverage health outcomes"]
    };
    const exactCohort = {
      ...paper("zero-cohort", "Zero-calorie carbonated beverage and a narrow outcome: cohort study", "Daily consumption was associated with a higher narrow-outcome risk."),
      evidenceLevel: "observational_study" as const,
      groundedFindingKo: "매일 섭취는 특정 결과 위험 증가와 연관됐다.",
      groundedSourceSentence: "Daily consumption was associated with a higher narrow-outcome risk."
    };
    const contextualReview = {
      ...paper("asb-review", "Artificially sweetened beverages and health outcomes: systematic review", "Across prospective studies, artificially sweetened beverages were associated with higher diabetes risk."),
      groundedFindingKo: "인공감미료 음료 섭취는 당뇨 위험 증가와 연관됐다.",
      groundedSourceSentence: "Across prospective studies, artificially sweetened beverages were associated with higher diabetes risk."
    };

    expect(rankGroundedPapers([exactCohort, contextualReview], intent)[0]?.sourceId).toBe("asb-review");
  });

  it("does not relabel a planner's parent category as a direct synonym", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "exact-item (parent item)",
      exposureTerms: ["exact-item", "parent item"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["exact-item", "parent item"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["parent item health outcomes"]
    };
    const parentReview = paper("parent-only", "Parent item health outcomes: systematic review", "Parent item exposure was associated with a lower risk of disease.");

    expect(classifyPaperForIntent(parentReview, intent)).toBe("contextual");
  });

  it("keeps a partially overlapping parent category contextual", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "specific source fat",
      exposureTerms: ["specific source fat", "source fat"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["specific source fat", "source fat"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["source fat health effects"]
    };
    const parentReview = paper("parent-fat", "Source fat health effects: systematic review", "Source fat intake was associated with a lower cardiovascular disease risk.");

    expect(classifyPaperForIntent(parentReview, intent)).toBe("contextual");
  });

  it("matches standard endpoint abbreviations when ranking an outcome-linked parent review", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "named cooking fat",
      exposureTerms: ["named cooking fat"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["systematic review"],
      directEvidenceGroups: [["named cooking fat"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: [],
      parentEvidenceTerms: ["dietary saturated fat cardiovascular disease"]
    };
    const ranked = rankPapers([
      paper("cvd-review", "Saturated fat restriction for CVD prevention: systematic review", "Randomized trials found fewer cardiovascular disease events after saturated fat restriction."),
      paper("irrelevant", "Dietary fiber and sleep: systematic review", "Sleep quality was assessed.")
    ], ["dietary saturated fat cardiovascular disease"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(["cvd-review"]);
  });

  it("excludes non-human food experiments before an evidence answer is assembled", () => {
    const intent = causalIntent("topic-fat", "blood lipids");
    const ranked = rankPapers([
      paper("human", "topic-fat and blood lipids: clinical trial", "In adult participants, LDL cholesterol was reduced."),
      paper("hen", "The influence of topic-fat on plasma lipids in laying hens", "Laying hens received the experimental diet.")
    ], ["topic-fat", "blood lipids"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(["human"]);
  });

  it("repairs a structurally collapsed A-versus-B plan without a subject-specific rule", () => {
    const plan = buildSearchPlanFromModel({
      category: "nutrition",
      claim_direction: "unclear",
      intent: {
        question_type: "comparison",
        exposure: "option-alpha; option-beta",
        exposure_terms: ["option-alpha", "option-alpha synonym", "option-beta", "option-beta synonym"],
        comparator: "option-alpha vs option-beta",
        comparator_terms: ["option-beta class"],
        outcome_terms: ["protein quality"],
        population_terms: [],
        time_horizon: "unspecified",
        preferred_study_designs: ["systematic review"],
        direct_evidence_groups: [["option-alpha"], ["option-beta"], ["protein quality"]],
        evidence_strategy: "direct_only",
        contextual_evidence_terms: ["option-alpha protein quality"],
        direct_context_terms: [],
        parent_evidence_terms: []
      }
    }, "option-alpha vs option-beta", "nutrition", [], "openai");

    expect(plan.intent?.exposure).toBe("option-alpha");
    expect(plan.intent?.comparator).toBe("option-beta");
    expect(plan.intent?.exposureTerms).toContain("option-alpha synonym");
    expect(plan.intent?.comparatorTerms).toContain("option-beta synonym");
  });

  it("returns exactly one Korean sentence only when there is no eligible paper", () => {
    const answer = composeAnswer("희귀한 대상이 정말 효과가 있을까?", {
      category: "health",
      queryTerms: ["rare-topic"],
      papers: [],
      sourceErrors: [],
      sourceTraces: []
    }, false);

    expect(answer.answer_ko).toBe(noEvidence);
    expect(formatAnswerForText(answer)).toBe(noEvidence);
    expect(answer.citations).toEqual([]);
  });

  it("does not attach a safety panel to a non-safety question merely because an abstract contains risk wording", () => {
    const intent = causalIntent("topic-risk", "body weight");
    const answer = composeAnswer("topic-risk가 체중에 도움이 될까?", evidenceFor(intent, [
      paper("risk", "topic-risk and body weight: systematic review", "In 18 trials, body weight was reduced by 1.5 kg. Higher risk was reported in a separate subgroup.")
    ]), false);

    expect(answer.detail?.risk_ko).toBe("");
    expect(formatAnswerForText(answer)).not.toContain("🧪 논문에서 확인한 안전성");
  });

  it("keeps an explicit safety finding only for a safety question", () => {
    const intent: ResearchIntent = { ...causalIntent("topic-safety", "adverse events"), questionType: "safety" };
    const answer = composeAnswer("topic-safety의 부작용은?", evidenceFor(intent, [
      paper("safety", "topic-safety adverse events safety: systematic review", "Across 14 trials, adverse events including nausea and vomiting were more frequent than placebo.")
    ]), false);

    expect(answer.detail?.risk_ko).toContain("위장관 이상반응");
    expect(formatAnswerForText(answer)).toContain("## 논문에서 확인된 안전성");
  });

  it("does not accept a generic multi-treatment safety sentence for one named medicine", () => {
    const intent: ResearchIntent = {
      ...causalIntent("tirzepatide", "adverse events"),
      questionType: "safety",
      exposureTerms: ["tirzepatide"]
    };

    expect(sourceSentenceNamesSafetyExposure(
      "All treatments increased gastrointestinal adverse events, and discontinuation was highest with semaglutide.",
      intent
    )).toBe(false);
    expect(sourceSentenceNamesSafetyExposure(
      "Tirzepatide 15 mg increased nausea, vomiting, and diarrhea compared with placebo.",
      intent
    )).toBe(true);
  });

  it("does not duplicate a user brand name before a paper's generic-name subject", () => {
    const intent: ResearchIntent = {
      ...causalIntent("tirzepatide", "adverse events"),
      questionType: "safety",
      exposureTerms: ["tirzepatide", "Mounjaro"]
    };
    const finding = {
      ...paper("tirzepatide-safety", "Tirzepatide adverse events: systematic review", "Nausea was more frequent than placebo."),
      groundedFindingKo: "티르제파타이드는 위약보다 메스꺼움이 더 자주 보고됐습니다.",
      groundedSourceSentence: "Tirzepatide was associated with more nausea than placebo."
    };
    const answer = composeAnswer("마운자로 부작용", evidenceFor(intent, [finding]), false);

    expect(answer.answer_ko).toContain("현재 근거를 종합하면, 티르제파타이드는");
    expect(answer.answer_ko).not.toContain("마운자로는 티르제파타이드는");
  });

  it("rejects an unrequested co-exposure before it can become safety evidence", () => {
    const intent: ResearchIntent = {
      ...causalIntent("topic-drink", "adverse events"),
      questionType: "safety"
    };
    const mixedExposure = paper(
      "mixed-exposure",
      "Acute impact of topic-drink with alcohol on cognition: systematic review",
      "Compared with control, the combined exposure increased impulsivity."
    );
    const directExposure = paper(
      "direct-exposure",
      "Acute topic-drink adverse events and blood pressure: systematic review",
      "Compared with control, adverse events included a 4.4 mmHg increase in systolic blood pressure."
    );

    expect(classifyPaperForIntent(mixedExposure, intent)).toBe("reject");
    expect(classifyPaperForIntent(directExposure, intent)).toBe("direct");
  });

  it("does not let a broad planned alias turn a different product into direct safety evidence", () => {
    const intent: ResearchIntent = {
      ...causalIntent("energy drink", "adverse events"),
      questionType: "safety",
      exposureTerms: ["energy drink", "caffeinated beverage"],
      directEvidenceGroups: [["energy drink", "caffeinated beverage"], ["adverse events"]]
    };
    const coffeeTrial = paper(
      "coffee",
      "Caffeinated coffee consumption and atrial fibrillation: randomized trial",
      "There was no significant difference in adverse events with caffeinated coffee consumption."
    );

    expect(classifyPaperForIntent(coffeeTrial, intent)).toBe("reject");
    expect(rankPapers([coffeeTrial], ["energy drink", "adverse events"], intent)).toEqual([]);

    const caffeineSportReview = paper(
      "caffeine-sport",
      "Acute ingestion of caffeine and team sports performance: systematic review",
      "Caffeine significantly increased jump height and sprint velocity."
    );
    expect(classifyPaperForIntent(caffeineSportReview, intent)).toBe("reject");
  });

  it("does not expose a vague system-level sentence from a live safety retrieval", () => {
    const intent: ResearchIntent = {
      ...causalIntent("topic-drink", "adverse events"),
      questionType: "safety"
    };
    const vague = {
      ...paper("vague", "topic-drink adverse events: systematic review", "The most common adverse events affect the cardiovascular and neurological systems."),
      groundedFindingKo: "가장 흔한 이상반응은 심혈관계와 신경계에 영향을 미칩니다.",
      groundedSourceSentence: "The most common adverse events affect the cardiovascular and neurological systems."
    };
    const concrete = {
      ...paper("concrete", "topic-drink adverse events and insomnia: systematic review", "Compared with control, topic-drink consumption increased insomnia as an adverse event (OR 5.02; 95% CI 1.72-14.63)."),
      groundedFindingKo: "대조군과 비교했을 때 불면증 오즈비(OR)가 5.02로 증가했습니다.",
      groundedSourceSentence: "Compared with control, topic-drink consumption increased insomnia (OR 5.02; 95% CI 1.72-14.63)."
    };
    const answer = composeAnswer("topic-drink 가끔 마셔도 될까?", {
      ...evidenceFor(intent, [vague, concrete]),
      searchPlannedBy: "openai"
    }, false);
    const text = formatAnswerForText(answer);

    expect(answer.citations.map((citation) => citation.sourceId)).toEqual(["concrete"]);
    expect(text).not.toContain("심혈관계와 신경계에 영향을");
    expect(text).toContain("불면증 오즈비");
  });

  it("never exposes a parser or translation failure as a paper result", () => {
    const intent = causalIntent("topic-drink", "blood pressure");
    const ungrounded = {
      ...paper("failed", "topic-drink and blood pressure: systematic review", "The review assessed blood pressure outcomes."),
      groundedFindingKo: "초록에서 결과를 한국어로 안전하게 추출하지 못했습니다.",
      groundedSourceSentence: "The review assessed blood pressure outcomes."
    };
    const answer = composeAnswer("topic-drink은 혈압에 나쁠까?", {
      ...evidenceFor(intent, [ungrounded]),
      searchPlannedBy: "openai"
    }, false);

    expect(answer.citations).toEqual([]);
    expect(formatAnswerForText(answer)).toBe(noEvidence);
  });

  it("rejects self-reported consumer surveys when measured safety evidence is available", () => {
    const intent: ResearchIntent = {
      ...causalIntent("topic-drink", "adverse events"),
      questionType: "safety"
    };
    const consumerSurvey = {
      ...paper("survey", "Public awareness of topic-drink safety", "In a consumer survey, self-reported adverse events included headache and palpitations."),
      groundedFindingKo: "소비자 설문에서 두통과 두근거림이 보고됐습니다.",
      groundedSourceSentence: "In a consumer survey, self-reported adverse events included headache and palpitations."
    };
    const measured = {
      ...paper("measured", "Acute topic-drink adverse events and blood pressure: systematic review", "Compared with control, adverse events included a 4.4 mmHg increase in systolic blood pressure."),
      groundedFindingKo: "대조군과 비교했을 때 수축기혈압이 4.4 mmHg 증가했습니다.",
      groundedSourceSentence: "Compared with control, adverse events included a 4.4 mmHg increase in systolic blood pressure."
    };
    const answer = composeAnswer("topic-drink 가끔 마셔도 될까?", {
      ...evidenceFor(intent, [consumerSurvey, measured]),
      searchPlannedBy: "openai"
    }, false);
    const text = formatAnswerForText(answer);

    expect(answer.citations.map((citation) => citation.sourceId)).toEqual(["measured"]);
    expect(text).not.toContain("소비자 설문");
    expect(text).toContain("수축기혈압");
  });

  it("shows up to five representative papers while retaining a wider evidence basis", () => {
    const intent = causalIntent("wide-topic", "body weight");
    const papers = Array.from({ length: 12 }, (_, index) =>
      paper(`${index + 1}`, `wide-topic body weight review ${index + 1}`, `In ${12 + index} trials, body weight was reduced by ${index + 1}.0 kg.`)
    );
    const answer = composeAnswer("wide-topic은 체중에 효과가 있을까?", evidenceFor(intent, papers), false);

    expect(answer.citations).toHaveLength(5);
    expect(answer.evidence_basis_ko).toContain("12편");
  });

  it("labels cell experiments separately from human evidence in a broad-topic answer", () => {
    const intent: ResearchIntent = {
      questionType: "other",
      exposure: "topic-aroma",
      exposureTerms: ["topic-aroma"],
      comparatorTerms: [],
      outcomeTerms: [],
      populationTerms: [],
      timeHorizon: "unspecified",
      preferredStudyDesigns: ["randomized controlled trial"],
      directEvidenceGroups: [["topic-aroma"]],
      evidenceStrategy: "direct_then_contextual",
      contextualEvidenceTerms: ["topic-aroma health outcomes"]
    };
    const human = {
      ...paper("human-aroma", "Topic-aroma exposure in healthy adults", "In healthy adult participants, topic-aroma exposure reduced stress scores."),
      groundedFindingKo: "건강한 성인에서 스트레스 점수가 감소했습니다.",
      groundedSourceSentence: "In healthy adult participants, topic-aroma exposure reduced stress scores."
    };
    const cells = {
      ...paper("cell-aroma", "Topic-aroma induces immune-cell activity", "In an NK-92 cell line, topic-aroma increased cytotoxic activity."),
      evidenceLevel: "unknown" as const,
      publicationTypes: [],
      groundedFindingKo: "NK-92 세포에서 세포독성 활성이 증가했습니다.",
      groundedSourceSentence: "In an NK-92 cell line, topic-aroma increased cytotoxic activity."
    };
    const answer = composeAnswer("topic-aroma는 실제로 좋을까?", {
      ...evidenceFor(intent, [human, cells]),
      searchPlannedBy: "openai"
    }, false);
    const text = formatAnswerForText(answer);

    expect(text).toContain("세포·실험 연구 1편");
    expect(text).toContain("**대상·조건:** 세포 실험");
    expect(text).toContain("세포·실험 결과만으로 사람에게 같은 효과가 입증됐다고 볼 수는 없습니다.");
  });

  it("keeps citation indices in the detail section, not the summary", () => {
    const intent = causalIntent("citation-topic", "body weight");
    const answer = composeAnswer("citation-topic은 체중에 효과가 있을까?", evidenceFor(intent, [
      paper("citation-1", "citation-topic body weight systematic review", "In 12 trials, body weight was reduced by 1.2 kg."),
      paper("citation-2", "citation-topic body weight clinical trial", "Body weight was reduced by 0.8 kg."),
      paper("citation-3", "citation-topic body weight cohort study", "Higher exposure was associated with lower body weight.")
    ]), false);
    const text = formatAnswerForText(answer);
    const summary = text.split("## 이번 판단에 사용한 근거")[0] ?? "";

    expect(summary).not.toMatch(/\[\d+\]/);
    expect(text).toContain("[1]");
  });

  it("uses the requested exposure-outcome result instead of an unrelated result in a broad diet review", () => {
    const intent: ResearchIntent = {
      ...causalIntent("dietary sugar intake", "incident type 2 diabetes"),
      exposureTerms: ["dietary sugar intake", "sugar-sweetened beverage intake", "high sugar intake"],
      outcomeTerms: ["incident type 2 diabetes", "type 2 diabetes incidence"],
      directEvidenceGroups: [
        ["dietary sugar intake", "sugar-sweetened beverage intake", "high sugar intake"],
        ["incident type 2 diabetes", "type 2 diabetes incidence"]
      ]
    };
    const answer = composeAnswer("너무 단 음식을 많이 먹으면 당뇨에 걸리나", evidenceFor(intent, [
      paper("sugar-1", "Dietary Sugar Intake and Incident Type 2 Diabetes Risk: systematic review", "Each additional serving of sugar-sweetened beverages was associated with a higher risk of T2D (RR: 1.25). In contrast, healthy dietary patterns reduced risk of T2D."),
      paper("sugar-2", "Sugar-Sweetened Beverages and Type 2 Diabetes: meta-analysis", "Individuals in the highest sugar-sweetened beverage intake group had a 26% greater risk of developing type 2 diabetes."),
      paper("sugar-3", "Sugar-Sweetened Beverages and Diabetes Incidence: cohort study", "Sugar-sweetened beverage intake was associated with a higher risk of type 2 diabetes."),
      paper("unrelated", "Dietary patterns and diabetes: umbrella review", "Mediterranean diet was associated with lower risk of type 2 diabetes.")
    ]), false);

    expect(answer.citations.length).toBeGreaterThanOrEqual(3);
    expect(answer.citations.length).toBeLessThanOrEqual(5);
    expect(answer.detail?.key_studies[0]?.result_ko).toContain("25% 증가");
    expect(answer.detail?.key_studies.every((study) => !/추출하지 못/.test(study.result_ko))).toBe(true);
  });

  it("keeps sugary-drink diabetes evidence distinct from screening counts and other sweet foods", () => {
    const intent: ResearchIntent = {
      ...causalIntent("high intake of added sugars / consumption of sugar-sweetened foods and beverages", "type 2 diabetes incidence"),
      exposureTerms: ["added sugar intake", "consumption of sugary foods", "sugar-sweetened beverages"],
      outcomeTerms: ["type 2 diabetes incidence", "new-onset type 2 diabetes"],
      directEvidenceGroups: [
        ["added sugar intake", "consumption of sugary foods", "sugar-sweetened beverages"],
        ["type 2 diabetes incidence", "new-onset type 2 diabetes"]
      ],
      evidenceStrategy: "direct_only"
    };
    const answer = composeAnswer("너무 단 음식을 많이 먹으면 당뇨에 걸리나", evidenceFor(intent, [
      paper("sugar-scale", "Dietary Sugar Intake and Incident Type 2 Diabetes Risk: systematic review", "Of 10,384 studies, 29 cohorts were included. Dietary sources included sugar-sweetened beverages [SSBs]. Each additional serving of SSB was associated with a higher risk of type 2 diabetes (risk ratio [RR]: 1.25). No associations were found for added sugar."),
      paper("sugar-dose", "Sugar-sweetened beverages and type 2 diabetes: meta-analysis", "Higher consumption of sugar sweetened beverages was associated with a greater incidence of type 2 diabetes, by 18% per one serving/day."),
      paper("sugar-umbrella", "Sugar-sweetened beverages and adverse outcomes: umbrella review", "Convincing evidence supported direct associations between sugar-sweetened beverage consumption and risks of type 2 diabetes mellitus."),
      paper("sugar-2021", "Sugar-sweetened beverages and type 2 diabetes: systematic review", "With each additional SSB serving per day, the risk increased by 27% for T2D.")
    ]), false);
    const text = formatAnswerForText(answer);

    expect(text).toContain("설탕이 든 음료 섭취");
    expect(text).toContain("29개 원 연구");
    expect(text).not.toContain("10,384개 원 연구");
    expect(text).not.toContain("541,288명");
    expect(text).toContain("음료가 아닌 모든 단 음식까지 같은 위험도로 묶어 단정할 수는 없습니다.");
    expect(answer.citations.length).toBeGreaterThanOrEqual(3);
    expect(answer.citations.length).toBeLessThanOrEqual(5);
    expect(answer.detail?.key_studies.every((study) => !/추출하지 못/.test(study.result_ko))).toBe(true);
  });

  it("marks indirect comparison evidence as separate evidence rather than declaring a winner", () => {
    const intent: ResearchIntent = {
      ...causalIntent("option-a", "body weight"),
      questionType: "comparison",
      comparator: "option-b",
      comparatorTerms: ["option-b"],
      directEvidenceGroups: [["option-a"], ["option-b"], ["body weight"]]
    };
    const answer = composeAnswer("option-a와 option-b 중 어느 쪽이 더 나을까?", evidenceFor(intent, [
      paper("a", "option-a body weight systematic review", "In 10 trials, body weight was reduced by 1.0 kg."),
      paper("b", "option-b body weight systematic review", "In 11 trials, body weight was reduced by 1.2 kg.")
    ], "parallel"), false);

    expect(answer.verdict).toBe("mixed");
    expect(answer.limitations.join(" ")).toContain("직접 비교한 연구가 아니라");
  });

  it("does not treat two options mentioned only in an abstract as a direct comparison", () => {
    const intent: ResearchIntent = {
      ...causalIntent("option-a", "protein quality"),
      questionType: "comparison",
      comparator: "option-b",
      comparatorTerms: ["option-b"],
      directEvidenceGroups: [["option-a"], ["option-b"], ["protein quality"]]
    };
    const ranked = rankPapers([
      paper("background-mentions", "Third option protein quality review", "Option-a and option-b were mentioned in the background, but no head-to-head result was reported.")
    ], ["option-a", "option-b", "protein quality"], intent);

    expect(ranked).toEqual([]);
  });

  it("keeps food-protein evidence tied to an edible nutrition metric, not animal names or product development", () => {
    const intent: ResearchIntent = {
      ...causalIntent("pork", "protein quality"),
      questionType: "comparison",
      exposure: "pork",
      exposureTerms: ["pork", "pork meat"],
      comparator: "chicken",
      comparatorTerms: ["chicken", "chicken meat"],
      outcomeTerms: ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"],
      directEvidenceGroups: [
        ["pork", "pork meat"],
        ["chicken", "chicken meat"],
        ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"]
      ]
    };
    const ranked = rankPapers([
      paper(
        "pork-assay",
        "Pork products have DIAAS greater than 100 when determined in pigs",
        "All pork products had DIAAS greater than 100."
      ),
      paper(
        "chicken-human",
        "True digestibility of animal and plant protein in humans",
        "The true tryptophan digestibility of chicken meat was 95.9%, and digestibility was measured in human participants."
      ),
      paper(
        "sausage-development",
        "Plant-based vs. pork sausages: protein nutritional quality",
        "Pork sausage had a higher DIAAS in an in vitro gastrointestinal model."
      ),
      paper(
        "chicken-virus",
        "Adaptive truncation of the S gene in chicken embryo passaging",
        "The mutation impaired viral protein synthesis in chicken embryo kidney cells."
      ),
      paper(
        "insect-reference",
        "Mealworm larvae and crickets show high protein digestibility by DIAAS",
        "The DIAAS values were 113 for chicken and 89 for mealworms."
      )
    ], ["pork", "chicken", "protein quality"], intent);

    expect(ranked.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["pork-assay", "chicken-human"]));
    expect(ranked.map((item) => item.sourceId)).not.toContain("sausage-development");
    expect(ranked.map((item) => item.sourceId)).not.toContain("chicken-virus");
    expect(ranked.map((item) => item.sourceId)).not.toContain("insect-reference");
  });

  it("does not let a comparison retry reintroduce a food-processing paper as contextual evidence", () => {
    const intent: ResearchIntent = {
      ...causalIntent("pork", "protein quality"),
      questionType: "comparison",
      exposure: "pork",
      exposureTerms: ["pork", "pork meat"],
      comparator: "chicken",
      comparatorTerms: ["chicken", "chicken meat"],
      outcomeTerms: ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"],
      directEvidenceGroups: [
        ["pork", "pork meat"],
        ["chicken", "chicken meat"],
        ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"]
      ],
      evidenceStrategy: "direct_only"
    };
    const sausage = paper(
      "retry-sausage",
      "Plant-based vs. pork sausages: protein nutritional quality",
      "Pork sausage had a higher DIAAS in an in vitro gastrointestinal model."
    );
    const cooking = paper(
      "retry-cooking",
      "Ultrasound pretreatment for protein digestibility of stir-frying chicken gizzards",
      "Protein digestibility increased after ultrasound pretreatment."
    );

    expect(classifyPaperForIntent(sausage, intent)).toBe("reject");
    expect(classifyPaperForIntent(cooking, intent)).toBe("reject");
  });

  it("keeps an item-specific numerical result available for a food comparison", () => {
    const intent: ResearchIntent = {
      ...causalIntent("pork", "protein quality"),
      questionType: "comparison",
      exposure: "pork",
      exposureTerms: ["pork", "pork meat"],
      comparator: "chicken",
      comparatorTerms: ["chicken", "chicken meat"],
      outcomeTerms: ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"],
      directEvidenceGroups: [["pork"], ["chicken"], ["protein quality", "DIAAS", "protein digestibility", "amino acid profile"]],
      evidenceStrategy: "direct_only"
    };
    const chicken = paper(
      "chicken-value",
      "True digestibility of plant and animal protein in humans",
      "The true tryptophan digestibility of chicken meat was 95.9 ± 2.2%. Plant protein digestibility was significantly lower than animal protein digestibility."
    );

    expect(rankPapers([chicken], ["pork", "chicken", "protein quality"], intent).map((item) => item.sourceId)).toEqual(["chicken-value"]);
  });
});

describe("300-question regression suite", () => {
  const topics = [
    "커피", "차", "제로 탄산", "요거트", "케피어", "소시지", "가공육", "돼지고기", "닭고기", "계란",
    "우유", "견과류", "올리브유", "버터", "피톤치드", "블루라이트 안경", "간헐적 단식", "근력운동", "유산소 운동", "요가",
    "줄넘기", "실내자전거", "자전거 출퇴근", "저항밴드", "플랭크", "스마트폰 제한", "업무 메일", "칭찬", "수면", "명상",
    "프로바이오틱스", "비타민 D", "오메가3", "크레아틴", "단백질 보충제", "디카페인", "마운자로", "위고비", "탈모", "자세 교정",
    "목 통증", "안구 건조", "산림욕", "아로마", "녹차", "홍차", "소금", "카페인", "아스파탐", "수크랄로스"
  ];
  const forms = ["효과가 있을까?", "몸에 나쁠까?", "체중에 도움이 될까?", "장기적으로 괜찮을까?", "부작용이 있을까?", "정말 사실일까?"];
  const cases = topics.flatMap((topic) => forms.map((ending) => `${topic}은 ${ending}`));

  it("contains 300 distinct representative Korean questions", () => {
    expect(cases).toHaveLength(300);
    expect(new Set(cases).size).toBe(300);
  });

  it.each(cases)("renders grounded Korean evidence without topic leakage: %s", (question) => {
    const id = `topic-${cases.indexOf(question) + 1}`;
    const intent = causalIntent(id, "body weight");
    const papers = [
      paper(`${id}-1`, `${id} body weight systematic review`, `This systematic review included 24 trials and 2,032 participants. Body weight was significantly reduced by 1.2 kg compared with control.`),
      paper(`${id}-2`, `${id} body weight clinical trial`, `In a controlled trial, body weight was reduced by 0.8 kg compared with control.`),
      paper(`${id}-3`, `${id} body weight cohort study`, `Higher exposure was associated with lower body weight.`),
      paper(`${id}-4`, `${id} body weight meta-analysis`, `Across 16 studies, body weight was reduced by 0.6 kg.`)
    ];
    const answer = composeAnswer(question, evidenceFor(intent, papers), false);
    const text = formatAnswerForText(answer);

    expect(answer.citations.length).toBeGreaterThanOrEqual(3);
    expect(answer.citations.length).toBeLessThanOrEqual(5);
    expect(answer.citations.every((citation) => citation.url.startsWith("https://"))).toBe(true);
    expect(text).toContain("## 현재 판단");
    expect(text).toContain("## 연구 결과 한눈에 보기");
    expect(text).toMatch(/## 대표 논문 [3-5]편/);
    expect(text).not.toContain("질문에 직접 답하는 결과가 명확하게 보고되지 않았습니다");
    expect(text).not.toContain("제로 음료가 설탕 음료보다 더 나쁘다는 쪽은");
    expect(text).not.toContain("피톤치드 관련 연구는 있지만");
    expect(text).not.toContain("카더라 말고");
    expect(text).not.toMatch(/Based on the current|The study found|According to the/);
  });
});

function causalIntent(exposure: string, outcome: string): ResearchIntent {
  return {
    questionType: "causal",
    exposure,
    exposureTerms: [exposure],
    comparatorTerms: [],
    outcomeTerms: [outcome],
    populationTerms: [],
    timeHorizon: "unspecified",
    preferredStudyDesigns: ["systematic review", "randomized controlled trial"],
    directEvidenceGroups: [[exposure], [outcome]],
    evidenceStrategy: "direct_then_contextual",
    contextualEvidenceTerms: [`${exposure} ${outcome}`],
    directContextTerms: [exposure],
    parentEvidenceTerms: [`${exposure} ${outcome}`]
  };
}

function evidenceFor(
  intent: ResearchIntent,
  papers: Paper[],
  comparisonEvidenceScope?: "direct" | "parallel"
): EvidenceSearchResult {
  return {
    category: "health",
    queryTerms: [...intent.exposureTerms, ...intent.comparatorTerms, ...intent.outcomeTerms],
    researchIntent: intent,
    evidenceDirectness: "direct",
    comparisonEvidenceScope,
    retrievedPaperCount: papers.length,
    papers,
    sourceErrors: [],
    sourceTraces: []
  };
}

function paper(sourceId: string, title: string, abstract: string): Paper {
  return {
    source: "pubmed",
    sourceId,
    title,
    authors: ["Research Team"],
    year: 2025,
    url: `https://example.org/${sourceId}`,
    evidenceLevel: /review|meta-analysis/i.test(title) ? "systematic_review" : "clinical_study",
    abstract,
    abstract_excerpt: abstract,
    publicationTypes: /review|meta-analysis/i.test(title) ? ["Systematic Review"] : ["Clinical Trial"],
    raw: {}
  };
}
