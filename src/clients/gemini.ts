import type { Config } from "../config.js";
import { composeAnswer } from "../answer.js";
import {
  classifyPaperForIntent,
  matchesDirectIntent as sharedMatchesDirectIntent,
  matchesParallelComparisonIntent
} from "../evidence.js";
import { isBroadTopicQuestion } from "../text.js";
import { categories, type Category, type ClaimAnswer, type ClaimDirection, type EvidenceDetails, type EvidenceInterpretation, type EvidenceSearchResult, type EvidenceStance, type GlossaryEntry, type KeyStudyDetail, type Paper, type PracticalCheck, type ResearchIntent, type ResearchPattern, type ResearchStory, type Verdict } from "../types.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export interface ModelClaimJson {
  summary_ko?: unknown;
  answer_ko?: unknown;
  selected_citation_indices?: unknown;
  research_story?: {
    pattern?: unknown;
    conclusion_strength?: unknown;
    conclusion_ko?: unknown;
    opening_ko?: unknown;
    timeline_ko?: unknown;
    resolution_ko?: unknown;
  };
  detail?: {
    short_term_ko?: unknown;
    long_term_ko?: unknown;
    risk_ko?: unknown;
    applicability_ko?: unknown;
    limitations_ko?: unknown;
    key_studies?: Array<{
      citationIndex?: number;
      design_ko?: unknown;
      population_ko?: unknown;
      exposure_ko?: unknown;
      result_ko?: unknown;
      time_horizon?: unknown;
      limitation_ko?: unknown;
    }>;
  };
  verdict?: Verdict;
  limitations?: string[];
  practical_checks?: PracticalCheck[];
  evidence_interpretation?: Array<{
    citationIndex?: number;
    stance?: EvidenceStance;
    reason_ko?: string;
  }>;
}

interface GeminiSearchPlanJson {
  category?: Category;
  claim_direction?: ClaimDirection;
  intent?: {
    question_type?: string;
    exposure?: string;
    exposure_terms?: string[];
    comparator?: string;
    comparator_terms?: string[];
    outcome_terms?: string[];
    population_terms?: string[];
    time_horizon?: string;
    preferred_study_designs?: string[];
    direct_evidence_groups?: string[][];
    evidence_strategy?: string;
    contextual_evidence_terms?: string[];
    direct_context_terms?: string[];
    parent_evidence_terms?: string[];
  };
  reason_ko?: string;
}

interface GeminiEvidenceSelectionJson {
  selected_indices?: number[];
  reason_ko?: string;
}

const searchPlanResponseSchema = {
  type: "OBJECT",
  properties: {
    category: {
      type: "STRING",
      enum: categories.filter((category) => category !== "auto")
    },
    claim_direction: {
      type: "STRING",
      enum: ["benefit", "harm", "association", "unclear"],
      description: "Direction of the user's literal claim, not the evidence conclusion."
    },
    intent: {
      type: "OBJECT",
      properties: {
        question_type: {
          type: "STRING",
          enum: ["comparison", "causal", "association", "dosage", "safety", "diagnostic", "other"]
        },
        exposure: {
          type: "STRING",
          description: "The candidate cause, intervention, behavior, exposure, or predictor being evaluated; not the disease or outcome."
        },
        exposure_terms: {
          type: "ARRAY",
          items: { type: "STRING" },
          minItems: 1,
          maxItems: 4,
          description: "English scholarly synonyms for the candidate cause or predictor. For a brand, trade name, consumer product name, drug name, or acronym, include its canonical generic/active-ingredient or standard academic name. If the question states a dose, duration, timing, or frequency, one item must preserve that exact qualifier."
        },
        comparator: {
          type: "STRING",
          description: "Only an explicitly compared alternative exposure, intervention, or group. Omit when the user did not make a comparison."
        },
        comparator_terms: {
          type: "ARRAY",
          items: { type: "STRING" },
          maxItems: 2,
          description: "English scholarly synonyms for an explicit comparator; use an empty array when no comparator was stated."
        },
        outcome_terms: {
          type: "ARRAY",
          items: { type: "STRING" },
          minItems: 1,
          maxItems: 4,
          description: "The exact measured endpoint plus one broader accepted diagnosis or umbrella outcome commonly used in paper titles."
        },
        population_terms: { type: "ARRAY", items: { type: "STRING" }, maxItems: 2 },
        time_horizon: {
          type: "STRING",
          enum: ["acute", "short_term", "long_term", "mixed", "unspecified"]
        },
        preferred_study_designs: { type: "ARRAY", items: { type: "STRING" }, minItems: 1, maxItems: 3 },
        direct_evidence_groups: {
          type: "ARRAY",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "ARRAY",
            minItems: 1,
            maxItems: 4,
            items: { type: "STRING" }
          },
          description: "Two to four groups of English scholarly synonyms. A paper must match at least one term from every group to count as direct evidence. Include the exposure, requested outcome, and every essential relationship such as dose, timing, comparison, or joint consumption."
        },
        evidence_strategy: {
          type: "STRING",
          enum: ["direct_only", "direct_then_contextual"],
          description: "Use direct_then_contextual when direct human outcome studies about a named item or a food combination may be sparse."
        },
        contextual_evidence_terms: {
          type: "ARRAY",
          minItems: 1,
          maxItems: 3,
          items: { type: "STRING" },
          description: "Closest broader English scholarly queries for use only when exact evidence is absent. Preserve the main exposure category and requested outcome, but relax one narrow condition such as a precise dose, timing, comparator, country, or subgroup."
        },
        direct_context_terms: {
          type: "ARRAY",
          items: { type: "STRING" },
          maxItems: 3,
          description: "For direct_then_contextual only: scholarly searches that still name the exact item, such as its composition, exposure characterization, or biomarker evidence. Empty otherwise."
        },
        parent_evidence_terms: {
          type: "ARRAY",
          items: { type: "STRING" },
          maxItems: 3,
          description: "For direct_then_contextual only: broader human outcome or replacement evidence about the parent nutrient, mechanism, or category. Empty otherwise."
        }
      },
      required: [
        "question_type",
        "exposure",
        "exposure_terms",
        "comparator_terms",
        "outcome_terms",
        "population_terms",
        "time_horizon",
        "preferred_study_designs",
        "direct_evidence_groups",
        "evidence_strategy",
        "contextual_evidence_terms",
        "direct_context_terms",
        "parent_evidence_terms"
      ]
    }
  },
  required: ["category", "claim_direction", "intent"]
} as const;

const evidenceSelectionResponseSchema = {
  type: "OBJECT",
  properties: {
    selected_indices: {
      type: "ARRAY",
      items: { type: "INTEGER" },
      maxItems: 8,
      description: "One-based indices of only the papers that directly answer the exact research intent."
    },
    reason_ko: { type: "STRING" }
  },
  required: ["selected_indices"]
} as const;

const citationAuditResponseSchema = {
  type: "OBJECT",
  properties: {
    research_story: {
      type: "OBJECT",
      properties: {
        pattern: {
          type: "STRING",
          enum: ["evidence_shift", "ongoing_debate", "context_explains_difference", "mostly_consistent", "insufficient"]
        },
        conclusion_strength: {
          type: "STRING",
          enum: ["substantial", "moderate", "limited", "not_established", "uncertain"]
        },
        conclusion_ko: {
          type: "STRING",
          description: "One direct Korean sentence that answers the user with the conclusion and its strength before any evidence story."
        },
        opening_ko: { type: "STRING" },
        timeline_ko: { type: "STRING" },
        resolution_ko: { type: "STRING" }
      },
      required: ["pattern", "conclusion_strength", "conclusion_ko", "opening_ko", "timeline_ko", "resolution_ko"]
    },
    summary_ko: { type: "STRING" }
  },
  required: ["research_story", "summary_ko"]
} as const;

const rapidSynthesisResponseSchema = {
  type: "OBJECT",
  properties: {
    research_story: citationAuditResponseSchema.properties.research_story,
    summary_ko: { type: "STRING" },
    selected_citation_indices: {
      type: "ARRAY",
      minItems: 0,
      maxItems: 3,
      items: { type: "INTEGER" },
      description: "One-based indices of supplied papers. Use direct papers for direct evidence. When evidence_directness is contextual, select the closest topical papers and state the missing condition; do not return an empty array merely because the exact condition lacks a study."
    },
    verdict: {
      type: "STRING",
      enum: ["supported", "mixed", "not_supported", "insufficient_evidence"]
    }
  },
  required: ["research_story", "summary_ko", "selected_citation_indices", "verdict"]
} as const;

const fullSynthesisResponseSchema = {
  type: "OBJECT",
  properties: {
    research_story: citationAuditResponseSchema.properties.research_story,
    summary_ko: { type: "STRING" },
    detail: {
      type: "OBJECT",
      properties: {
        short_term_ko: { type: "STRING" },
        long_term_ko: { type: "STRING" },
        risk_ko: { type: "STRING" },
        applicability_ko: { type: "STRING" },
        limitations_ko: { type: "STRING" },
        key_studies: {
          type: "ARRAY",
          maxItems: 3,
          items: {
            type: "OBJECT",
            properties: {
              citationIndex: { type: "INTEGER" },
              design_ko: { type: "STRING" },
              population_ko: { type: "STRING" },
              exposure_ko: { type: "STRING" },
              result_ko: { type: "STRING" },
              time_horizon: { type: "STRING", enum: ["short_term", "long_term", "mixed", "unknown"] },
              limitation_ko: { type: "STRING" }
            },
            required: [
              "citationIndex",
              "design_ko",
              "population_ko",
              "exposure_ko",
              "result_ko",
              "time_horizon",
              "limitation_ko"
            ]
          }
        }
      },
      required: [
        "short_term_ko",
        "long_term_ko",
        "risk_ko",
        "applicability_ko",
        "limitations_ko",
        "key_studies"
      ]
    },
    verdict: {
      type: "STRING",
      enum: ["supported", "mixed", "not_supported", "insufficient_evidence"]
    },
    limitations: { type: "ARRAY", items: { type: "STRING" }, maxItems: 5 },
    evidence_interpretation: {
      type: "ARRAY",
      maxItems: 8,
      items: {
        type: "OBJECT",
        properties: {
          citationIndex: { type: "INTEGER" },
          stance: { type: "STRING", enum: ["supports", "opposes", "mixed", "unclear"] },
          reason_ko: { type: "STRING" }
        },
        required: ["citationIndex", "stance", "reason_ko"]
      }
    }
  },
  required: ["research_story", "summary_ko", "detail", "verdict", "limitations", "evidence_interpretation"]
} as const;

export interface SearchPlan {
  category: Exclude<Category, "auto">;
  queryTerms: string[];
  searchQueries: string[];
  intent?: ResearchIntent;
  claimDirection?: ClaimDirection;
  plannedBy: "host" | "gemini" | "openai" | "fallback";
  reason_ko?: string;
  /** Brand-to-ingredient pairs resolved while planning, carried through so the answer can explain its vocabulary. */
  glossary?: GlossaryEntry[];
}

export class GeminiRagClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.geminiApiKey);
  }

  async planSearch(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackTerms: string[]
  ): Promise<SearchPlan> {
    if (!this.config.geminiApiKey) {
      return {
        category: fallbackCategory,
        queryTerms: fallbackTerms,
        searchQueries: [],
        plannedBy: "fallback",
        reason_ko: "Gemini key 없음. 규칙 기반 검색어 사용."
      };
    }

    const payload = {
      question,
      allowed_categories: categories.filter((category) => category !== "auto"),
      vocabulary_candidates: fallbackTerms.slice(0, 14),
      rules: [
        "Analyze the research intent before retrieval; do not answer the claim.",
        "Set claim_direction from the user's literal claim: benefit, harm, association, or unclear. Do not infer it from expected evidence.",
        "Extract exposure, comparator, outcomes, population, time horizon, question type, and preferred evidence designs.",
        "If the question contains any number, dose, duration, timing, or frequency, one exposure_terms item MUST preserve that exact qualifier in English. Omitting or generalizing it is invalid; for 10분 걷기 include 10-minute walking, not only short-duration walking.",
        "Use accepted English scholarly terminology, not a literal translation of consumer wording.",
        "Resolve every brand name, trade name, consumer product name, medication brand, supplement brand, or acronym before retrieval. exposure_terms MUST include its canonical generic name, active ingredient, or standard scholarly entity in English. For example, a medication brand must be searched by its active ingredient and drug class, not only by the brand spelling. This is mandatory even when the Korean consumer name is unfamiliar.",
        "For safety or side-effect questions, include a concrete safety endpoint in outcome_terms such as adverse events, drug safety, gastrointestinal adverse events, pancreatitis, or the symptom the user names. Do not use only a vague term such as health effects.",
        "For a broad medication side-effect question with no named symptom, search the overall safety profile first: include adverse events, serious adverse events, and drug safety; include gastrointestinal adverse events when relevant. Do not narrow the plan to a rare organ-specific event unless the user specifically asks about that event.",
        "For a broad topic question such as '마테차 효능이 궁금해' or '간헐적 단식에 대해 궁금해', there is no single outcome to force-match. Keep direct_evidence_groups to the resolved exposure itself, set outcome_terms to an empty array, use direct_only, and retrieve topic-level systematic reviews plus representative human studies. Do not turn this into a 'direct comparison evidence is insufficient' answer.",
        "Return direct_evidence_groups for every question. These are the separate concepts that a paper must all contain before it can directly answer the user. Put every synonym, brand name, generic name, active ingredient, acronym, singular/plural form, and spelling variant for the SAME concept in one group; never make equivalent names separate required groups. Create a new group only for a distinct condition explicitly stated in the user's claim. Do not add a plausible alternative intervention, co-intervention, treatment, diet, or comparator that the user did not name. For a question about two things together, make the joint-exposure relationship its own group; for a comparison, make the comparator its own group; for a dose or time question, preserve that condition in its exposure terms. Study design, population, and a broad background label are not required groups unless the user explicitly asks about them.",
        "For a Korean form such as 'X만으로 가능한가', X is the exposure and the remaining goal is the outcome. Do not reinterpret a goal word such as 다이어트 as an unstated dietary intervention, and do not invent exercise, diet, or treatment alternatives as a comparator.",
        "Always return contextual_evidence_terms. These are the closest broader scholarly questions to use only after exact evidence is absent. Preserve the main intervention/exposure and outcome, but relax only the unusually narrow detail such as an exact dose, schedule, comparison, country, occupation, or subgroup. For example, a question about two coffees at once versus spaced coffees and anxiety may use 'caffeine acute anxiety dose response'; a question about a foreign school policy applying to Korean students may use 'school smartphone restriction adolescent outcomes'. Never return a vague category such as 'health effects'.",
        "Choose education for teaching, learning, school, or language-instruction questions even when participants are children; choose childcare for infant care, feeding, parenting, or developmental-screening concerns.",
        "Use vocabulary_candidates when they are accurate, but discard irrelevant candidates.",
        "For a comparison, keep exposure and comparator separate and provide 2 to 4 synonyms for each.",
        "Do not invent a comparator for a yes/no association or causality question. Comparator is optional unless the user actually compares two exposures, interventions, or groups.",
        "For questions meaning 'Is X genetic or hereditary?', genetic susceptibility, heritability, or genetic factors are the exposure and X is the outcome; X is not the exposure and genetics is not the comparator.",
        "Example: for '비만은 유전일까?', use exposure_terms [genetic factors, genetic susceptibility, heritability], comparator_terms [], and outcome_terms [obesity, body mass index].",
        "For broad multifactorial questions, include evidence designs that can estimate contribution or causality, such as twin/family studies, genome-wide association studies, Mendelian randomization, and systematic reviews when appropriate.",
        "Use evidence_strategy direct_then_contextual only when a named niche item is genuinely unlikely to have direct human outcome studies. direct_context_terms must keep the exact named item and name a measurable characterization such as composition, biomarker, dose, co-ingestion, or oxidation; do not use a bare 'X consumption' term. parent_evidence_terms must join a specific parent nutrient or mechanism with a concrete human outcome or replacement comparison; never return vague labels such as 'health effects' or 'health risks'. These are a fallback evidence ladder, not proof that the broader evidence directly studied the named item. Use direct_only with both arrays empty whenever the user asks about a common exposure, intervention, disease, or comparison that has an established scholarly study category after entity resolution.",
        "For a comparison, do not use direct_then_contextual merely because the user names a consumer product or everyday form. Resolve both sides to their scientific exposure categories first, then use direct_only when human comparative studies are normally available. The direct evidence groups must include both sides and the requested endpoint.",
        "For a question asking whether two ordinary foods, drinks, or supplements are harmful together, treat it as a possible food-combination belief, not as proof of an interaction. Use direct_then_contextual when pair-specific human outcome studies are sparse. exposure_terms must name both items and co-ingestion or combined consumption. direct_context_terms must test the exact pair through co-ingestion, digestibility, tolerance, nutrient bioavailability, or another concrete mechanism. parent_evidence_terms may cover only a plausible individual risk factor relevant to the pair, such as food allergy, intolerance, foodborne illness, or nutrient-drug interaction. Never use the individual risk-factor evidence as proof that the pair itself is harmful. If pair-specific evidence is absent, the eventual conclusion must say that the harmful interaction is not established, not that safety has been proven.",
        "For an ordinary food-combination belief, do not use treatment-only evidence as contextual evidence: exclude oral immunotherapy, allergen desensitization, probiotic or prebiotic treatment, and supplement interventions unless the user asks about that treatment. Contextual evidence must describe ordinary consumption or a diagnosed condition that would independently change whether one of the foods can be eaten.",
        "Outcome terms must be only the endpoint the user asks to change, not a baseline condition, covariate, or reason for the exposure.",
        "Include the exact endpoint and one broader accepted umbrella term used in titles when applicable, such as sleep onset latency plus insomnia, or blood pressure plus hypertension.",
        "Example: for 'Does a 30-minute nap worsen nighttime sleep quality?', napping is the exposure and nighttime sleep quality is the outcome; sleep deprivation is not the outcome.",
        "Every *_terms value must be an English database concept, not a sentence or a conclusion.",
        "Return strict JSON matching the schema."
      ],
      fallback_category: fallbackCategory
    };

    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a retrieval planner for a Korean evidence-based claim checker. " +
                "You turn Korean user claims into precise English scholarly database search terms. " +
                "You resolve brand and consumer names to their generic, active-ingredient, or canonical academic entity before returning terms. " +
                "You never answer the claim in this step."
            }
          ]
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 450,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: searchPlanResponseSchema
        }
      })
    });

    if (!response.ok) throw new Error(`Gemini search planning failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini search planning returned empty text");

    return buildSearchPlanFromModel(
      parseGeminiJson(text),
      question,
      fallbackCategory,
      fallbackTerms,
      "gemini"
    );
  }

  async synthesizeClaim(question: string, evidence: EvidenceSearchResult, fallback: ClaimAnswer): Promise<ClaimAnswer> {
    if (!this.config.geminiApiKey) return fallback;
    if (evidence.papers.length === 0) return fallback;

    const synthesisEvidence = evidenceForCitations(evidence, fallback);
    const payload = buildClaimSynthesisPayload(question, synthesisEvidence, fallback);

    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a Korean evidence synthesis layer for a research-backed claim checker. " +
                "Think of the evidence items as the only books on your desk. " +
                "Your job is to explain what those books say in Korean, including whether older and newer papers differ. " +
                "Return strict JSON only. Ground every conclusion in the provided evidence list."
            }
          ]
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 2_200,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: fullSynthesisResponseSchema
        }
      })
    });

    if (!response.ok) throw new Error(`Gemini RAG synthesis failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini RAG synthesis returned empty text");

    const draft = parseGeminiJson(text) as ModelClaimJson;
    const audited = await this.auditClaimDraft(question, synthesisEvidence, draft).catch(() => draft);
    return mergeModelAnswer(audited, fallback, synthesisEvidence);
  }

  async synthesizeRapidClaim(question: string, evidence: EvidenceSearchResult, fallback: ClaimAnswer): Promise<ClaimAnswer> {
    if (!this.config.geminiApiKey || evidence.papers.length === 0) return fallback;
    const synthesisEvidence = evidenceForCitations(evidence, fallback);
    if (!synthesisEvidence.papers.some((paper) => paper.abstract?.trim())) return fallback;
    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text:
              "You write the first concise Korean answer for a research-backed claim checker. " +
              "Use only the supplied paper titles and abstracts, answer the user's exact outcome, and return strict JSON."
          }]
        },
        contents: [{
          role: "user",
          parts: [{
            text: JSON.stringify({
              question,
              research_intent: evidence.researchIntent,
              comparison_evidence_scope: evidence.comparisonEvidenceScope,
              evidence_directness: evidence.evidenceDirectness,
              rules: [
                "Answer the question directly in the first sentence; never mention caches, background work, retrieval, ranking, metadata, or system limitations.",
                "Set research_story.conclusion_strength and write research_story.conclusion_ko as the first direct Korean answer. For a yes/no, cause, or degree question, it must state the bottom-line direction and strength: substantial, moderate, limited, not established, or uncertain. Do not replace that judgment with a hook, a mechanism list, or a vague statement that factors are complex.",
                "For a genetic or hereditary question, explicitly state whether the genetic contribution is substantial, moderate, limited, or not established, and identify the phenotype and population to which that judgment applies. Genetic predisposition is not inevitability; distinguish disease subtypes or populations when the supplied evidence differs.",
                "Set selected_citation_indices before writing the answer. When evidence_directness is direct, select only papers that directly study the user's exact exposure, outcome, and subtype. When evidence_directness is contextual, select the closest supplied papers that preserve the main topic and outcome, and explain the missing condition instead of returning an empty selection. A merely adjacent condition, a different subtype, or a paper where the question topic is only a background risk factor must not be selected.",
                "If research_intent names a specific mode, subtype, form, or variant, use a paper whose title explicitly names that variant for the main conclusion whenever one is supplied. A broader paper can be secondary context, but its overall study count or overall result must not be reassigned to the variant.",
                "When comparison_evidence_scope is parallel, select papers only when they study one named option and the requested outcome. Select evidence for both options whenever supplied. Say that head-to-head evidence is insufficient, then report each option's finding separately with its citation. Do not use those papers to name a winner.",
                "For a food-protein comparison, 'better' can mean protein amount, essential-amino-acid supply, digestibility, or muscle response. Name a winner only when a supplied abstract explicitly reports an option-level difference on the requested measure. A paper that compares cooking or processing conditions without reporting pork-versus-chicken (or the named foods') result does not settle which food is better.",
                "When a food comparison result comes from an animal assay, a laboratory digestion assay, or a food-composition analysis, name that condition in Korean and do not present it as a human clinical outcome.",
                "When evidence_directness is contextual, the exact dose, schedule, location, subgroup, or comparison was not directly studied. Select only the closest broader papers supplied, state the missing condition, and explain their actual findings without presenting them as direct proof of the exact question.",
                "When evidence_directness is contextual and at least one supplied paper matches the main topic and outcome, selected_citation_indices must contain at least one such paper. Do not answer only that research is needed: state one actual finding from the selected paper with its citation.",
                "When research_intent has an empty outcome_terms array, this is a broad topic question rather than a missing comparison. Select topic-level reviews first. Report the measured domains separately, and never turn a disease-specific, biomarker-specific, or short-term finding into a claim that the exposure improves overall health.",
                "The evidence list is ranked by relevance before you see it. For the rapid answer, select only from the first three items; do not skip to a lower-ranked paper when a higher-ranked paper addresses the same topic.",
                "Reject a paper as direct evidence when the user's exposure or outcome is only a covariate, subgroup, or background phrase.",
                "Separate duration, dose, timing, population, acute effects, and long-term associations when they explain apparently different findings.",
                "State association rather than causation for observational evidence.",
                "Never infer a study result from its title. A paper without an abstract or result text can establish that a study exists, but cannot support or oppose the claim.",
                "If every supplied paper lacks result text, use insufficient_evidence and say the direction cannot be verified from the available metadata.",
                "When research_intent.evidenceStrategy is direct_then_contextual, do not stop at 'no papers found.' State that direct long-term human outcome evidence for the named item is limited, then distinguish exact-item characterization from broader parent-nutrient or replacement evidence. Never call the broader evidence direct proof about the named item.",
                "Use only supplied years, findings, numbers, and citation indices. Never invent a statistic or source.",
                "Use findings, study counts, and citation indices only from selected_citation_indices. If selected_citation_indices is empty, use insufficient_evidence and do not borrow a result from a related paper.",
                "When the supplied evidence includes a study count, participant count, effect size, confidence interval, or follow-up duration, lead the evidence paragraph with the strongest relevant number and what it measures.",
                "Never use a standalone phrase such as 'several reviews' or 'three papers support this'. Tie any study count directly to the reported result, for example '72 studies and 50,000 participants found ...'.",
                "For the initial mobile answer, never use study-method labels such as systematic review, meta-analysis, RCT, cohort, or their Korean equivalents. Explain what the research found, not the name of the method.",
                "Do not repeat the conclusion. Use the final paragraph only for an important exception, trade-off, or limit directly reported in the supplied evidence.",
                "Write two or three short Korean paragraphs under 650 characters, with valid citation indices such as [1].",
                "Every user-visible JSON field must be Korean. Never paste an English abstract sentence, including in key_studies.result_ko. If a finding cannot be safely paraphrased in Korean, state that the specific result could not be confirmed instead."
              ],
              fallback_verdict: fallback.verdict,
              evidence: synthesisEvidence.papers.slice(0, 5).map(toLlmEvidence)
            })
          }]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 650,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: rapidSynthesisResponseSchema
        }
      })
    });
    if (!response.ok) throw new Error(`Gemini rapid synthesis failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini rapid synthesis returned empty text");
    const draft = parseGeminiJson(text) as ModelClaimJson;
    const selected = selectRapidEvidence(draft, synthesisEvidence);
    if (!selected) return mergeModelAnswer(draft, fallback, synthesisEvidence);
    if (selected.evidence.papers.length === 0) {
      // The retriever has already ranked these papers as direct, parallel, or
      // transparent contextual evidence. A model declining all citations must
      // not erase that evidence and turn a useful answer into a blank result.
      return fallback;
    }

    const selectedFallback = composeAnswer(question, selected.evidence, fallback.cached);
    return mergeModelAnswer(
      reindexModelCitationRefs(draft, selected.indexMap),
      selectedFallback,
      selected.evidence
    );
  }

  async selectCoreEvidence(question: string, evidence: EvidenceSearchResult, limit = 8): Promise<EvidenceSearchResult> {
    if (!this.config.geminiApiKey || evidence.papers.length === 0) return evidence;
    // Never ask the model to choose from papers that the shared retrieval
    // contract has already ruled out. The model ranks eligible evidence; it
    // does not get a second, looser interpretation of relevance.
    const rankedCandidates = evidence.papers
      .filter((paper) => classifyPaperForIntent(paper, evidence.researchIntent) !== "reject")
      .slice(0, 10);
    if (rankedCandidates.length === 0) return { ...evidence, papers: [] };
    const overviewCandidates = selectTopicOverviewEvidence(question, rankedCandidates, limit, evidence.researchIntent);
    // A broad question needs an overview for its overall conclusion, but the
    // overview alone can hide a useful direct human study in another outcome
    // domain. Keep both sets and let the evidence-selection gate weigh them.
    const candidates = overviewCandidates.length > 0
      ? uniqueCandidatePapers([...overviewCandidates, ...rankedCandidates]).slice(0, 10)
      : rankedCandidates;
    const payload = {
      question,
      research_intent: evidence.researchIntent,
      comparison_evidence_scope: evidence.comparisonEvidenceScope,
      evidence_directness: evidence.evidenceDirectness,
      rules: [
      "When evidence_directness is direct, select only papers that directly investigate the exact research intent. When evidence_directness is contextual, select the closest papers that preserve the main topic and requested outcome, then retain the missing dose, schedule, location, subgroup, or comparison as an explicit limitation.",
      "When comparison_evidence_scope is parallel, there is no verified head-to-head study. Select only papers that study one named option and the requested outcome, preferably covering both options; do not treat them as a comparison and do not choose a winner.",
      "When evidence_directness is contextual, the exact narrow condition was not directly studied. Select only the closest broader papers that preserve the main topic and outcome, and do not describe them as direct evidence of the missing condition.",
      "Treat the model-generated research intent as a contract. When the intent is about two exposures taken together, a paper about either exposure alone, or about a treatment for a condition involving one exposure, does not answer the question unless the intent itself explicitly identifies that condition as a separate exception to explain.",
      "When the intent names a specific mode, subtype, form, or variant, prefer a candidate whose title explicitly names it. A broader intervention review may be selected as secondary context only; never treat its global count or global result as a result for the variant merely because the variant appears in the abstract.",
      "A paper is not direct merely because exposure and outcome words both appear in its abstract.",
      "Reject papers whose primary outcome is another disease or whose queried concept is only a covariate, instrument, background statement, or subgroup label.",
      "Reject descriptive prevalence or sleep-habit papers when disease risk appears only in the introduction and is not an analyzed result.",
      "Reject a broad narrative review centered on a different occupational or patient subgroup when a more direct systematic review is available.",
      "For a broad topic question such as '간헐적 단식에 대해 궁금해', reject a narrow single-outcome primary study unless it adds a decision-critical caveat to the topic-level evidence.",
      "Prefer direct systematic reviews, meta-analyses, strong primary studies, and representative newer evidence; do not select by recency alone.",
      "When research_intent.evidenceStrategy is direct_then_contextual, select a transparent two-layer set only when the contextual paper directly matches a condition or mechanism the intent explicitly authorizes. Do not pretend the second layer directly studied the named item. Return an empty list rather than filling the answer with a merely adjacent paper.",
      "Review the whole candidate set before selecting. Select up to eight direct papers so the later synthesis can weigh broad evidence, conflicting evidence, and important population or time differences. Do not fill eight slots. Return an empty list when no paper satisfies the exact intent contract.",
        "Return one-based indices from the supplied candidates and strict JSON only."
      ],
      candidates: candidates.map(toLlmEvidence)
    };
    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You are the evidence-selection gate for a scholarly claim checker. You select papers; you do not answer the claim." }]
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 180,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: evidenceSelectionResponseSchema
        }
      })
    });
    if (!response.ok) throw new Error(`Gemini evidence selection failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini evidence selection returned empty text");
    const selection = parseGeminiJson(text) as GeminiEvidenceSelectionJson;
    if (!Array.isArray(selection.selected_indices)) throw new Error("Gemini evidence selection returned invalid indices");
    const overviewKeys = new Set(overviewCandidates.map((paper) => `${paper.source}:${paper.sourceId}`));
    const restrictToOverview = isBroadTopicQuestion(question) && overviewKeys.size > 0;
    const isEligibleCandidate = (paper: Paper) =>
      (!restrictToOverview || overviewKeys.has(`${paper.source}:${paper.sourceId}`)) &&
      paperMatchesSelectableIntent(paper, evidence);
    const indices = [...new Set(selection.selected_indices)]
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= candidates.length)
      .filter((index) => isEligibleCandidate(candidates[index - 1]!))
      .slice(0, Math.max(1, Math.min(limit, 8)));
    const eligibleIndices = candidates
      .map((_paper, index) => index + 1)
      .filter((index) => isEligibleCandidate(candidates[index - 1]!));
    // The answer renderer decides how many papers the user sees. Keep a
    // wider, role-diverse evidence set here so its conclusion can weigh more
    // than the three representative citations shown in chat.
    const targetCount = Math.min(8, eligibleIndices.length, limit);
    // The model may decline to choose a broad contextual bridge because it is
    // not exact-item proof. That is the right caution for a verdict, but not
    // a reason to discard the retrieved papers altogether. The deterministic
    // eligibility contract has already separated direct/contextual/rejected
    // papers, so keep eligible material for the renderer to label honestly.
    if (evidence.researchIntent) {
      for (const index of eligibleIndices) {
        if (indices.length >= targetCount) break;
        if (!indices.includes(index)) indices.push(index);
      }
    }
    if (evidence.researchIntent?.evidenceStrategy === "direct_then_contextual") {
      return {
        ...evidence,
        papers: selectEvidenceLadderPapers(candidates, indices, evidence.researchIntent, limit)
      };
    }
    return { ...evidence, papers: indices.map((index) => candidates[index - 1]!).filter(Boolean) };
  }

  private async auditClaimDraft(
    question: string,
    evidence: EvidenceSearchResult,
    draft: ModelClaimJson
  ): Promise<ModelClaimJson> {
    const draftSummary = {
      research_story: draft.research_story,
      summary_ko: draft.summary_ko ?? draft.answer_ko
    };
    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text:
              "You are a strict citation auditor. Correct only the three-paragraph Korean research story by comparing it with supplied abstracts. " +
              "Do not add claims and return strict JSON."
          }]
        },
        contents: [{
          role: "user",
          parts: [{
            text: JSON.stringify({
              question,
              rules: [
                "Check every increase/decrease, higher/lower, benefit/harm, association/no-association, population, study design, year, and number against the cited abstract.",
                "Preserve research_story.conclusion_strength and keep research_story.conclusion_ko as a direct, evidence-grounded Korean conclusion sentence before the evidence story.",
                "Never reverse a direction word. If the abstract says increased, the Korean draft must not say decreased, and vice versa.",
                "Preserve association versus causation and absolute versus relative effects.",
                "When an abstract contains nuanced or apparently conflicting statements, use the explicit numeric result and remove an oversimplified directional gloss.",
                "Keep only citation indices present in the supplied evidence. Return strict JSON only."
              ],
              draft: draftSummary,
              evidence: evidence.papers.map((paper, index) => ({
                citationIndex: index + 1,
                title: paper.title,
                year: paper.year,
                evidenceLevel: paper.evidenceLevel,
                publicationTypes: paper.publicationTypes,
                abstract: trimForPrompt(paper.abstract, 1000)
              }))
            })
          }]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 1100,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: citationAuditResponseSchema
        }
      })
    });
    if (!response.ok) throw new Error(`Gemini citation audit failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini citation audit returned empty text");
    const audited = parseGeminiJson(text) as ModelClaimJson;
    return {
      ...draft,
      research_story: audited.research_story ?? draft.research_story,
      summary_ko: audited.summary_ko ?? draft.summary_ko
    };
  }
}

function selectEvidenceLadderPapers(
  candidates: Paper[],
  selectedIndices: number[],
  _intent: ResearchIntent,
  limit: number
): Paper[] {
  const selected = selectedIndices.map((index) => candidates[index - 1]!).filter(Boolean);
  const seen = new Set<string>();
  return selected.filter((paper) => {
    const key = `${paper.source}:${paper.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(1, Math.min(limit, 8)));
}

function paperMatchesAnyConcept(paper: Paper, concepts: string[], minimumTokenHits = 2): boolean {
  const text = ` ${`${paper.title} ${paper.abstract ?? ""}`.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return concepts.some((concept) => {
    const phrase = concept.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
    if (phrase && text.includes(` ${phrase} `)) return true;
    const tokens = phrase.split(" ").filter((token) => token.length >= 4);
    const requiredHits = Math.min(minimumTokenHits, tokens.length);
    return requiredHits > 0 && tokens.filter((token) => text.includes(` ${token}`)).length >= requiredHits;
  });
}

function selectTopicOverviewEvidence(
  question: string,
  candidates: Paper[],
  limit: number,
  intent?: ResearchIntent
): Paper[] {
  if (!isBroadTopicQuestion(question)) return [];
  const scored = candidates
    .filter(isTopicReview)
    .filter((paper) => !/(?:corrigendum|review for|protocol|intermittent hypoxia|exercise combined|combined with exercise)/i.test(paper.title))
    .filter((paper) => !/\b(?:molecular modeling|in silico|animal model|mouse|mice|rat|rats|cell line|in vitro|in vivo)\b/i.test(paper.title))
    .map((paper) => ({ paper, score: topicOverviewScore(paper, intent) }))
    .filter((item) => item.score > 0);
  const bestScore = Math.max(...scored.map((item) => item.score), 0);
  return scored
    .filter((item) => item.score === bestScore)
    .map((item) => item.paper)
    .slice(0, Math.max(1, Math.min(limit, 8)));
}

function uniqueCandidatePapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = `${paper.source}:${paper.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTopicReview(paper: Paper): boolean {
  return paper.evidenceLevel === "systematic_review" ||
    /\b(?:review|meta[ -]?analysis|umbrella review)\b/i.test(`${paper.title} ${paper.publicationTypes.join(" ")}`);
}

function topicOverviewScore(paper: Paper, intent: ResearchIntent | undefined): number {
  if (!intent) return paper.evidenceLevel === "systematic_review" ? 1 : 0;
  const title = normalizeOptionText(paper.title);
  const abstract = normalizeOptionText(paper.abstract ?? "");
  if (intent.exposureTerms.some((term) => title.includes(normalizeOptionText(term)))) return 100;
  const semanticScore = Math.max(0, ...(intent.contextualEvidenceTerms ?? []).map((term) => {
    const tokens = normalizeOptionText(term).split(" ").filter((token) => token.length >= 4);
    if (tokens.length === 0) return 0;
    return tokens.filter((token) => title.includes(token)).length;
  }));
  const exactTopicMention = intent.exposureTerms.some((term) => abstract.includes(normalizeOptionText(term)));
  return semanticScore + (exactTopicMention ? 50 : 0);
}

export function evidenceForCitations(evidence: EvidenceSearchResult, fallback: ClaimAnswer): EvidenceSearchResult {
  const papers = fallback.citations
    .map((citation) =>
      evidence.papers.find(
        (paper) =>
          (paper.source === citation.source && paper.sourceId === citation.sourceId) ||
          (Boolean(citation.doi) && paper.doi?.toLowerCase() === citation.doi?.toLowerCase()) ||
          paper.title.trim().toLowerCase() === citation.title.trim().toLowerCase()
      )
    )
    .filter((paper): paper is Paper => Boolean(paper));

  return {
    ...evidence,
    papers: papers.length > 0 ? papers : evidence.papers.slice(0, fallback.citations.length)
  };
}

function selectRapidEvidence(
  draft: ModelClaimJson,
  evidence: EvidenceSearchResult
): { evidence: EvidenceSearchResult; indexMap: Map<number, number> } | undefined {
  if (!Array.isArray(draft.selected_citation_indices)) return undefined;
  const eligibleIndices = evidence.papers
    .map((_paper, index) => index + 1)
    .filter((index) => paperMatchesSelectableIntent(evidence.papers[index - 1]!, evidence))
    .slice(0, 8);
  const directTrialIndices = eligibleIndices.filter((index) =>
    isDirectRandomizedComparison(evidence.papers[index - 1]!, evidence)
  );
  const selectedIndices = [...new Set(draft.selected_citation_indices)]
    .map(Number)
    .filter((index) => eligibleIndices.includes(index))
    .slice(0, 3);
  for (const index of directTrialIndices) {
    if (selectedIndices.length >= 3) break;
    if (!selectedIndices.includes(index)) selectedIndices.push(index);
  }
  // A fast model can name one primary citation even when retrieval has already
  // confirmed several direct papers. Preserve a small set of independently
  // relevant studies so the answer does not look as if one paper settled it.
  if (selectedIndices.length > 0) {
    for (const index of eligibleIndices) {
      const targetCount = Math.min(evidence.researchIntent ? 3 : 2, eligibleIndices.length);
      if (selectedIndices.length >= targetCount) break;
      if (!selectedIndices.includes(index)) selectedIndices.push(index);
    }
  }
  if (directTrialIndices.length > 0) {
    selectedIndices.sort((left, right) => {
      const leftPriority = directTrialIndices.includes(left) ? 1 : 0;
      const rightPriority = directTrialIndices.includes(right) ? 1 : 0;
      return rightPriority - leftPriority || left - right;
    });
  }
  const indexMap = new Map(selectedIndices.map((index, selectedIndex) => [index, selectedIndex + 1]));
  return {
    evidence: {
      ...evidence,
      papers: selectedIndices.map((index) => evidence.papers[index - 1]!).filter(Boolean)
    },
    indexMap
  };
}

function isDirectRandomizedComparison(paper: Paper, evidence: EvidenceSearchResult): boolean {
  if (evidence.researchIntent?.questionType !== "comparison" || evidence.comparisonEvidenceScope !== "direct") return false;
  if (paper.evidenceLevel !== "clinical_study") return false;
  const text = `${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`.toLowerCase();
  return /\b(?:randomi[sz]ed|randomi[sz]ation|phase\s*(?:ii|2|iii|3)|controlled trial)\b/.test(text) &&
    /\b(?:versus|vs\.?|compared with|compared to|comparison)\b/.test(text);
}

function reindexModelCitationRefs(draft: ModelClaimJson, indexMap: Map<number, number>): ModelClaimJson {
  const reindexText = (value: string) => value.replace(/\[(\d+)\]/g, (match, rawIndex) => {
    const selectedIndex = indexMap.get(Number(rawIndex));
    return selectedIndex ? `[${selectedIndex}]` : "";
  });
  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return reindexText(value);
    if (typeof value === "number" && key === "citationIndex") return indexMap.get(value) ?? value;
    if (Array.isArray(value)) {
      if (key === "selected_citation_indices") {
        return value.map(Number).map((index) => indexMap.get(index)).filter((index): index is number => Boolean(index));
      }
      return value.map((item) => visit(item));
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, visit(entryValue, entryKey)]));
  };
  return visit(draft) as ModelClaimJson;
}

export function buildClaimSynthesisPayload(question: string, evidence: EvidenceSearchResult, fallback: ClaimAnswer): Record<string, unknown> {
  return {
    question,
    category: evidence.category,
    research_intent: evidence.researchIntent,
    comparison_evidence_scope: evidence.comparisonEvidenceScope,
    evidence_directness: evidence.evidenceDirectness,
    allowed_verdicts: ["supported", "mixed", "not_supported", "insufficient_evidence"],
    rules: [
      "Use only the provided evidence items. Never invent findings, statistics, institutions, or citations.",
      "Normalize the user's exact claim and judge every stance relative to that claim, including negation, sarcasm, comparisons, and multiple subclaims.",
      "When comparison_evidence_scope is parallel, no supplied paper directly compares the two options. State that direct head-to-head evidence is insufficient, then explain each option's actual result separately with citations when available. Do not declare either option better, safer, or more effective.",
      "For a food-protein comparison, 'better' can refer to protein amount, essential-amino-acid supply, digestibility, or muscle response. Name a winner only when a supplied abstract explicitly reports a difference between the named foods on that measure. A study that compares cooking or processing but gives no food-versus-food result does not settle the user's question.",
      "When a food comparison result comes from an animal assay, a laboratory digestion assay, or food-composition analysis, name that condition in Korean and do not present it as a human clinical outcome.",
      "When evidence_directness is contextual, the exact dose, schedule, location, subgroup, or comparison was not directly studied. Lead by naming that missing condition, then use the closest supplied topic evidence to explain what is known. Never call that broader result direct proof of the exact question.",
      "When the question names a specific mode, subtype, form, or variant of an intervention, a broader paper may provide context but cannot supply its study-wide result, study count, or conclusion for that specific variant. Prefer a paper whose title explicitly names the requested variant for the main conclusion. If a broad paper only mentions the variant in its abstract, quote only the variant-specific result from that paper.",
      "Weight evidence by directness to the exact question, study design, recency, sample/population fit, and consistency. Do not choose the newest paper merely because it is newest.",
      "When research_intent.evidenceStrategy is direct_then_contextual, do not return a blank answer merely because direct long-term human outcome research on the named item is scarce. Lead by saying that direct item-specific outcome evidence is limited, then separately explain (1) what exact-item characterization evidence reports and (2) what the broader parent-nutrient or replacement evidence reports. Never describe layer 2 as direct proof about the named item.",
      "When research_intent.outcomeTerms is empty, this is a broad topic question. It has no single endpoint to force-match: give the overall conclusion only at the strength supported across the selected papers, then name the specific measured domains separately. A disease-specific, biomarker-specific, or short-term result must not become a general-health claim.",
      "Distinguish acute effects from long-term outcomes, association from causation, and healthy populations from disease or medication subgroups.",
      "The product is different from a generic chatbot because the first answer tells the story of the evidence debate, not just a polished conclusion.",
      "For every question, set research_story.conclusion_strength and write research_story.conclusion_ko as one direct Korean sentence before the evidence story. For a yes/no, cause, or degree question, it must state the bottom-line direction and strength: substantial, moderate, limited, not established, or uncertain. Do not substitute a memorable hook, a mechanism list, or a vague statement that factors are complex for that judgment.",
      "For a genetic or hereditary question, research_story.conclusion_ko must explicitly state whether the genetic contribution is substantial, moderate, limited, or not established, and name the phenotype and population to which it applies. Genetic predisposition is not inevitability; when supplied evidence differs by subtype or population, state that distinction before describing the studies.",
      "Classify research_story.pattern as evidence_shift, ongoing_debate, context_explains_difference, mostly_consistent, or insufficient.",
      "Use evidence_shift only when older and newer comparable studies genuinely point in different directions. If acute versus long-term outcomes, populations, dose, or design explain the apparent conflict, use context_explains_difference instead.",
      "After giving the required conclusion, research_story.opening_ko may add a memorable, conversational but professional one- or two-sentence framing such as '둘 다 절반씩 맞습니다' or '논문 흐름이 중간에 바뀌었습니다'. Do not use the same hook mechanically for every question.",
      "research_story.timeline_ko must compare 2 to 3 supplied key papers in chronological order. State the actual finding and valid citation index. Mention year only when it explains a change in the evidence.",
      "research_story.resolution_ko must decide which everyday claim is closer to the evidence and explain the decisive condition: population, dose, acute versus long-term outcome, or study design.",
      "summary_ko must be exactly research_story.opening_ko, timeline_ko, and resolution_ko joined as three compact Korean paragraphs, under 750 Korean characters.",
      "Do not add generic medical-template advice or side topics such as pregnancy, emergency symptoms, sugar or cream, sleep, or anxiety unless the user's question asks about them and a supplied key study directly reports them.",
      "Do not include full paper titles, retrieval counts, query terms, rankings, metadata status, source traces, or study-method labels in summary_ko. Use actual findings and citation indices; mention year only when it explains a change in the evidence.",
      "Use a concrete effect size in the timeline when it is supplied and helps explain the disagreement. Never invent or calculate a number that is absent from the evidence.",
      "When a key paper compares the exposure both with no intervention and with an active alternative, separate those two comparisons. The decisive takeaway must say whether the exposure is actually better than the active alternative, rather than treating every change from no intervention as a unique advantage.",
      "Do not turn one positive primary study into a long-term conclusion when a broader synthesis is uncertain or finds little to no effect. In that case, the synthesis sets the overall conclusion and the primary study is described as an individual, conflicting result.",
      "Use a long-term label only when the supplied study actually has a long follow-up. A study lasting a few weeks or months cannot establish a long-term effect by itself.",
      "When a supplied abstract includes a study count or participant count, connect that scale directly to the result. Do not write a standalone count of reviews or papers as a trust signal.",
      "Preserve every reported direction exactly. Never turn increased into decreased, higher into lower, benefit into harm, or association into causation.",
      "If a source reports a numeric direction and then gives a nuanced interpretation, state the numeric result and retain the nuance instead of simplifying them into the opposite direction.",
      "Organize detail by the user's decision axes: short-term effect when reported, long-term effect, concrete magnitude or observed changes, applicability, and limitations. Do not narrate papers one by one in those sections.",
      "The detail fields are shown to users in full and are not a mobile summary. Preserve useful substance: when the supplied evidence gives a number, participant count, comparison condition, duration, or a specific outcome, explain it in a complete Korean sentence. Do not replace it with 'evidence is limited' alone.",
      "For short_term_ko and long_term_ko, state what was actually measured in that time window. If that window was not studied, say precisely that it was not studied; do not borrow a result from a different time window.",
      "risk_ko is displayed under a content-sensitive heading. Use it only for a directly reported harm, trade-off, interaction, or an additional observed change. Do not create a risk section merely to say that harms were not reported or that efficacy is uncertain; omit it instead. Do not put a benefit under a risk label or repeat the main conclusion.",
      "If any supplied paper explicitly reports adverse events, side effects, toxicity, an interaction, worsening, or an increased risk, you MUST include that cited result in risk_ko and, when material to the decision, in the three-paragraph summary. If no supplied paper reports one of those outcomes, risk_ko must be an empty string. Never add a safety possibility from general knowledge, another source, or clinical intuition.",
      "In key_studies.result_ko, include the result specific to the user's exposure. When the abstract gives a direct-study count, sample size, comparison group, duration, or effect size for that exposure, include the most decision-relevant one. For a paper containing several interventions, never quote a result or a total count for a different intervention merely because it has the same outcome. A study-wide count for an umbrella intervention must never be presented as the count for one subtype unless the abstract explicitly assigns that count to the subtype.",
      "population_ko names only the participant group. Never put a participant count in population_ko. A count may appear in result_ko only when the abstract ties that count directly to the user's exposure and comparison.",
      "Do not use a risk or safety framing unless the supplied evidence actually reports harm, adverse events, or risk. A list of beneficial changes belongs under observed changes, not risk.",
      "Keep every detail section tightly scoped to the exposure and outcome in the user's question. Omit merely plausible background knowledge that is not a reported result in the supplied evidence.",
      "Select at most 3 key_studies. Each must use a supplied citationIndex and explain population, exposure, actual result, time horizon, and one limitation.",
      "Do not repeat generic phrases such as 'the paper is in the same direction as the question'. State the actual reported result.",
      "If evidence is tangential, lacks an abstract, or does not directly connect exposure and outcome, say the direct evidence is insufficient.",
      "Answer in concise Korean for a general user. Do not diagnose or prescribe. Use citation indices like [1] only for supplied evidence.",
      "Return strict JSON only."
    ],
    required_json_shape: {
      research_story: {
        pattern: "evidence_shift | ongoing_debate | context_explains_difference | mostly_consistent | insufficient",
        conclusion_strength: "substantial | moderate | limited | not_established | uncertain",
        conclusion_ko: "One direct Korean conclusion sentence that states direction and strength before the evidence story",
        opening_ko: "Memorable Korean framing of the research debate",
        timeline_ko: "Chronological comparison of 2-3 supplied papers with year, design, actual finding, and citation indices",
        resolution_ko: "Who is closer to the evidence and under which decisive condition"
      },
      summary_ko: "The three research_story fields joined as three compact Korean paragraphs. Under 750 characters.",
      detail: {
        short_term_ko: "Korean synthesis of immediate or short-term effects with valid citation indices",
        long_term_ko: "Korean synthesis of habitual, follow-up, or long-term effects with valid citation indices",
        risk_ko: "Korean synthesis of effect size or risk and whether it is association or causation",
        applicability_ko: "Who the evidence applies to and which groups differ",
        limitations_ko: "Main cross-study limitations",
        key_studies: [
          {
            citationIndex: "number from supplied evidence only",
            design_ko: "study design in Korean",
            population_ko: "actual study population",
            exposure_ko: "actual exposure, intervention, or comparison",
            result_ko: "actual result including grounded numbers when supplied",
            time_horizon: "short_term | long_term | mixed | unknown",
            limitation_ko: "one study-specific limitation"
          }
        ]
      },
      verdict: "supported | mixed | not_supported | insufficient_evidence",
      limitations: ["Korean limitation strings"],
      evidence_interpretation: [
        {
          citationIndex: "number from provided evidence only",
          stance: "supports | opposes | mixed | unclear",
          reason_ko: "actual finding and why it supports, opposes, mixes, or cannot resolve the exact claim"
        }
      ]
    },
    evidence: evidence.papers.slice(0, fallback.citations.length).map(toLlmEvidence)
  };
}

function toLlmEvidence(paper: Paper, index: number): Record<string, unknown> {
  return {
    citationIndex: index + 1,
    source: paper.source,
    sourceId: paper.sourceId,
    title: paper.title,
    authors: paper.authors.slice(0, 6),
    venue: paper.venue,
    publisher: paper.publisher,
    institutions: paper.institutions?.slice(0, 4),
    year: paper.year,
    doi: paper.doi,
    url: paper.url,
    evidenceLevel: paper.evidenceLevel,
    publicationTypes: paper.publicationTypes,
    abstract: evidenceAbstractForPrompt(paper.abstract)
  };
}

function evidenceAbstractForPrompt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:nbsp|amp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const maxLength = 2_200;
  if (clean.length <= maxLength) return clean;

  // Search abstracts often put the population and method first, then the
  // usable effect sizes after "Results" or "In total". Retain both rather
  // than silently showing the model only a method-heavy prefix.
  const resultMatch = /\b(?:results?|conclusions?)\s*[:.]|\bin total,/i.exec(clean);
  if (!resultMatch || resultMatch.index < 360) return trimForPrompt(clean, maxLength);
  const head = clean.slice(0, 360).trimEnd();
  const resultBudget = maxLength - head.length - 32;
  return `${head} ... [results excerpt] ${clean.slice(resultMatch.index, resultMatch.index + resultBudget).trimEnd()}`;
}

export function mergeModelAnswer(
  gemini: ModelClaimJson,
  fallback: ClaimAnswer,
  evidence?: EvidenceSearchResult
): ClaimAnswer {
  const broadTopic = evidence?.researchIntent?.questionType === "other" &&
    evidence.researchIntent.outcomeTerms.length === 0;
  // For an overall-benefit question, the model may paraphrase a mixed review
  // into a much stronger health claim. The deterministic story keeps the
  // selected paper's scope and reported domains visible without that leap.
  if (broadTopic) return { ...fallback, evidence_status: "verified" };
  const parallelComparison = evidence?.comparisonEvidenceScope === "parallel";
  const contextualEvidence = evidence?.evidenceDirectness === "contextual";
  const fallbackHasDirectionalModeComparison = fallback.detail?.key_studies.some((study) =>
    /유산소 운동은 근력 운동보다.*더 줄였습니다/.test(study.result_ko)
  ) ?? false;
  const fallbackHasDirectWeightComparison = fallback.detail?.key_studies.some((study) =>
    /(?:마운자로|티르제파타이드).*(?:위고비|세마글루타이드)/.test(study.result_ko)
  ) ?? false;
  const verdict = parallelComparison || contextualEvidence
    ? "insufficient_evidence"
    : fallbackHasDirectWeightComparison
      ? fallback.verdict
    : isVerdict(gemini.verdict) ? gemini.verdict : fallback.verdict;
  const interpretations = sanitizeInterpretations(gemini.evidence_interpretation, fallback, evidence);
  const synthesizedDetail = fallbackHasDirectWeightComparison
    ? fallback.detail!
    : ensureConcreteKeyStudyResults(
      sanitizeDetails(gemini.detail, fallback, evidence),
      interpretations,
      evidence
    );
  const detail = ensureMinimumKeyStudies(synthesizedDetail, fallback.detail, fallback.citations.length);
  const modelResearchStory = ensureConcreteResearchStory(
      sanitizeResearchStory(gemini.research_story, fallback, evidence),
      detail
    );
  const constrainedFallbackStory: ResearchStory = fallback.research_story ?? {
    pattern: "insufficient",
    opening_ko: parallelComparison
      ? "두 선택지를 같은 조건에서 직접 비교한 연구는 충분히 확인되지 않았습니다."
      : "질문의 정확한 조건을 그대로 검증한 연구는 충분히 확인되지 않았습니다.",
    timeline_ko: parallelComparison
      ? "각 선택지를 따로 평가한 결과는 직접 비교 결론으로 바꿀 수 없습니다."
      : "가장 가까운 주제를 다룬 연구는 확인했지만, 정확한 조건과는 차이가 있습니다.",
    resolution_ko: parallelComparison
      ? "직접 비교 근거가 없어 우열을 단정하지 않습니다."
      : "가까운 주제의 결과를 정확한 조건에 대한 직접 결론으로 바꾸지 않습니다."
  };
  const researchStory = parallelComparison || contextualEvidence
    ? {
      ...constrainedFallbackStory,
      timeline_ko: ensureStoryCitationReference(
        useParallelFallbackTimeline(modelResearchStory?.timeline_ko)
          ? constrainedFallbackStory.timeline_ko
          : modelResearchStory?.timeline_ko ?? constrainedFallbackStory.timeline_ko,
        fallback.citations.length
      )
    }
    : fallbackHasDirectionalModeComparison || fallbackHasDirectWeightComparison
      ? fallback.research_story
      : modelResearchStory;
  const rawSummary = sanitizeAnswerCitationRefs(
    modelAnswerText(gemini.summary_ko ?? gemini.answer_ko) || fallback.summary_ko || fallback.answer_ko,
    fallback.citations.length
  );
  const modelSummary = researchStory
    ? [researchStory.opening_ko, researchStory.timeline_ko, researchStory.resolution_ko].join("\n\n")
    : rawSummary;
  const groundedSummary = hasUnsupportedNumbers(modelSummary, evidenceCorpus(evidence))
    ? fallback.summary_ko || fallback.answer_ko
    : modelSummary;
  const summary = ensureConciseSummary(groundedSummary, fallback.summary_ko || fallback.answer_ko);
  const limitations = sanitizeLimitations(gemini.limitations, fallback.limitations);

  const merged: ClaimAnswer = {
    ...fallback,
    answer_ko: summary,
    summary_ko: summary,
    research_story: researchStory ?? fallback.research_story,
    detail,
    evidence_status: "verified",
    verdict,
    evidence_interpretation: interpretations.length > 0 ? interpretations : fallback.evidence_interpretation,
    // Recommendations not reported by a selected paper are deliberately omitted.
    practical_checks: undefined,
    safety_note: "",
    limitations: contextualEvidence
      ? [...new Set([
        ...limitations,
        "질문의 정확한 용량, 시점, 국가, 대상 또는 비교 조건을 직접 검증한 연구는 아니며 가까운 주제를 다룬 근거입니다."
      ])].slice(0, 5)
      : limitations
  };
  return enforceEvidenceLadderDirectness(merged, evidence);
}

function useParallelFallbackTimeline(value: string | undefined): boolean {
  if (!value) return true;
  return /질문에 직접 답하는 결과가 (?:명확하게 )?보고되지 않았습니다|각 선택지를 따로 평가한 결과는 직접 비교 결론으로 바꿀 수 없습니다/.test(value);
}

function ensureMinimumKeyStudies(
  detail: EvidenceDetails | undefined,
  fallbackDetail: EvidenceDetails | undefined,
  citationCount: number
): EvidenceDetails | undefined {
  if (!detail || !fallbackDetail) return detail;
  const targetCount = Math.min(3, citationCount);
  if (targetCount <= 1 || detail.key_studies.length >= targetCount) return detail;

  const seen = new Set(detail.key_studies.map((study) => study.citationIndex));
  const additions = fallbackDetail.key_studies.filter((study) => !seen.has(study.citationIndex));
  return {
    ...detail,
    key_studies: [...detail.key_studies, ...additions].slice(0, targetCount)
  };
}

function ensureStoryCitationReference(value: string, citationCount: number): string {
  if (citationCount === 0 || hasValidCitationReference(value, citationCount)) return value;
  return "제공된 논문에서 질문 조건과 가장 가까운 결과를 확인했지만, 정확한 조건에 대한 직접 결론으로 바꾸지는 않습니다.";
}

function enforceEvidenceLadderDirectness(answer: ClaimAnswer, evidence: EvidenceSearchResult | undefined): ClaimAnswer {
  const intent = evidence?.researchIntent;
  if (!intent || intent.evidenceStrategy !== "direct_then_contextual" || !evidence) return answer;

  const hasDirectHumanOutcome = evidence.papers.some((paper) =>
    paper.evidenceLevel !== "unknown" && paperMatchesDirectIntent(paper, intent)
  );
  if (hasDirectHumanOutcome) return answer;

  const exactIndex = evidence.papers.findIndex((paper) => paperMatchesDirectIntent(paper, intent)) + 1;
  const contextualIndex = evidence.papers.findIndex((paper, index) =>
    index !== exactIndex - 1 && paper.evidenceLevel !== "unknown"
  ) + 1;
  const exactReference = exactIndex > 0 ? `[${exactIndex}]` : undefined;
  const contextualReference = contextualIndex > 0 ? `[${contextualIndex}]` : undefined;
  const timeline = exactReference && contextualReference
    ? `${exactReference}은 질문 대상과 관련된 자료지만, 질문과 같은 결과를 사람에게 직접 비교한 근거로 확인되지는 않았습니다. ${contextualReference}은 더 넓은 또는 주변 범주의 결과를 다루므로, 질문의 대상 자체에 대한 결론으로 바꿀 수 없습니다.`
    : exactReference
      ? `${exactReference}은 질문 대상과 관련된 자료지만, 질문과 같은 결과를 사람에게 직접 비교한 근거로 확인되지는 않았습니다.`
      : contextualReference
        ? `${contextualReference}은 질문과 주변 주제를 다루지만, 질문의 대상 자체를 직접 비교한 결과는 아닙니다.`
        : "이번 검색에서는 질문의 대상과 결과를 직접 연결하는 인체 연구를 확인하지 못했습니다.";
  const story: ResearchStory = {
    pattern: "insufficient",
    opening_ko: "질문에 나온 대상 자체가 사람에게 어떤 결과를 만드는지 직접 비교한 연구는 아직 충분하지 않습니다.",
    timeline_ko: timeline,
    resolution_ko: "그래서 주변 연구를 질문의 대상 자체에 대한 증거처럼 바꾸지 않고, 지금은 더 좋거나 나쁘다고 단정하지 않습니다. 직접 근거와 주변 근거는 구분해서 해석해야 합니다."
  };
  return {
    ...answer,
    answer_ko: [story.opening_ko, story.timeline_ko, story.resolution_ko].join("\n\n"),
    summary_ko: [story.opening_ko, story.timeline_ko, story.resolution_ko].join("\n\n"),
    research_story: story,
    verdict: "insufficient_evidence",
    limitations: [...new Set([
      ...answer.limitations,
      "질문의 대상 자체를 다룬 직접 근거와 주변 범주의 근거를 같은 직접성으로 해석할 수 없습니다."
    ])].slice(0, 5)
  };
}

function paperMatchesDirectIntent(paper: Paper, intent: ResearchIntent): boolean {
  return sharedMatchesDirectIntent(paper, intent);
}

function intentAsksForSingleExposure(intent: ResearchIntent): boolean {
  return /(?:\balone\b|\bonly\b|\bsolely\b|\bby itself\b)/i.test(`${intent.exposure} ${intent.exposureTerms.join(" ")}`);
}

function titleCentersAnotherIntervention(paper: Paper, exposureTerms: string[]): boolean {
  const resistanceQuestion = exposureTerms.some((term) => /(?:resistance|strength|weight)\s+training|resistance exercise/i.test(term));
  if (!resistanceQuestion) return false;
  return /\b(?:incretin|glp[- ]?1|pharmacotherap|medication|drug therap|protein|creatine|supplement|diet(?:ing|ary)?|caloric restriction|dietary restriction|combined)\b/i.test(paper.title);
}

function paperMatchesDirectExposureTitle(paper: Paper, concepts: string[]): boolean {
  const title = normalizeOptionText(paper.title);
  const genericTokens = new Set(["weight", "training", "exercise", "physical", "activity"]);
  return concepts.some((concept) => {
    const normalizedConcept = normalizeOptionText(concept);
    if (normalizedConcept && title.includes(normalizedConcept)) return true;
    const distinctiveTokens = [...new Set(
      normalizedConcept
        .split(/[^a-z0-9가-힣]+/i)
        .filter((token) => token.length >= 4 && !genericTokens.has(token))
    )];
    return distinctiveTokens.length > 0 && distinctiveTokens.every((token) => title.includes(token));
  });
}

function isBroadTopicIntent(intent: ResearchIntent): boolean {
  return intent.questionType === "other" && intent.outcomeTerms.length === 0;
}

function paperMatchesBroadTopicTitle(paper: Paper, concepts: string[]): boolean {
  const title = normalizeOptionText(paper.title);
  return concepts.some((concept) => {
    const normalizedConcept = normalizeOptionText(concept);
    if (normalizedConcept && title.includes(normalizedConcept)) return true;
    const tokens = normalizedConcept.split(/[^a-z0-9가-힣]+/i).filter((token) => token.length >= 4);
    return tokens.length === 1 && title.includes(tokens[0]!);
  });
}

function paperMatchesSelectableIntent(paper: Paper, evidence: EvidenceSearchResult): boolean {
  const intent = evidence.researchIntent;
  if (!intent) return true;
  const role = classifyPaperForIntent(paper, intent);
  if (role === "reject") return false;
  if (evidence.comparisonEvidenceScope === "direct" && isFoodProteinQualityComparisonIntent(intent)) {
    const titleNamesBoth = paperMatchesBroadTopicTitle(paper, intent.exposureTerms) &&
      paperMatchesBroadTopicTitle(paper, intent.comparatorTerms);
    return role === "direct" ||
      (titleNamesBoth && matchesParallelComparisonIntent(paper, intent));
  }
  if (evidence.comparisonEvidenceScope === "parallel") {
    return matchesParallelComparisonIntent(paper, intent);
  }
  if (evidence.evidenceDirectness === "contextual") {
    return role === "contextual";
  }
  return role === "direct" || (intent.evidenceStrategy === "direct_then_contextual" && role === "contextual");
}

function paperMatchesNamedOption(paper: Paper, concepts: string[]): boolean {
  const text = normalizeOptionText(`${paper.title} ${paper.abstract ?? ""}`);
  return concepts.some((concept) => {
    const normalizedConcept = normalizeOptionText(concept);
    if (normalizedConcept && text.includes(normalizedConcept)) return true;
    const rawTokens = normalizedConcept
      .split(/[^a-z0-9가-힣]+/i)
      .filter(Boolean);
    const tokens = rawTokens
      .filter((token: string) => token.length >= 4);
    if (tokens.length === 0) return false;
    return rawTokens.length === 1 ? text.includes(tokens[0]!) : text.includes(normalizedConcept);
  });
}

function paperMatchesDirectConcept(paper: Paper, concepts: string[]): boolean {
  const text = normalizeOptionText(`${paper.title} ${paper.abstract ?? ""}`);
  return concepts.some((concept) => {
    const normalizedConcept = normalizeOptionText(concept);
    if (normalizedConcept && text.includes(normalizedConcept)) return true;
    const rawTokens = normalizedConcept
      .split(/[^a-z0-9가-힣]+/i)
      .filter(Boolean);
    const tokens = rawTokens
      .filter((token: string) => token.length >= 4);
    if (tokens.length === 0) return false;
    return rawTokens.length === 1 ? text.includes(tokens[0]!) : text.includes(normalizedConcept);
  });
}

function normalizeOptionText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, " ").replace(/\s+/g, " ").trim();
}

function hasExplicitComparison(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:compar(?:e|ed|ing|ison)|versus|vs\.?|replace(?:d|ment|ing)?|substitut(?:e|ed|ion|ing)|relative to|compared with|compared to|between.{0,80}(?:and|versus))\b/.test(text);
}

function hasNamedHeadToHeadComparison(paper: Paper, intent: ResearchIntent): boolean {
  if (!paperMatchesNamedOption(paper, intent.exposureTerms) || !paperMatchesNamedOption(paper, intent.comparatorTerms)) {
    return false;
  }
  if (isFoodProteinQualityComparisonIntent(intent) && hasNamedFoodMetricComparison(paper, intent)) {
    return true;
  }

  const title = normalizeOptionText(paper.title);
  const titleNamesBoth = optionMatchesText(title, intent.exposureTerms) &&
    optionMatchesText(title, intent.comparatorTerms);
  if (titleNamesBoth && hasComparisonSignal(paper.title)) return true;

  return `${paper.title}. ${paper.abstract ?? ""}`
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => {
      const normalized = normalizeOptionText(sentence);
      return optionMatchesText(normalized, intent.exposureTerms) &&
        optionMatchesText(normalized, intent.comparatorTerms) &&
        hasComparisonSignal(sentence);
    });
}

function optionMatchesText(normalizedText: string, concepts: string[]): boolean {
  return concepts.some((concept) => {
    const normalizedConcept = normalizeOptionText(concept);
    if (!normalizedConcept) return false;
    const tokens = normalizedConcept.split(" ").filter(Boolean);
    return tokens.length === 1
      ? new RegExp(`(?:^|\\s)${escapeRegExp(tokens[0]!)}(?:$|\\s)`, "i").test(normalizedText)
      : normalizedText.includes(normalizedConcept);
  });
}

function hasComparisonSignal(value: string): boolean {
  return /\b(?:versus|vs\.?|compared\s+(?:with|to)|comparison\s+of|comparative|difference(?:s)?\s+between|higher\s+than|lower\s+than|greater\s+than|less\s+than|superior\s+to|inferior\s+to|outperformed|replac(?:e|ed|ing|ement).{0,50}\bwith|substitut(?:e|ed|ing|ion).{0,50}\bwith)\b/i.test(value);
}

function hasNamedFoodMetricComparison(paper: Paper, intent: ResearchIntent): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`;
  if (!/(?:protein\s*(?:quality|digestibility|bioaccessibility|content|efficiency)|(?:digestibility|bioaccessibility).{0,120}\b(?:crude\s+)?protein\b|(?:free|essential)\s+amino\s+acid|amino\s+acid\s*(?:profile|composition|digestibility)|diaas|digestible indispensable)/i.test(text)) {
    return false;
  }
  return optionHasNearbyNumericValue(text, intent.exposureTerms) &&
    optionHasNearbyNumericValue(text, intent.comparatorTerms);
}

function optionHasNearbyNumericValue(text: string, concepts: string[]): boolean {
  return concepts.some((concept) => {
    const tokens = concept.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
    if (tokens.length === 0) return false;
    const expression = tokens.map(escapeRegExp).join("\\s+");
    return new RegExp(`\\b${expression}\\b(?:\\s+[a-z-]+){0,10}\\s*(?:\\(|:|=)?\\s*\\d+(?:\\.\\d+)?`, "i").test(text);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureConcreteResearchStory(
  story: ResearchStory | undefined,
  detail: EvidenceDetails | undefined
): ResearchStory | undefined {
  if (!story) return undefined;
  const studies = [...(detail?.key_studies ?? [])]
    .sort((left, right) => (left.year ?? Number.MAX_SAFE_INTEGER) - (right.year ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 3);
  const timeline = studies
    .map((study) => `${study.year ? `${study.year}년 ` : ""}${study.design_ko} [${study.citationIndex}]은 ${study.result_ko}`)
    .join(" ");
  const strongestResult = studies.at(-1)?.result_ko ?? studies[0]?.result_ko;
  return {
    ...story,
    timeline_ko: isGenericStoryText(story.timeline_ko) && timeline ? timeline : story.timeline_ko,
    resolution_ko: isGenericStoryText(story.resolution_ko) && strongestResult
      ? `종합하면, ${strongestResult}`
      : story.resolution_ko
  };
}

function isGenericStoryText(value: string): boolean {
  return isInternalTemplateText(value) ||
    isGenericResultText(value) ||
    /(질문의 주장은|질문에서 말한|질문에서 예상한|결과 방향이 명확)/i.test(value);
}

function ensureConciseSummary(summary: string, fallback: string): string {
  const clean = summary
    .replace(/^핵심 결론\s*:?\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length >= 40 && clean.length <= 750) return clean;
  if (clean.length > 750) {
    const paragraphs = clean.split(/\n\s*\n/).filter(Boolean).slice(0, 3).join("\n\n");
    return compactText(paragraphs, 750);
  }
  return compactText(fallback, 750);
}

function sanitizeResearchStory(
  story: ModelClaimJson["research_story"],
  fallback: ClaimAnswer,
  evidence?: EvidenceSearchResult
): ResearchStory | undefined {
  if (!story) return fallback.research_story;
  const conclusion = detailText(story.conclusion_ko);
  const opening = detailText(story.opening_ko);
  const timeline = detailText(story.timeline_ko);
  const resolution = detailText(story.resolution_ko);
  if (!opening || !timeline || !resolution) return fallback.research_story;
  const corpus = evidenceCorpus(evidence);
  const groundedConclusion = conclusion
    ? groundStoryText(conclusion, undefined, corpus, fallback.citations.length)
    : undefined;
  const groundedOpening = groundStoryText(opening, fallback.research_story?.opening_ko, corpus, fallback.citations.length);
  const openingWithConclusion = groundedConclusion && !sameStorySentence(groundedConclusion, groundedOpening)
    ? `${groundedConclusion} ${groundedOpening}`
    : groundedConclusion ?? groundedOpening;
  return {
    pattern: sanitizeResearchPattern(story.pattern, fallback.research_story?.pattern),
    opening_ko: openingWithConclusion,
    timeline_ko: groundStoryText(timeline, fallback.research_story?.timeline_ko, corpus, fallback.citations.length, true),
    resolution_ko: groundStoryText(resolution, fallback.research_story?.resolution_ko, corpus, fallback.citations.length)
  };
}

function sameStorySentence(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[^가-힣a-z0-9]/gi, "").toLowerCase();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length > 0 &&
    (normalizedLeft === normalizedRight || normalizedRight.includes(normalizedLeft) || normalizedLeft.includes(normalizedRight));
}

function sanitizeResearchPattern(value: unknown, fallback: ResearchPattern | undefined): ResearchPattern {
  const allowed: ResearchPattern[] = [
    "evidence_shift",
    "ongoing_debate",
    "context_explains_difference",
    "mostly_consistent",
    "insufficient"
  ];
  return allowed.includes(value as ResearchPattern) ? (value as ResearchPattern) : fallback ?? "insufficient";
}

function groundStoryText(
  candidate: string,
  fallback: string | undefined,
  corpus: string,
  citationCount: number,
  requireCitation = false
): string {
  if (hasUnsupportedNumbers(candidate, corpus) || (requireCitation && citationCount > 0 && !hasValidCitationReference(candidate, citationCount))) {
    return fallback || "제공된 근거에서 이 논문 흐름을 확인하지 못했습니다.";
  }
  return sanitizeAnswerCitationRefs(candidate, citationCount);
}

function hasValidCitationReference(value: string, citationCount: number): boolean {
  return [...value.matchAll(/\[(\d+)\]/g)].some((match) => {
    const index = Number(match[1]);
    return Number.isInteger(index) && index >= 1 && index <= citationCount;
  });
}

function sanitizeDetails(
  detail: ModelClaimJson["detail"],
  fallback: ClaimAnswer,
  evidence?: EvidenceSearchResult
): EvidenceDetails | undefined {
  const fallbackDetail = fallback.detail;
  if (!detail) return fallbackDetail;

  const shortTerm = detailText(detail.short_term_ko);
  const longTerm = detailText(detail.long_term_ko);
  const risk = detailText(detail.risk_ko);
  const applicability = detailText(detail.applicability_ko);
  const limitations = detailText(detail.limitations_ko);
  // An empty risk section is valid: do not manufacture one when none of the
  // selected abstracts reports a safety outcome.
  if (![shortTerm, longTerm, applicability, limitations].every(Boolean)) return fallbackDetail;

  const corpus = evidenceCorpus(evidence);
  const hasReportedSafety = hasReportedSafetyEvidence(evidence);
  const studies = sanitizeKeyStudies(detail.key_studies, fallback, evidence);
  return {
    short_term_ko: groundDetailText(shortTerm!, fallbackDetail?.short_term_ko, corpus, fallback.citations.length),
    long_term_ko: groundDetailText(longTerm!, fallbackDetail?.long_term_ko, corpus, fallback.citations.length),
    risk_ko: hasReportedSafety
      ? risk
        ? groundDetailText(risk, fallbackDetail?.risk_ko, corpus, fallback.citations.length)
        : reportedSafetyFallback(evidence)
      : "",
    applicability_ko: groundDetailText(applicability!, fallbackDetail?.applicability_ko, corpus, fallback.citations.length),
    limitations_ko: groundDetailText(limitations!, fallbackDetail?.limitations_ko, corpus, fallback.citations.length),
    key_studies: studies.length > 0 ? studies : fallbackDetail?.key_studies ?? []
  };
}

function ensureConcreteKeyStudyResults(
  detail: EvidenceDetails | undefined,
  interpretations: EvidenceInterpretation[],
  evidence?: EvidenceSearchResult
): EvidenceDetails | undefined {
  if (!detail) return undefined;
  const hasReportedSafety = hasReportedSafetyEvidence(evidence);
  const keyStudies = detail.key_studies.flatMap((study) => {
    const interpretation = interpretations.find((item) => item.citationIndex === study.citationIndex);
    const paper = evidence?.papers[study.citationIndex - 1];
    const candidates = [study.result_ko, interpretation?.reason_ko, reportedResultSentence(paper)];
    const result = candidates.find((candidate): candidate is string => Boolean(candidate && isConcreteResultText(candidate)));
    if (!result) return [];
    return [{
      ...study,
      result_ko: sanitizeAnswerCitationRefs(result, evidence?.papers.length ?? 0),
      exposure_ko: isInternalTemplateText(study.exposure_ko)
        ? "질문에서 다룬 노출 또는 중재"
        : study.exposure_ko,
      limitation_ko: isInternalTemplateText(study.limitation_ko)
        ? "연구 대상과 측정 방식이 달라 다른 집단에 그대로 적용하기는 어렵습니다."
        : study.limitation_ko
    }];
  });
  return {
    ...detail,
    short_term_ko: safeDetailSection(
      detail.short_term_ko,
      "선택된 연구는 단기 변화를 별도로 보고하지 않았습니다."
    ),
    long_term_ko: safeDetailSection(
      detail.long_term_ko,
      "선택된 연구는 장기 변화를 별도로 보고하지 않았습니다."
    ),
    risk_ko: hasReportedSafety
      ? safeDetailSection(
        detail.risk_ko,
        reportedSafetyFallback(evidence)
      )
      : "",
    applicability_ko: safeDetailSection(
      detail.applicability_ko,
      "연구 대상 정보가 충분하지 않아 적용 대상을 더 좁혀 말하기 어렵습니다."
    ),
    limitations_ko: safeDetailSection(
      detail.limitations_ko,
      "연구마다 대상자, 측정 방식과 추적 기간이 달라 결과를 모든 사람에게 그대로 적용하기는 어렵습니다."
    ),
    key_studies: keyStudies
  };
}

function safeDetailSection(value: string, fallback: string): string {
  return isInternalTemplateText(value) || isGenericResultText(value) ? fallback : value;
}

function hasReportedSafetyEvidence(evidence: EvidenceSearchResult | undefined): boolean {
  return (evidence?.papers ?? []).some((paper) =>
    /(?:serious )?adverse events?|side effects?|adverse reactions?|toxicity|contraindicat|drug interaction|increased risk|higher risk|excess risk|worsen(?:ed|ing)?|deteriorat(?:ed|ion)?/i.test(paper.abstract ?? "")
  );
}

function reportedSafetyFallback(evidence: EvidenceSearchResult | undefined): string {
  const index = (evidence?.papers ?? []).findIndex((paper) =>
    /(?:serious )?adverse events?|side effects?|adverse reactions?|toxicity|contraindicat|drug interaction|increased risk|higher risk|excess risk|worsen(?:ed|ing)?|deteriorat(?:ed|ion)?/i.test(paper.abstract ?? "")
  );
  return index >= 0
    ? `[${index + 1}]에서 부작용·안전성 또는 위험 관련 결과를 보고했습니다. 초록에 나온 결과 범위 안에서 해석해야 합니다.`
    : "";
}

function isConcreteResultText(value: string): boolean {
  const clean = value.trim();
  return clean.length >= 12 && !isInternalTemplateText(clean) && !isGenericResultText(clean);
}

function isInternalTemplateText(value: string): boolean {
  return /(제목|초록|메타데이터|분류 불명|같은 쪽|같은 방향|효과 방향|질문에 포함된 노출|자동 MVP|제공된 근거 안에서 모델이 해석)/i.test(value);
}

function isGenericResultText(value: string): boolean {
  return /(질문(?:에|에서).*(?:주장|방향|예상한|말한)|관련 지표의|연관성 신호|구체적(?:인|으로) 보고된 결과|직접 답하는.*결과|결과 방향|원문.*확인|확인하지 못했습니다)/i.test(value);
}

function reportedResultSentence(paper: Paper | undefined): string | undefined {
  const abstract = paper?.abstract
    ?.replace(/<[^>]+>/g, " ")
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!abstract) return undefined;
  const sentences = abstract.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 30 && sentence.length <= 600);
  const resultSignals = /\b(?:result|conclusion|found|reported|associated|increased|decreased|reduced|improved|higher|lower|risk|odds|effect|significant)\b/i;
  return [...sentences].reverse().find((sentence) => resultSignals.test(sentence) && isKoreanUserText(sentence));
}

function sanitizeKeyStudies(
  items: NonNullable<ModelClaimJson["detail"]>["key_studies"],
  fallback: ClaimAnswer,
  evidence?: EvidenceSearchResult
): KeyStudyDetail[] {
  const seen = new Set<number>();
  const studies: KeyStudyDetail[] = [];
  for (const item of items ?? []) {
    const citationIndex = Number(item.citationIndex);
    const citation = fallback.citations[citationIndex - 1];
    if (!citation || seen.has(citationIndex)) continue;
    const result = detailText(item.result_ko);
    if (!result) continue;
    const fallbackStudy = fallback.detail?.key_studies.find((study) => study.citationIndex === citationIndex);
    const paperCorpus = evidencePaperCorpus(evidence?.papers[citationIndex - 1]);
    const directionlessMetric = /(?:평균\s*)?(?:\d+(?:\.\d+)?(?:kg|%|mmhg|cm)?\s*)+(?:차이|보고됐습니다)/i.test(result) &&
      !/(?:더\s*(?:감소|증가|줄|늘)|감소했|증가했|줄였습니다|늘렸)/i.test(result);
    const groundedResult = hasUnsupportedNumbers(result, paperCorpus) || directionlessMetric
      ? fallbackStudy?.result_ko
      : sanitizeAnswerCitationRefs(result, fallback.citations.length);
    if (!groundedResult) continue;
    seen.add(citationIndex);
    const population = sanitizeStudyPopulation(detailText(item.population_ko));
    const populationKo = population && !isGenericStudyPopulation(population)
      ? population
      : fallbackStudy?.population_ko ?? "연구 대상 정보 미상";
    studies.push({
      citationIndex,
      title: citation.title,
      year: citation.year,
      design_ko: detailText(item.design_ko) || evidenceDesignKo(citation.evidenceLevel),
      population_ko: populationKo,
      exposure_ko: detailText(item.exposure_ko) || fallbackStudy?.exposure_ko || "질문에서 다룬 노출 또는 중재",
      result_ko: groundedResult,
      time_horizon: sanitizeTimeHorizon(item.time_horizon),
      limitation_ko: detailText(item.limitation_ko) || "대상자와 측정 방식이 달라 다른 집단에 그대로 적용하기는 어렵습니다.",
      url: citation.url
    });
    if (studies.length === 3) break;
  }
  return studies;
}

function sanitizeStudyPopulation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value
    .replace(/\s*\(?\s*(?:n\s*[=>]?\s*)?\d[\d,]*(?:\.\d+)?\s*(?:명|participants?|adults?|individuals?|subjects?)\s*\)?/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean || undefined;
}

function isGenericStudyPopulation(value: string | undefined): boolean {
  return !value || /^(?:해당 질환이 있는 연구 참여자|연구 대상 정보 미상|연구 참여자)$/i.test(value);
}

function groundDetailText(candidate: string, fallback: string | undefined, corpus: string, citationCount: number): string {
  if (hasUnsupportedNumbers(candidate, corpus)) {
    return fallback || "제공된 근거에서 수치를 직접 확인하지 못했습니다.";
  }
  return sanitizeAnswerCitationRefs(candidate, citationCount);
}

function hasUnsupportedNumbers(value: string, corpus: string): boolean {
  const numbers = extractGroundingNumbers(value);
  if (numbers.length === 0) return false;
  const supported = new Set(extractGroundingNumbers(corpus));
  return numbers.some((number) => !supported.has(number));
}

function extractGroundingNumbers(value: string): string[] {
  const withoutCitationIndices = value.replace(/\[\d+\]/g, "");
  const normalizedThousands = withoutCitationIndices.replace(/\b\d{1,3}(?:[ ,]\d{3})+\b/g, (match) => match.replace(/[ ,]/g, ""));
  return [...normalizedThousands.matchAll(/\d+(?:[.,]\d+)?/g)]
    .map((match) => normalizeGroundingNumber((match[0] ?? "").replace(/,/g, "")))
    .filter(Boolean);
}

function normalizeGroundingNumber(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}

function evidenceCorpus(evidence: EvidenceSearchResult | undefined): string {
  return (evidence?.papers ?? []).map(evidencePaperCorpus).join(" ");
}

function evidencePaperCorpus(paper: Paper | undefined): string {
  if (!paper) return "";
  return [paper.title, paper.abstract, paper.year, paper.publicationTypes.join(" ")].filter(Boolean).join(" ");
}

function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/있었음(?=[.!?]|$)/g, "있었습니다")
    .replace(/없었음(?=[.!?]|$)/g, "없었습니다")
    .replace(/나타났음(?=[.!?]|$)/g, "나타났습니다")
    .replace(/확인됐음(?=[.!?]|$)/g, "확인됐습니다")
    .replace(/못함(?=[.!?]|$)/g, "못했습니다")
    .replace(/않음(?=[.!?]|$)/g, "않았습니다")
    .replace(/부족함(?=[.!?]|$)/g, "부족합니다")
    .replace(/\s+/g, " ")
    .trim();
  return clean && isKoreanUserText(clean) ? clean : undefined;
}

function isKoreanUserText(value: string): boolean {
  if (!/[가-힣]/.test(value) && /[A-Za-z]{2,}/.test(value)) return false;
  return !/[A-Za-z]{2,}(?:[\s,;:()[\]/-]+[A-Za-z]{2,}){4,}/.test(value);
}

function sanitizeTimeHorizon(value: unknown): KeyStudyDetail["time_horizon"] {
  return ["short_term", "long_term", "mixed", "unknown"].includes(String(value))
    ? (value as KeyStudyDetail["time_horizon"])
    : "unknown";
}

function evidenceDesignKo(level: string): string {
  switch (level) {
    case "systematic_review":
      return "체계적 문헌고찰·메타분석";
    case "clinical_study":
      return "임상연구";
    case "observational_study":
      return "관찰연구";
    case "official_guidance":
      return "공식 권고";
    case "preprint":
      return "프리프린트";
    default:
      return "연구 문헌";
  }
}

function modelAnswerText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = value.trim();
    return clean && isKoreanUserText(clean) ? clean : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>);
  const sections = entries
    .map(([key, section]) => {
      const body = modelSectionText(section);
      return body ? `${modelSectionHeading(key)}:\n${body}` : "";
    })
    .filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function modelSectionText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => modelSectionText(item))
      .filter(Boolean)
      .map((item) => `* ${item}`)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${modelSectionText(item)}`)
      .filter((item) => !item.endsWith(": "))
      .join("\n");
  }
  return "";
}

function modelSectionHeading(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (/핵심결론|keyconclusion|conclusion/.test(normalized)) return "핵심 결론";
  if (/연구가실제로|actualfindings|researchfindings|findings/.test(normalized)) return "연구가 실제로 말한 것";
  if (/주의해서|caveat|caution|limitations?/.test(normalized)) return "주의해서 볼 점";
  if (/핵심근거|keyevidence|keypapers|references?/.test(normalized)) return "핵심 근거";
  return value.replace(/_/g, " ").trim();
}

function ensureReadableModelAnswer(
  answer: string,
  interpretations: EvidenceInterpretation[],
  caution: string | undefined,
  fallback: ClaimAnswer
): string {
  const requiredHeadings = ["핵심 결론", "연구가 실제로 말한 것", "주의해서 볼 점", "핵심 근거"];
  if (answer.length <= 1300 && requiredHeadings.every((heading) => answer.includes(heading))) return answer;

  const findings = interpretations
    .filter((item) => item.stance !== "unclear")
    .slice(0, 3)
    .map((item) => `* [${item.citationIndex}] ${compactText(item.reason_ko, 230)}`);
  const keyPapers = fallback.citations.slice(0, 3).map((citation, index) => {
    const year = citation.year ? ` (${citation.year})` : "";
    return `* [${index + 1}] ${compactText(citation.title, 105)}${year}`;
  });
  if (findings.length === 0 || keyPapers.length === 0) return answer;

  const conclusion = compactText(
    answer
      .replace(/^카더라 말고 근거로 보면,?\s*(?:핵심은 이겁니다\.)?\s*/i, "")
      .split(/\n\s*\n(?=(?:주요 연구|연구가 실제로|주의해서|실용적 결론|핵심 근거))/i)[0]
      ?.replace(/^결론:\s*/i, "")
      .trim() || answer,
    330
  );

  return [
    `핵심 결론:\n${conclusion}`,
    `연구가 실제로 말한 것:\n${findings.join("\n")}`,
    caution ? `주의해서 볼 점:\n${compactText(caution, 260)}` : "",
    `핵심 근거:\n${keyPapers.join("\n")}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function compactText(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean;
}

function sanitizeAnswerCitationRefs(answer: string, citationCount: number): string {
  return answer.replace(/\[(\d+)\]/g, (match, rawIndex: string) => {
    const index = Number(rawIndex);
    return Number.isInteger(index) && index >= 1 && index <= citationCount ? match : "";
  });
}

function sanitizeInterpretations(
  items: ModelClaimJson["evidence_interpretation"],
  fallback: ClaimAnswer,
  evidence?: EvidenceSearchResult
): EvidenceInterpretation[] {
  const citations = fallback.citations;
  return (items ?? [])
    .map((item) => {
      const citationIndex = Number(item.citationIndex);
      const citation = citations[citationIndex - 1];
      if (!citation || !isStance(item.stance)) return undefined;
      const proposedReason = item.reason_ko?.trim();
      const fallbackReason = fallback.evidence_interpretation?.find(
        (candidate) => candidate.citationIndex === citationIndex
      )?.reason_ko;
      const reason = proposedReason && isKoreanUserText(proposedReason) && !hasUnsupportedNumbers(
        proposedReason,
        evidencePaperCorpus(evidence?.papers[citationIndex - 1])
      )
        ? proposedReason
        : fallbackReason ?? "구체적으로 보고된 결과를 확인하지 못했습니다.";
      return {
        citationIndex,
        source: citation.source,
        title: citation.title,
        stance: item.stance,
        reason_ko: reason,
        evidenceLevel: citation.evidenceLevel
      };
    })
    .filter((item): item is EvidenceInterpretation => Boolean(item));
}

function sanitizeLimitations(items: string[] | undefined, fallback: string[]): string[] {
  const clean = (items ?? []).map((item) => item.trim()).filter((item) => Boolean(item) && isKoreanUserText(item)).slice(0, 5);
  return clean.length > 0 ? clean : fallback;
}

function sanitizePracticalChecks(items: PracticalCheck[] | undefined, fallback: PracticalCheck[] | undefined): PracticalCheck[] | undefined {
  const clean = (items ?? [])
    .map((item) => ({
      label: item.label?.trim(),
      what_to_try_ko: item.what_to_try_ko?.trim(),
      what_to_watch_ko: item.what_to_watch_ko?.trim(),
      why_it_matters_ko: item.why_it_matters_ko?.trim(),
      urgency: item.urgency
    }))
    .filter((item): item is PracticalCheck =>
      Boolean(
        item.label &&
          item.what_to_try_ko &&
          item.what_to_watch_ko &&
          item.why_it_matters_ko &&
          ["routine_observation", "discuss_with_professional", "seek_prompt_evaluation"].includes(item.urgency)
      )
    )
    .slice(0, 10);
  if (clean.length < 8 && fallback && fallback.length > clean.length) return fallback.slice(0, 10);
  return clean.length > 0 ? clean : fallback;
}

function parseGeminiJson(text: string): ModelClaimJson | GeminiSearchPlanJson {
  const stripped = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(stripped) as ModelClaimJson;
}

function sanitizeCategory(value: unknown, fallback: Exclude<Category, "auto">): Exclude<Category, "auto"> {
  return categories.includes(value as Category) && value !== "auto" ? (value as Exclude<Category, "auto">) : fallback;
}

function sanitizeClaimDirection(value: unknown): ClaimDirection | undefined {
  return ["benefit", "harm", "association", "unclear"].includes(String(value))
    ? value as ClaimDirection
    : undefined;
}

export function buildSearchPlanFromModel(
  rawPlan: unknown,
  question: string,
  fallbackCategory: Exclude<Category, "auto">,
  fallbackTerms: string[],
  plannedBy: "gemini" | "openai"
): SearchPlan {
  const plan = rawPlan as GeminiSearchPlanJson;
  const parsedIntent = sanitizeResearchIntent(plan.intent, question);
  const intent = parsedIntent ? preserveQuestionEntityModifiers(parsedIntent, question) : undefined;
  if (!intent) throw new Error(`${plannedBy} search planning returned an incomplete research intent`);
  const queryTerms = intentQueryTerms(intent);
  return {
    category: sanitizeCategory(plan.category, fallbackCategory),
    queryTerms: queryTerms.length > 0 ? queryTerms : fallbackTerms,
    searchQueries: buildIntentSearchQueries(intent),
    intent,
    claimDirection: sanitizeClaimDirection(plan.claim_direction),
    plannedBy,
    reason_ko: plan.reason_ko?.trim()
  };
}

/**
 * The planner resolves Korean consumer language to scholarly English, but a
 * resolved plan must retain qualifiers that distinguish sibling exposures.
 * This is a retrieval-contract guard, not a topic answer: it keeps modifiers
 * such as zero/sugar-free or decaffeinated from silently widening to every
 * beverage or every coffee paper on a weaker model response.
 */
function preserveQuestionEntityModifiers(intent: ResearchIntent, question: string): ResearchIntent {
  const constraint = entityModifierConstraint(question);
  if (!constraint) return intent;

  const existing = [intent.exposure, ...intent.exposureTerms].join(" ");
  const exposure = constraint.matches(existing) ? intent.exposure : constraint.canonical;
  const exposureTerms = [...new Set([
    exposure,
    // Required aliases must come before model-provided variants. A model can
    // legitimately return many spellings of one consumer term; appending the
    // canonical scholarly alias after them silently dropped it at the length
    // limit and made the review literature unreachable.
    ...constraint.requiredTerms,
    ...intent.exposureTerms.filter((term) => constraint.matches(term))
  ])].slice(0, 10);
  const keepContext = (term: string) => !constraint.rejects(term) &&
    (constraint.matches(term) || !constraint.requiresContextMarker);
  const contextualEvidenceTerms = [...new Set([
    // Keep each approved same-entity scholarly alias searchable as context.
    // The answer layer still labels it as a close academic category when it
    // is broader than the consumer wording; this only prevents it from being
    // discarded before retrieval and ranking.
    ...(intent.questionType === "other"
      ? constraint.requiredTerms.map((term) => `${term} health outcomes`)
      : []),
    ...(intent.contextualEvidenceTerms ?? []).filter(keepContext)
  ])].slice(0, 4);
  if (contextualEvidenceTerms.length === 0 && intent.questionType === "other") {
    contextualEvidenceTerms.push(`${constraint.canonical} health outcomes`);
  }

  return {
    ...intent,
    exposure,
    exposureTerms,
    directEvidenceGroups: (intent.directEvidenceGroups ?? []).length > 0
      ? [exposureTerms, ...(intent.directEvidenceGroups ?? []).slice(1)]
      : [exposureTerms],
    contextualEvidenceTerms,
    parentEvidenceTerms: (intent.parentEvidenceTerms ?? []).filter((term) => !constraint.rejects(term))
  };
}

interface EntityModifierConstraint {
  canonical: string;
  requiredTerms: string[];
  matches: (value: string) => boolean;
  rejects: (value: string) => boolean;
  requiresContextMarker: boolean;
}

function entityModifierConstraint(question: string): EntityModifierConstraint | undefined {
  const normalized = question.toLowerCase().replace(/\s+/g, " ");
  const zeroOrSugarFreeDrink = /(?<!실)제로|무설탕|다이어트\s*(?:음료|탄산|콜라)|zero[- ]?(?:sugar|calorie)|sugar[- ]?free|diet\s*(?:drink|soda|beverage)|low[- ]?(?:calorie|energy)|no[- ]?(?:calorie|sugar)|non[- ]?(?:caloric|nutritive)|artificially\s+sweetened/i.test(normalized) &&
    /(?:탄산|음료|콜라|사이다|beverage|drink|soda|soft drink)/i.test(normalized);
  if (zeroOrSugarFreeDrink) {
    const matches = (value: string) => /\b(?:zero[- ]?(?:sugar|calorie)|sugar[- ]?free|diet(?:\s+(?:soda|soft\s+drink|beverage))?|low[- ]?(?:calorie|energy)|no[- ]?(?:calorie|sugar)|non[- ]?(?:caloric|nutritive)|artificially\s+sweetened(?:\s+(?:beverage|drink|soda|soft\s+drink))?)\b/i.test(value);
    return {
      canonical: "zero-calorie carbonated beverage",
      // "Artificially sweetened beverage" is the standard umbrella term in
      // the longitudinal literature. It is kept as an explicitly labelled
      // close academic term, never confused with sugar-sweetened beverages.
      requiredTerms: ["zero-calorie carbonated beverage", "diet soda", "sugar-free carbonated beverage", "artificially sweetened beverage"],
      matches,
      rejects: (value) => /\b(?:sugar[- ]sweetened|added\s+sugar|\bssbs?\b)\b/i.test(value) && !matches(value),
      requiresContextMarker: true
    };
  }

  const decaffeinated = /디카페인|카페인\s*없|decaffeinated|caffeine[- ]?free/i.test(normalized);
  if (decaffeinated) {
    const matches = (value: string) => /\b(?:decaffeinated|caffeine[- ]?free)\b/i.test(value);
    return {
      canonical: "decaffeinated beverage",
      requiredTerms: ["decaffeinated beverage", "decaffeinated coffee", "caffeine-free beverage"],
      matches,
      rejects: (value) => /\bcaffeinated\b/i.test(value) && !matches(value),
      requiresContextMarker: true
    };
  }
  return undefined;
}

function sanitizeResearchIntent(value: GeminiSearchPlanJson["intent"], question?: string): ResearchIntent | undefined {
  if (!value) return undefined;
  const rawExposure = sanitizePlannerLabel(value.exposure);
  const rawExposureTerms = sanitizePlannerConcepts(value.exposure_terms);
  const rawComparator = sanitizePlannerLabel(value.comparator);
  const repairedComparison = explicitlyAsksForComparison(question)
    ? repairCollapsedComparison(rawExposure, rawExposureTerms, rawComparator, sanitizePlannerConcepts(value.comparator_terms))
    : undefined;
  const exposure = repairedComparison?.exposure ?? rawExposure;
  const exposureTerms = repairedComparison?.exposureTerms ?? rawExposureTerms;
  const candidateComparatorTerms = distinctComparatorConcepts(
    repairedComparison?.comparatorTerms ?? sanitizePlannerConcepts(value.comparator_terms),
    exposureTerms.length > 0 ? exposureTerms : exposure ? [exposure] : []
  );
  const plannedOutcomeTerms = sanitizePlannerConcepts(value.outcome_terms);
  const populationTerms = sanitizePlannerConcepts(value.population_terms);
  const preferredStudyDesigns = sanitizePlannerConcepts(value.preferred_study_designs);
  const broadTopicQuestion = Boolean(question) && isBroadTopicQuestion(question!);
  // A model can correctly identify a broad topic even when the Korean
  // surface-form detector does not recognise its wording (for example,
  // "X는 몸에 진짜 안 좋을까?"). An explicit `other` plan with no endpoint is
  // sufficient evidence that this is a topic overview, not an incomplete
  // question.
  const topicLevelQuestion =
    (value.question_type === "other" && plannedOutcomeTerms.length === 0) ||
    (broadTopicQuestion && (
      plannedOutcomeTerms.length === 0 ||
      plannedOutcomeTerms.every(isGenericTopicOutcome)
    ));
  // "위고비와 마운자로 차이" names both options and no endpoint, because the
  // reader does not yet know which endpoints matter. Rejecting the plan for a
  // missing outcome discarded the whole retrieval and answered "검색을 제대로
  // 수행하지 못했습니다" -- and only sometimes, depending on whether the model
  // volunteered an outcome that call. Two named options are a complete
  // question on their own.
  const openComparison = value.question_type === "comparison" &&
    plannedOutcomeTerms.length === 0 &&
    candidateComparatorTerms.length > 0;
  if (!exposure || (plannedOutcomeTerms.length === 0 && !topicLevelQuestion && !openComparison)) return undefined;

  const questionTypes: ResearchIntent["questionType"][] = [
    "comparison",
    "causal",
    "association",
    "dosage",
    "safety",
    "diagnostic",
    "other"
  ];
  const timeHorizons: ResearchIntent["timeHorizon"][] = ["acute", "short_term", "long_term", "mixed", "unspecified"];
  const plannedQuestionType = questionTypes.includes(value.question_type as ResearchIntent["questionType"])
    ? value.question_type as ResearchIntent["questionType"]
    : "other";
  // A comparison is only valid when the user explicitly asked to compare
  // options. The model may use alternatives as search context, but they
  // cannot become the user's comparator.
  const questionType = topicLevelQuestion
    ? "other"
    : plannedQuestionType === "comparison" && !explicitlyAsksForComparison(question)
    ? "causal"
    : plannedQuestionType;
  const comparatorTerms = questionType === "comparison" ? candidateComparatorTerms : [];
  const comparator = comparatorTerms.length > 0
    ? repairedComparison?.comparator ?? rawComparator
    : undefined;
  const timeHorizon = timeHorizons.includes(value.time_horizon as ResearchIntent["timeHorizon"])
    ? value.time_horizon as ResearchIntent["timeHorizon"]
    : "unspecified";
  const outcomeTerms = topicLevelQuestion ? [] : plannedOutcomeTerms;
  // The planner's canonical exposure is part of the retrieval contract, not
  // merely a label. Keeping it beside model-generated synonyms prevents a
  // synonym ordering change from removing the subject the user actually
  // asked about from later search and matching stages.
  const resolvedExposureTerms = [...new Set([exposure, ...exposureTerms])];
  // The planner has one opportunity to define the retrieval contract. Its
  // synonyms are alternatives within a concept group; only exposure,
  // explicitly named comparator, and requested outcome become requirements.
  const directEvidenceGroups = topicLevelQuestion
    ? [resolvedExposureTerms]
    : buildDirectEvidenceGroups(resolvedExposureTerms, comparatorTerms, outcomeTerms, questionType);
  const requestedEvidenceStrategy = value.evidence_strategy === "direct_then_contextual" ? "direct_then_contextual" : "direct_only";
  const plannedContextualEvidenceTerms = sanitizePlannerConcepts(value.contextual_evidence_terms);
  // A topic overview may use a broader nutrient/category as a transparent
  // second layer, but that is not an alias for the exact item. Keep this
  // field for same-item contextual searches and reserve parent evidence for
  // outcome-linked parent queries below. Without this separation, "lard" can
  // turn into a grab bag of unrelated animal-fat cancer, pregnancy, and
  // stroke papers.
  const sameItemContextualTerms = topicLevelQuestion
    ? termsAnchoredToExposure(plannedContextualEvidenceTerms, exposure)
    : plannedContextualEvidenceTerms;
  const contextualEvidenceTerms = [...new Set([
    ...sameItemContextualTerms,
    ...(sameItemContextualTerms.length === 0
      ? buildFallbackContextualEvidenceTerms(resolvedExposureTerms, outcomeTerms)
      : [])
  ])].slice(0, topicLevelQuestion ? 2 : 4);
  const directContextTerms = questionType !== "comparison" && requestedEvidenceStrategy === "direct_then_contextual"
    ? sanitizeEvidenceLadderTerms(value.direct_context_terms, "direct")
    : [];
  const plannedParentEvidenceTerms = questionType !== "comparison" && requestedEvidenceStrategy === "direct_then_contextual"
    ? sanitizeEvidenceLadderTerms(value.parent_evidence_terms, "parent")
    : [];
  const parentEvidenceTerms = plannedParentEvidenceTerms;
  // Topic-overview questions still need an explicitly planned bridge when
  // the exact product has sparse human-outcome literature. The renderer
  // keeps that material labelled as contextual; it never promotes it to
  // direct proof of the exact item.
  const evidenceStrategy = questionType !== "comparison" && requestedEvidenceStrategy === "direct_then_contextual" &&
    (topicLevelQuestion
      ? contextualEvidenceTerms.length > 0 || parentEvidenceTerms.length > 0
      : directContextTerms.length > 0 || parentEvidenceTerms.length > 0)
    ? "direct_then_contextual"
    : "direct_only";

  return {
    questionType,
    exposure,
    exposureTerms: resolvedExposureTerms,
    comparator,
    comparatorTerms,
    outcomeTerms,
    populationTerms,
    timeHorizon,
    preferredStudyDesigns: preferredStudyDesigns.length > 0 ? preferredStudyDesigns : ["systematic review"],
    directEvidenceGroups,
    evidenceStrategy,
    contextualEvidenceTerms,
    directContextTerms,
    parentEvidenceTerms
  };
}

function repairCollapsedComparison(
  rawExposure: string | undefined,
  rawExposureTerms: string[],
  rawComparator: string | undefined,
  rawComparatorTerms: string[]
): { exposure: string; exposureTerms: string[]; comparator: string; comparatorTerms: string[] } | undefined {
  if (!rawExposure) return undefined;
  // A planner occasionally serialises "A; B" as one exposure and gives a
  // broad class as the comparator. Recover the two explicit entities from its
  // own ordered output; no product or food dictionary is involved.
  const labels = rawExposure
    .split(/\s*(?:;|\||\/|\band\b|&|\+)\s*/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  if (labels.length < 2) return undefined;
  const [left, right] = labels;
  if (!left || !right) return undefined;
  const rightIndex = rawExposureTerms.findIndex((term) => conceptContainsLabel(term, right));
  const leftTerms = (rightIndex > 0 ? rawExposureTerms.slice(0, rightIndex) : rawExposureTerms.filter((term) => conceptContainsLabel(term, left)));
  const rightTerms = [
    ...(rightIndex >= 0 ? rawExposureTerms.slice(rightIndex) : rawExposureTerms.filter((term) => conceptContainsLabel(term, right))),
    ...rawComparatorTerms
  ];
  const exposureTerms = [...new Set([left, ...leftTerms])].slice(0, 6);
  const comparatorTerms = [...new Set([right, ...rightTerms])]
    .filter((term) => !conceptContainsLabel(term, left) || conceptContainsLabel(term, right))
    .slice(0, 6);
  if (exposureTerms.length === 0 || comparatorTerms.length === 0) return undefined;
  return { exposure: left, exposureTerms, comparator: right, comparatorTerms };
}

function conceptContainsLabel(concept: string, label: string): boolean {
  const normalizedConcept = concept.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ");
  const labelTokens = label.toLowerCase().split(/[^a-z0-9가-힣]+/).filter((token) => token.length >= 2);
  return labelTokens.length > 0 && labelTokens.every((token) => normalizedConcept.includes(token));
}

interface ExplicitFoodComparison {
  exposure: string;
  exposureTerms: string[];
  comparator: string;
  comparatorTerms: string[];
  outcomeTerms: string[];
}

function resolveExplicitFoodComparison(question: string | undefined): ExplicitFoodComparison | undefined {
  if (!question || !explicitlyAsksForComparison(question)) return undefined;
  const foods = [
    { pattern: /돼지고기|삼겹살|pork/i, label: "pork", terms: ["pork", "pork meat", "lean pork", "pork loin"] },
    { pattern: /닭고기|닭가슴살|chicken/i, label: "chicken", terms: ["chicken", "chicken meat", "poultry", "chicken breast"] },
    { pattern: /소고기|쇠고기|beef/i, label: "beef", terms: ["beef", "beef meat"] },
    { pattern: /생선|어류|fish/i, label: "fish", terms: ["fish", "fish protein"] },
    { pattern: /달걀|계란|egg/i, label: "egg", terms: ["egg", "egg protein"] },
    { pattern: /우유|milk/i, label: "milk", terms: ["milk", "dairy protein"] },
    { pattern: /요거트|요구르트|yogurt/i, label: "yogurt", terms: ["yogurt", "fermented dairy"] }
  ]
    .map((food) => ({ ...food, position: question.search(food.pattern) }))
    .filter((food) => food.position >= 0)
    .sort((left, right) => left.position - right.position);
  if (foods.length < 2) return undefined;

  const [exposure, comparator] = foods;
  const asksProteinQuality = /단백질|protein|근육|근성장|근육량|포만/i.test(question);
  return {
    exposure: exposure!.label,
    exposureTerms: exposure!.terms,
    comparator: comparator!.label,
    comparatorTerms: comparator!.terms,
    outcomeTerms: asksProteinQuality
      ? [
        "protein quality",
        "protein digestibility",
        "protein bioaccessibility",
        "protein efficiency ratio",
        "crude protein",
        "protein concentration",
        "amino acid profile",
        "free amino acid",
        "essential amino acid bioavailability",
        "muscle protein synthesis"
      ]
      : ["health outcomes"]
  };
}

function buildDirectEvidenceGroups(
  exposureTerms: string[],
  comparatorTerms: string[],
  outcomeTerms: string[],
  questionType: ResearchIntent["questionType"]
): string[][] {
  const groups = [exposureTerms];
  if (questionType === "comparison" && comparatorTerms.length > 0) groups.push(comparatorTerms);
  if (outcomeTerms.length > 0) groups.push(outcomeTerms);
  return groups.map((group) => group.slice(0, 6)).filter((group) => group.length > 0);
}

function explicitlyAsksForComparison(question: string | undefined): boolean {
  if (!question) return false;
  const clean = question.toLowerCase().replace(/\s+/g, " ").trim();
  return /(?:\bvs\.?\b|\bversus\b|\bcompared?\s+(?:with|to)\b|\bcomparison\b|비교|차이|보다|어느\s*(?:것|게|쪽|편)|뭐가\s*(?:더|좋|나쁘)|어떤\s*(?:것|게|쪽).*(?:더|좋|나쁘)|둘\s*(?:중|가운데)|[가-힣]+(?:와|과|하고|및)\s*[가-힣]+\s*(?:중(?:에)?|가운데)|대신|대체)/i.test(clean);
}

function asksForSingleExposureQuestion(question: string | undefined): boolean {
  if (!question) return false;
  return /(?:만으로|단독(?:으로)?|혼자(?:서)?|\balone\b|\bonly\b|\bsolely\b|\bby itself\b)/i.test(question);
}

function termsAnchoredToExposure(terms: string[], exposure: string): string[] {
  const anchorTokens = new Set(exposure.toLowerCase().split(/[^a-z0-9가-힣]+/i).filter((token) => token.length >= 4));
  if (anchorTokens.size === 0) return terms;
  return terms.filter((term) =>
    term.toLowerCase().split(/[^a-z0-9가-힣]+/i).some((token) => anchorTokens.has(token))
  );
}

function isGenericTopicOutcome(value: string): boolean {
  return /^(?:health benefits?|health effects?|health risks?|health outcomes?|adverse health effects?|efficacy|therapeutic effects?|benefits?)$/i.test(value.trim());
}

function isCookingFatTopic(exposureTerms: string[]): boolean {
  return /\b(?:fat|oil|lard|tallow|ghee|butter|shortening)\b/i.test(exposureTerms.join(" "));
}

function supportsEvidenceLadderStrategy(exposureTerms: string[]): boolean {
  const exposure = exposureTerms.join(" ").toLowerCase();
  // The two-layer strategy is reserved for genuinely narrow named items or
  // combinations. Ordinary interventions and public-health behaviors already
  // have established research categories and should use direct-then-contextual
  // retrieval instead of being treated like a niche product.
  return !/\b(?:exercise|training|commuting|cycling|walking|running|work|school|sleep|screen|therapy|treatment|intervention|policy|restriction|behavior|behaviour)\b/.test(exposure);
}

function buildFallbackContextualEvidenceTerms(exposureTerms: string[], outcomeTerms: string[]): string[] {
  const exposure = exposureTerms.find((term) => !/\d/.test(term)) ?? exposureTerms[0];
  const outcome = outcomeTerms[0];
  const query = [exposure, outcome].filter(Boolean).join(" ").trim();
  return query ? [query] : [];
}

function sanitizeEvidenceLadderTerms(
  items: string[] | undefined,
  layer: "direct" | "parent",
  requireReplacement = false
): string[] {
  const terms = sanitizePlannerConcepts(items);
  const banned = /^(?:dietary fats?|animal fats?|health effects?|health risks?|saturated fat intake)$/i;
  if (layer === "direct") {
    return terms.filter((term) =>
      !banned.test(term) && /\b(?:composition|profile|biomarker|oxidation|characteri[sz]ation|dose|co-?ingestion|combined consumption|digestibility|digestive tolerance|bioavailability|absorption)\b/i.test(term)
    );
  }
  return terms.filter((term) =>
    !banned.test(term) &&
    (!requireReplacement || /\breplacement\b/i.test(term)) &&
    /\b(?:replacement|cardiovascular|cholesterol|lipid|mortality|disease|metabolic|glyc(?:e|ae)mic|allerg(?:y|ic)|intolerance|foodborne|salmonella|gastrointestinal|digest(?:ive|ion)|bioavailability|absorption|interaction)\b/i.test(term)
  );
}

function sanitizePlannerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = stripPlannerInstructionEcho(value).replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > 100) return undefined;
  // Strip only the explanatory gloss here. Splitting on separators as well
  // would consume the "A vs B" form that collapsed-comparison repair needs to
  // see further down.
  const withoutGloss = clean.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  return withoutGloss.length >= 2 ? withoutGloss : clean;
}

/**
 * The planner routinely returns a label with its own explanation attached:
 * "zero-sugar beverages (diet drinks containing non-nutritive sweeteners)",
 * "jeotgal (Korean salted fermented seafood) / salted fermented seafood",
 * "chungkukjang (fermented soybean paste; Korean cheonggukjang)". Matching
 * treats a term as a phrase that must appear intact, so none of those ever
 * matched a title and the whole retrieval was discarded.
 *
 * Split every such label into the searchable names it actually contains, head
 * term first, so both the short name and the gloss can match.
 */
export function plannerLabelVariants(label: string): string[] {
  const withoutGloss = label.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const glosses = [...label.matchAll(/\(([^)]*)\)/g)].map((match) => match[1] ?? "");
  const pieces = [withoutGloss, ...glosses]
    .flatMap((piece) => piece.split(/\s*[;/]\s*|\s+,\s+/))
    .map((piece) => piece.replace(/^(?:korean|english)\s+/i, "").replace(/[\s,]+$/, "").trim())
    .filter((piece) => piece.length >= 2 && /[A-Za-z가-힣]/.test(piece));
  return [...new Set(pieces)];
}

function sanitizePlannerConcepts(items: string[] | undefined): string[] {
  const concepts = new Set<string>();
  for (const item of items ?? []) {
    if (typeof item !== "string") continue;
    const clean = stripPlannerInstructionEcho(item.normalize("NFKC"))
      .replace(/\b(?:vs\.?|versus|compared (?:with|to))\b/gi, " ")
      // Planner terms are scholarly English (or a Korean term for a Korean
      // source). Strip another script rather than letting an instruction echo
      // become part of a PubMed query.
      .replace(/[^A-Za-z0-9가-힣\s,;:/&+._-]/g, " ")
      .replace(/["'()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length < 2 || clean.length > 90) continue;
    if (!/[A-Za-z가-힣]/.test(clean)) continue;
    // The character filter above turns a parenthetical gloss into a run-on
    // phrase ("zero-sugar beverages diet drinks containing non-nutritive
    // sweeteners") that matches no title. Add the pieces of the original as
    // separate terms, after the same instruction-echo cleaning.
    for (const variant of plannerLabelVariants(stripPlannerInstructionEcho(item.normalize("NFKC")))) {
      const variantClean = variant.replace(/["'()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
      if (variantClean.length < 2 || variantClean.length > 90) continue;
      if (!/[A-Za-z가-힣]/.test(variantClean)) continue;
      if (/\b(?:synonyms?|academic\s+english|scholarly)\b/i.test(variantClean)) continue;
      concepts.add(variantClean);
    }
    if (/\b(?:synonyms?\s+in\s+academic\s+english|english\s+scholarly\s+synonyms?|academic\s+english|scholarly\s+(?:term|query|phrase))\b/i.test(clean)) continue;
    concepts.add(clean);
  }
  return [...concepts].slice(0, 6);
}

// A model occasionally returns its own unfinished instruction as part of a
// query (for example, "Brand X (resolve canonical)"). Keep the candidate
// entity, but never let an instruction fragment reach an academic database.
function stripPlannerInstructionEcho(value: string): string {
  return value
    .replace(/\s*[\[(]?\s*(?:resolve|resolving)\s+(?:to\s+)?(?:the\s+)?canonical(?:\s+(?:academic|drug|generic|english|entity|name|term))*\b[^)\]]*(?:[)\]])?/gi, " ")
    .replace(/\b(?:canonical\s+(?:academic|drug|generic|english)\s+(?:entity|name|term))\b/gi, " ");
}

function distinctComparatorConcepts(comparatorTerms: string[], exposureTerms: string[]): string[] {
  const exposureTokens = plannerConceptTokens(exposureTerms);
  return comparatorTerms.filter((term) =>
    [...plannerConceptTokens([term])].some(
      (token) => !exposureTokens.has(token) && !genericComparatorTokens.has(token)
    )
  );
}

function plannerConceptTokens(terms: string[]): Set<string> {
  return new Set(
    terms.flatMap((term) => term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  );
}

const genericComparatorTokens = new Set([
  "control",
  "habitual",
  "no",
  "non",
  "none",
  "placebo",
  "usual",
  "without"
]);

function intentQueryTerms(intent: ResearchIntent): string[] {
  return [
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms,
    ...intent.populationTerms,
    ...intent.preferredStudyDesigns,
    ...(intent.directEvidenceGroups ?? []).flat(),
    ...(intent.contextualEvidenceTerms ?? []),
    ...(intent.directContextTerms ?? []),
    ...(intent.parentEvidenceTerms ?? [])
  ].slice(0, 20);
}

export function buildIntentSearchQueries(intent: ResearchIntent): string[] {
  const exposure = plannerQueryGroup(intent.exposureTerms);
  const comparator = plannerQueryGroup(intent.comparatorTerms);
  const outcomes = plannerQueryGroup(intent.outcomeTerms.slice(0, 3));
  const preferredDesigns = plannerQueryGroup(intent.preferredStudyDesigns.slice(0, 3));
  const reviewDesigns = plannerQueryGroup(["systematic review", "meta analysis", "umbrella review"]);
  const contextualEvidence = plannerQueryGroup(intent.contextualEvidenceTerms ?? []);
  const primaryDesigns = plannerQueryGroup([
    ...intent.preferredStudyDesigns.filter((design) => !/(review|meta|guideline|consensus)/i.test(design)),
    "randomized controlled trial",
    "cohort study"
  ].slice(0, 4));
  const guidanceDesigns = plannerQueryGroup(["umbrella review", "consensus statement", "guideline"]);
  const directEvidenceGroups = intent.directEvidenceGroups ?? [];
  const directEvidenceCore = directEvidenceGroups
    .map((group) => plannerQueryGroup(group))
    .filter(Boolean)
    .join(" AND ");
  const core = directEvidenceCore || [exposure, comparator, outcomes].filter(Boolean).join(" AND ");
  if (intent.questionType === "comparison" && exposure && comparator) {
    // Search for a true head-to-head paper first, then retrieve each option's
    // outcome evidence separately when no direct comparison exists.
    const directComparison = core;
    const exposureEvidence = [exposure, outcomes, reviewDesigns || primaryDesigns].filter(Boolean).join(" AND ");
    const comparatorEvidence = [comparator, outcomes, reviewDesigns || primaryDesigns].filter(Boolean).join(" AND ");
    return [...new Set([
      directComparison,
      exposureEvidence,
      comparatorEvidence
    ].map((query) => query.trim()).filter(Boolean))].slice(0, 4);
  }
  const exposureSpecificCores = directEvidenceGroups.length >= 2
    ? directEvidenceGroups[0]!
      .slice(0, 2)
      .map((term) => [plannerQueryGroup([term]), ...directEvidenceGroups.slice(1).map((group) => plannerQueryGroup(group))]
        .filter(Boolean)
        .join(" AND "))
    : [];
  const focusedCores = exposureSpecificCores.length > 0
    ? exposureSpecificCores
    : intent.exposureTerms
    .slice(0, 2)
    .map((term) => [plannerQueryGroup([term]), comparator, outcomes].filter(Boolean).join(" AND "));
  // Adding the population as a fourth AND clause was tried and reverted: it
  // widened the pool with sleep-in-children papers that had nothing to do with
  // the asked outcome, and "일찍 자면 키가 클까?" came back citing myopia,
  // bedtime procrastination and screen time. Off-topic evidence is worse than
  // none, so the outcome stays the binding constraint.
  const directQueries = [
    [core, reviewDesigns].filter(Boolean).join(" AND "),
    core,
    contextualEvidence || [focusedCores[0] ?? core, primaryDesigns || preferredDesigns || guidanceDesigns].filter(Boolean).join(" AND ")
  ];
  if (intent.evidenceStrategy !== "direct_then_contextual") {
    return [...new Set(directQueries.map((query) => query.trim()).filter(Boolean))].slice(0, 3);
  }

  const directContext = plannerQueryGroup(intent.directContextTerms ?? []);
  const parentEvidence = plannerQueryGroup(intent.parentEvidenceTerms ?? []);
  const contextualQueries = [
    directContext,
    [parentEvidence || contextualEvidence, reviewDesigns].filter(Boolean).join(" AND ")
  ];
  return [...new Set([
    ...directQueries.slice(0, 2),
    ...contextualQueries
  ].map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

export function buildFastFoodProteinComparisonPlan(
  question: string,
  category: Exclude<Category, "auto">
): SearchPlan | undefined {
  const foods = resolveExplicitFoodComparison(question);
  if (!foods || !foods.outcomeTerms.some((term) => /(?:protein|amino|diaas)/i.test(term))) return undefined;
  const intent: ResearchIntent = {
    questionType: "comparison",
    exposure: foods.exposure,
    exposureTerms: foods.exposureTerms,
    comparator: foods.comparator,
    comparatorTerms: foods.comparatorTerms,
    outcomeTerms: foods.outcomeTerms,
    populationTerms: [],
    timeHorizon: "unspecified",
    preferredStudyDesigns: ["comparative study"],
    directEvidenceGroups: buildDirectEvidenceGroups(
      foods.exposureTerms,
      foods.comparatorTerms,
      foods.outcomeTerms,
      "comparison"
    ),
    evidenceStrategy: "direct_only",
    contextualEvidenceTerms: [
      `${foods.exposure} protein quality`,
      `${foods.comparator} protein quality`
    ]
  };
  return {
    category,
    queryTerms: intentQueryTerms(intent),
    searchQueries: buildIntentSearchQueries(intent),
    intent,
    claimDirection: "unclear",
    plannedBy: "fallback",
    reason_ko: "명시된 식품과 단백질 지표를 빠른 직접 비교 검색식으로 구조화했습니다."
  };
}

function isFoodProteinQualityComparisonIntent(intent: ResearchIntent): boolean {
  if (intent.questionType !== "comparison") return false;
  return intent.outcomeTerms.some((term) =>
    /(?:protein\s*(?:quality|digestibility|bioaccessibility|content|efficiency)|amino\s+acid|diaas|essential\s+amino)/i.test(term)
  );
}

function plannerQueryGroup(terms: string[]): string {
  const clean = sanitizePlannerConcepts(terms);
  if (clean.length === 0) return "";
  return clean.length === 1 ? clean[0]! : `(${clean.join(" OR ")})`;
}

function sanitizeQueryTerms(items: string[] | undefined, fallback: string[]): string[] {
  const clean = (items ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 80)
    .slice(0, 12);
  return clean.length > 0 ? clean : fallback;
}

function isVerdict(value: unknown): value is Verdict {
  return ["supported", "mixed", "not_supported", "insufficient_evidence"].includes(String(value));
}

function isStance(value: unknown): value is EvidenceStance {
  return ["supports", "opposes", "mixed", "unclear"].includes(String(value));
}

function trimForPrompt(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function geminiUrl(config: Config): string {
  const model = encodeURIComponent(config.geminiModel);
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  url.searchParams.set("key", config.geminiApiKey ?? "");
  return url.toString();
}
