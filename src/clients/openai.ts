import type { Config } from "../config.js";
import type { Category, ClaimAnswer, EvidenceSearchResult, Paper, ResearchIntent } from "../types.js";
import {
  buildClaimSynthesisPayload,
  buildSearchPlanFromModel,
  evidenceForCitations,
  mergeModelAnswer,
  type ModelClaimJson,
  type SearchPlan
} from "./gemini.js";

interface OpenAiResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: { message?: string };
}

export interface HostMcpLocalizationSource {
  paperId: string;
  title: string;
  result: string;
}

export interface HostMcpLocalizedPaper {
  paperId: string;
  titleKo: string;
  resultKo: string;
  headlineKo: string;
}

interface HostMcpLocalizationResponse {
  papers?: Array<{
    paper_id?: unknown;
    title_ko?: unknown;
    result_ko?: unknown;
    headline_ko?: unknown;
  }>;
}

interface EvidenceTermExpansion {
  terms?: Array<{
    term?: unknown;
    relation?: unknown;
    source_indices?: unknown;
  }>;
}

interface GroundedFindingResponse {
  findings?: Array<{
    index?: unknown;
    candidate_index?: unknown;
    result_ko?: unknown;
    headline_ko?: unknown;
  }>;
}

export interface GroundedPaperFinding {
  index: number;
  resultKo: string;
  /** The same finding in one scannable clause, for the at-a-glance table. */
  headlineKo?: string;
  sourceSentence: string;
}

export interface FastHostQueryPlan {
  academicQuery: string;
  topicTerms: string[];
  outcomeTerms: string[];
  category: Exclude<Category, "auto">;
}

export class OpenAiRagClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.openaiApiKey);
  }

  async planSearch(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackTerms: string[]
  ): Promise<SearchPlan> {
    if (!this.config.openaiApiKey) {
      return {
        category: fallbackCategory,
        queryTerms: fallbackTerms,
        searchQueries: [],
        plannedBy: "fallback",
        reason_ko: "OpenAI key 없음. 규칙 기반 검색어 사용."
      };
    }

    const payload = {
      question,
      fallback_category: fallbackCategory,
      vocabulary_candidates: fallbackTerms.slice(0, 14),
      required_json: {
        category: "health | nutrition | exercise | psychology | childcare | education",
        claim_direction: "benefit | harm | association | unclear",
        intent: {
          question_type: "comparison | causal | association | dosage | safety | diagnostic | other",
          exposure: "canonical academic English entity",
          exposure_terms: ["English scholarly synonyms, including generic drug name"],
          comparator: "only if the user explicitly compares two options",
          comparator_terms: ["English scholarly synonyms"],
          outcome_terms: ["the requested measurable endpoint"],
          population_terms: ["optional population"],
          time_horizon: "acute | short_term | long_term | mixed | unspecified",
          preferred_study_designs: ["systematic review", "randomized controlled trial"],
          direct_evidence_groups: [["synonyms for one required concept"]],
          evidence_strategy: "direct_only | direct_then_contextual",
          contextual_evidence_terms: ["same-item scholarly query that keeps the named item"],
          direct_context_terms: ["exact-item characterization or human biomarker query"],
          parent_evidence_terms: ["parent-category human-health query that includes a measurable outcome"]
        },
        reason_ko: "short Korean reason"
      },
      rules: [
        "Analyze intent only. Do not answer the user.",
        "Resolve Korean brand names, abbreviations, and obvious typos to the canonical academic English entity before searching.",
        "Never include a brand name unless it is an established brand for the same canonical entity. If a brand match is uncertain, omit it rather than guessing.",
        "For an explicit A-versus-B question, put exactly one named option and only its synonyms in exposure/exposure_terms, and the other named option and only its synonyms in comparator/comparator_terms. Never merge both options into exposure_terms or replace a named option with its broader class.",
        "For a medication side-effect or safety question, use question_type safety and include adverse events, serious adverse events, drug safety, and relevant common event categories in outcome_terms. Do not substitute efficacy, weight change, mood, or disease-prevention outcomes for safety outcomes.",
        "Natural Korean safety questions such as '먹어도 될까?', '마셔도 될까?', '가끔/매일 먹어도 괜찮아?', '안전해?' and '문제 없을까?' are safety questions even when the user does not say 'risk' or 'side effect'. Use question_type safety and plan actual adverse-event or physiological-safety outcomes.",
        "Put exposure and requested outcome in separate direct_evidence_groups. Equivalent synonyms belong in the same group.",
        "For a broad topic question without an endpoint, use question_type other and outcome_terms [].",
        "Questions such as 'X is actually good or bad?' ask for a topic-wide evidence review, not a missing endpoint. Use question_type other, outcome_terms [], and resolve X to canonical academic English terms. For example, food fats must use the actual food-fat term rather than the Korean wording.",
        "For a named food, oil, fat, drink, or substance whose direct human outcome literature may be sparse, keep the exact item in exposure_terms. An exposure alias must denote the same item, not a broader category that could include a different product, ingredient, medicine, or intervention. contextual_evidence_terms may contain only same-item aliases or exact-item queries; every term must still name the asked item. Put broader parent evidence in parent_evidence_terms, not contextual_evidence_terms.",
        "Every parent_evidence_terms entry must be a complete scholarly health query with a measurable outcome, not a bare category. For example, use a parent nutrient replacement query tied to LDL cholesterol or cardiovascular events, rather than just 'animal fats' or 'dietary fats'. A parent query is a retrieval bridge only and must not be treated as direct proof about the named item.",
        "For a broad good-or-bad question, return direct_context_terms and parent_evidence_terms when useful. Do not search a parent category with no outcome because it mixes unrelated diseases and populations into one answer.",
        "Use direct_only unless the question is broad and a parent-topic bridge is needed; then use direct_then_contextual. Return JSON only."
      ]
    };
    let lastError: unknown;
    // A structured response can occasionally end mid-object despite a valid
    // HTTP response. Retry the planner once with room for a complete JSON
    // object rather than degrading to a literal-keyword search.
    for (const maxOutputTokens of [1_800, 2_400]) {
      try {
        const response = await this.fetchFn("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.openaiApiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.config.openaiModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: maxOutputTokens,
            input: [
              {
                role: "system",
                content: "You turn Korean research questions into a strict, evidence-retrieval plan. Return JSON only."
              },
              { role: "user", content: JSON.stringify(payload) }
            ],
            text: { format: { type: "json_object" } }
          })
        });
        const json = (await response.json()) as OpenAiResponse;
        if (!response.ok) {
          throw new Error(`OpenAI search planning failed: ${response.status}${json.error?.message ? ` ${json.error.message}` : ""}`);
        }
        const text = readOutputText(json);
        if (!text) throw new Error("OpenAI search planning returned empty text");
        return buildSearchPlanFromModel(parseJson(text), question, fallbackCategory, fallbackTerms, "openai");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenAI search planning failed");
  }

  /**
   * The public Kakao tool only asks the host for the Korean question. This
   * compact planner resolves just the fields the scholarly indexes need,
   * avoiding the much larger full-answer retrieval plan on the latency path.
   */
  async planHostQueryFast(
    question: string,
    fallbackCategory: Exclude<Category, "auto">
  ): Promise<FastHostQueryPlan> {
    if (!this.config.openaiApiKey) throw new Error("OpenAI key 없음");
    const model = this.config.openaiFastPlannerModel ?? "gpt-5-nano";
    const response = await this.fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        ...(model.startsWith("gpt-5") ? { reasoning: { effort: "minimal" } } : {}),
        max_output_tokens: 400,
        input: [
          {
            role: "system",
            content: "Create a compact scholarly retrieval plan. topic_terms are exposure synonyms only, never outcomes. outcome_terms are requested endpoints only. category must be exactly one allowed value. Return JSON only."
          },
          {
            role: "user",
            content: JSON.stringify({
              question,
              fallback_category: fallbackCategory,
              allowed_categories: ["health", "nutrition", "exercise", "psychology", "childcare", "education"],
              required_json: {
                topic_terms: ["up to four English synonyms for the exact exposure only"],
                outcome_terms: ["up to four English synonyms for the requested endpoint only"],
                category: "exactly one allowed category"
              }
            })
          }
        ],
        text: { format: { type: "json_object" } }
      })
    });
    const json = (await response.json()) as OpenAiResponse;
    if (!response.ok) {
      throw new Error(`OpenAI fast host planning failed: ${response.status}${json.error?.message ? ` ${json.error.message}` : ""}`);
    }
    const text = readOutputText(json);
    if (!text) throw new Error("OpenAI fast host planning returned empty text");
    return normalizeFastHostQueryPlan(parseJson<Record<string, unknown>>(text), fallbackCategory);
  }

  /**
   * Broad food questions need two deliberately separate routes: evidence
   * about the exact item, and (only when defensible) a parent nutrient or
   * exposure with an actual health endpoint. This is a retrieval-plan repair
   * only. It never supplies a conclusion, result, or citation to the user.
   */
  async repairBroadNutritionPlan(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackTerms: string[],
    currentPlan: SearchPlan
  ): Promise<SearchPlan | undefined> {
    if (!this.config.openaiApiKey || !currentPlan.intent) return undefined;

    const payload = {
      question,
      current_retrieval_contract: {
        category: currentPlan.category,
        exposure: currentPlan.intent.exposure,
        exposure_terms: currentPlan.intent.exposureTerms,
        contextual_evidence_terms: currentPlan.intent.contextualEvidenceTerms ?? [],
        direct_context_terms: currentPlan.intent.directContextTerms ?? [],
        parent_evidence_terms: currentPlan.intent.parentEvidenceTerms ?? []
      },
      required_json: {
        category: "nutrition",
        claim_direction: "benefit | harm | association | unclear",
        intent: {
          question_type: "other",
          exposure: "preserve the canonical academic English item",
          exposure_terms: ["up to four same-item scholarly synonyms only"],
          comparator_terms: [],
          outcome_terms: [],
          population_terms: [],
          time_horizon: "acute | short_term | long_term | mixed | unspecified",
          preferred_study_designs: ["systematic review", "randomized controlled trial"],
          direct_evidence_groups: [["same-item synonyms only"]],
          evidence_strategy: "direct_then_contextual",
          contextual_evidence_terms: ["at most one same-item human health query"],
          direct_context_terms: ["at most one same-item human biomarker or health outcome query"],
          parent_evidence_terms: ["one or two broader, defensible parent queries with a measured health endpoint"]
        },
        reason_ko: "short Korean retrieval-plan reason"
      },
      rules: [
        "Repair the retrieval plan only. Do not answer the user and do not state a health conclusion.",
        "This is a broad consumer food, drink, oil, fat, or ingredient health question without one named endpoint.",
        "Keep the named item and its true scholarly aliases in exposure/exposure_terms. Do not replace it with a parent category.",
        "Use question_type other, outcome_terms [], direct_evidence_groups containing only same-item terms, and evidence_strategy direct_then_contextual.",
        "direct_context_terms and contextual_evidence_terms must keep the exact named item. They may ask about human health outcomes or biomarkers, but may not use a broader item as an alias.",
        "The current plan is incomplete because it lacks a broad parent route. For a common edible food, drink, oil, fat, or ingredient, derive the most specific defensible nutritional component or parent exposure and add one or two parent_evidence_terms. For example, infer the relevant lipid, carbohydrate, protein, caffeine, or sweetener class from the asked item. A parent term must not repeat the exact item name: it must name the broader component/exposure plus a measurable human health endpoint. It is contextual evidence, never direct proof of the named item.",
        "Never use food production, animal feed, farming, supply chains, sustainability, product composition, packaging, preservation, fermentation, cosmetics, or biomedical materials as a health-evidence route.",
        "Use short values. Do not add any JSON keys beyond required_json. Return JSON only."
      ]
    };

    let lastError: unknown;
    // The repair schema has enough nested fields that a valid model response
    // can otherwise end mid-JSON. Retry once with room for a complete object,
    // just as the primary planner does, rather than falling back to the
    // original weak plan.
    for (const maxOutputTokens of [2_400, 3_000]) {
      try {
        const response = await this.fetchFn("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.openaiApiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.config.openaiModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: maxOutputTokens,
            input: [
              {
                role: "system",
                content: "You repair a strict scholarly retrieval plan for a Korean consumer health question. Return only the requested compact JSON object."
              },
              { role: "user", content: JSON.stringify(payload) }
            ],
            text: { format: { type: "json_object" } }
          })
        });
        const json = (await response.json()) as OpenAiResponse;
        if (!response.ok) {
          throw new Error(`OpenAI broad-nutrition plan repair failed: ${response.status}${json.error?.message ? ` ${json.error.message}` : ""}`);
        }
        const text = readOutputText(json);
        if (!text) throw new Error("OpenAI broad-nutrition plan repair returned empty text");
        return buildSearchPlanFromModel(parseJson(text), question, fallbackCategory, fallbackTerms, "openai");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenAI broad-nutrition plan repair failed");
  }

  /**
   * The first retrieval pass can surface a more precise scholarly name for a
   * broad consumer term. This method only returns terms that occur in those
   * supplied papers; it never supplies evidence or writes the user answer.
   */
  async expandEvidenceTerms(
    question: string,
    intent: ResearchIntent,
    papers: Paper[]
  ): Promise<string[]> {
    if (!this.config.openaiApiKey || papers.length === 0 || intent.outcomeTerms.length === 0) return [];
    const sources = papers
      .filter((paper) => Boolean(paper.abstract?.trim()))
      .slice(0, 16)
      .map((paper, index) => ({
        index: index + 1,
        title: paper.title,
        abstract_excerpt: paper.abstract!.replace(/\s+/g, " ").slice(0, 900)
      }));
    if (sources.length === 0) return [];

    const payload = {
      question,
      intent: {
        exposure: intent.exposure,
        exposure_terms: intent.exposureTerms,
        outcome_terms: intent.outcomeTerms
      },
      source_papers: sources,
      required_json: {
        terms: [{
          term: "exact English scholarly exposure phrase from a supplied title or abstract",
          relation: "same_entity | subtype | parent_category",
          source_indices: [1]
        }]
      },
      rules: [
        "This is a retrieval-expansion step, not evidence synthesis. Do not answer the user.",
        "Return zero to four additional exposure terms only when they are the same entity, a direct subtype, or a direct parent category of the user's exposure.",
        "Every returned term must occur verbatim in at least one supplied source paper and source_indices must identify that paper.",
        "Do not return outcomes, diseases, study designs, treatments, mechanisms, ingredients, or unrelated diet patterns.",
        "A subtype may be returned only when it is a real-world form of the asked broad exposure and the supplied source connects it to the requested outcome.",
        "If the supplied papers do not establish a safe same-entity, subtype, or parent-category term, return an empty array.",
        "Return JSON only."
      ]
    };
    try {
      const response = await this.fetchFn("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.openaiApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.openaiModel,
          reasoning: { effort: "minimal" },
          max_output_tokens: 700,
          input: [
            {
              role: "system",
              content: "You extract source-grounded academic search aliases for a Korean evidence retrieval system. Return JSON only."
            },
            { role: "user", content: JSON.stringify(payload) }
          ],
          text: { format: { type: "json_object" } }
        })
      });
      const json = (await response.json()) as OpenAiResponse;
      if (!response.ok) return [];
      const text = readOutputText(json);
      if (!text) return [];
      return validateEvidenceTermExpansion(parseJson<EvidenceTermExpansion>(text), sources);
    } catch {
      return [];
    }
  }

  /**
   * Converts only explicit abstract result sentences into Korean findings.
   * This is deliberately not answer synthesis: a finding is rejected unless
   * the model identifies the exact source sentence it translated.
   */
  async extractGroundedFindings(
    question: string,
    intent: ResearchIntent | undefined,
    papers: Paper[]
  ): Promise<GroundedPaperFinding[] | undefined> {
    if (!this.config.openaiApiKey) return undefined;
    const sources = papers
      .map((paper, index) => ({
        index: index + 1,
        title: paper.title,
        // A comparison abstract often has both a category-level conclusion
        // and a later item-specific value. Preserve a third candidate so the
        // extractor can select the named item's actual measurement.
        candidateSentences: selectResultCandidates(paper.abstract, intent).slice(0, 3)
      }))
      .filter((paper): paper is { index: number; title: string; candidateSentences: string[] } => paper.candidateSentences.length > 0)
      // Ground more papers than we display, without making the extraction
      // call itself so large that it times out before returning an answer.
      // Six ranked candidates retain competing reviews and a trial while
      // keeping the source-only model call reliably within its deadline.
      .slice(0, 6);
    if (sources.length === 0) return [];

    const payload = {
      question,
      research_intent: intent,
      source_papers: sources.map((source) => ({
        index: source.index,
        candidate_sentences: source.candidateSentences
      })),
      required_json: {
        findings: [{
          index: "one-based source_papers index",
          candidate_index: "one-based candidate_sentences index",
          result_ko: "one concise Korean translation/paraphrase of the chosen candidate sentence only, at most 220 Korean characters",
          headline_ko: "the same finding in one sentence of at most 100 Korean characters for a scan-first table"
        }]
      },
      rules: [
        "This is an evidence extraction gate, not a general answer. Return JSON only.",
        "For each retained paper choose exactly one candidate sentence that explicitly reports a result relevant to the user's question or to an explicitly planned contextual bridge.",
        "result_ko must be one fluent factual Korean sentence translating/paraphrasing only the chosen candidate. Preserve numbers, units, comparison group, direction, and association-versus-causation wording when present, but keep at most two high-value measurements if the source contains a long list. Translate disease names and participant descriptions into Korean instead of leaving English prose. When the sentence reports several sibling exposures but the user asked about only one, include only the named exposure's result and do not repeat the other exposure's number. When the sentence gives a numeric result for the user's specifically named item, prefer that item-specific value over a broader category-level comparison in the same sentence. Never label an outcome score, concentration, dose, or percentage as P/p; use a P or p-value only when that exact statistical notation and value appear in the chosen source sentence. Do not add labels such as '결론:'. Mention 대조군, 위약, 비교군, 비교했을 때, or an explicit causal comparison only when the chosen source sentence itself names a comparator. Write odds ratio as '오즈비(OR)' rather than the bare word '오즈'.",
        "Reject method, objective, prevalence, consumer-pattern, motivation, background, or general topic sentences. A sentence saying that a review examined, explored, assessed, or included something is not a result.",
        "Do not infer a result from the title, write medical advice, add external knowledge, or use vague filler such as 'an effect was reported' or 'could not be extracted'.",
        "For safety questions, keep only actual adverse-event, blood-pressure, heart-rate, rhythm, sleep, anxiety, toxicity, or other requested safety results. The chosen source sentence itself must name the requested medicine, product, intervention, or an accepted exact abbreviation; do not use a generic sentence about 'all treatments' or a sibling medicine. Do not keep consumption prevalence, motivations, or broad self-reported associations without a concrete safety result.",
        "For broad topic questions, exact-item studies and a clearly labelled parent-category health bridge are both allowed, but never turn parent evidence into a finding about the exact item.",
        "Omit a paper when no candidate sentence is an actual result, conclusion, measured comparison, or reported adverse event.",
        "headline_ko is the same finding for a reader skimming a table, not a label. Keep the comparison the result was measured against, the direction, and every headline number with its unit; when the sentence reports both a null and a positive result, keep both, because dropping one reverses the meaning. Use everyday Korean rather than statistical vocabulary: write '위험이 4.9배' rather than '오즈비 4.85', and '체지방률이 높아짐' rather than '상위 사분위수 위험 증가'. Drop only confidence intervals, p-values, and adjustment wording. Never introduce a number that is absent from result_ko, and never soften a null result into a positive one.",
        "Return only the findings array with index, candidate_index, result_ko, and headline_ko. Do not return source_sentence or any other fields."
      ]
    };

    // A malformed or truncated structured response used to fall through to
    // the old heuristic renderer. That renderer exposed messages such as
    // "Korean extraction failed" to users. Retry this narrow, source-only
    // extraction once before giving the service an explicit failure signal.
    // The service then omits ungrounded papers instead of inventing a result.
    let lastError: unknown;
    // The last attempt must return whatever it has. Comparing against a
    // hard-coded token count instead of "is this the final attempt" meant that
    // raising the budget silently disabled the return: two valid findings were
    // extracted and then discarded, and a working question began answering
    // "관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다."
    const attemptBudgets = [2_400, 1_600];
    for (const maxOutputTokens of attemptBudgets) {
      try {
        const response = await this.fetchFn("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.openaiApiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.config.openaiModel,
            reasoning: { effort: "minimal" },
            max_output_tokens: maxOutputTokens,
            input: [
              {
                role: "system",
                content: "You extract source-grounded Korean study findings from supplied paper abstracts. Return JSON only."
              },
              { role: "user", content: JSON.stringify(payload) }
            ],
            text: { format: { type: "json_object" } }
          })
        });
        const json = (await response.json()) as OpenAiResponse;
        if (!response.ok) {
          lastError = new Error(`OpenAI grounded extraction failed: ${response.status}`);
          continue;
        }
        const text = readOutputText(json);
        if (!text) {
          lastError = new Error("OpenAI grounded extraction returned empty text");
          continue;
        }
        const parsed = parseJson<GroundedFindingResponse>(text);
        const findings = validateGroundedFindings(parsed, sources, intent);
        if (process.env.DEBUG_GROUNDED_EXTRACTION === "true") {
          console.error(JSON.stringify({
            type: "grounded-extraction",
            candidates: sources.map((source) => ({ index: source.index, title: source.title, count: source.candidateSentences.length })),
            modelFindings: parsed.findings,
            acceptedFindings: findings.map((finding) => ({ index: finding.index, sourceSentence: finding.sourceSentence }))
          }));
        }
        // If a candidate was rejected for source mismatch, make one focused
        // retry rather than returning a partial set that makes a real paper
        // appear to have no usable result. The second pass still receives
        // only the exact abstract sentences above.
        const isFinalAttempt = maxOutputTokens === attemptBudgets.at(-1);
        if (findings.length >= Math.min(3, sources.length) || isFinalAttempt) return findings;
        lastError = new Error("OpenAI grounded extraction returned no usable findings");
      } catch (error) {
        lastError = error;
      }
    }
    if (process.env.DEBUG_GROUNDED_EXTRACTION === "true") {
      console.error("grounded-extraction-error", lastError instanceof Error ? lastError.message : String(lastError));
    }
    return undefined;
  }

  async synthesizeClaim(question: string, evidence: EvidenceSearchResult, fallback: ClaimAnswer): Promise<ClaimAnswer> {
    if (!this.config.openaiApiKey || evidence.papers.length === 0) return fallback;

    const synthesisEvidence = evidenceForCitations(evidence, fallback);
    const payload = buildClaimSynthesisPayload(question, synthesisEvidence, fallback);
    const response = await this.fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.openaiModel,
        reasoning: { effort: "minimal" },
        max_output_tokens: 900,
        input: [
          {
            role: "system",
            content:
              "You are a Korean evidence synthesis layer for a research-backed claim checker. " +
              "The supplied evidence is the complete evidence set you may use. Return strict JSON only."
          },
          { role: "user", content: JSON.stringify(payload) }
        ],
        text: { format: { type: "json_object" } }
      })
    });

    const json = (await response.json()) as OpenAiResponse;
    if (!response.ok) {
      throw new Error(`OpenAI RAG synthesis failed: ${response.status}${json.error?.message ? ` ${json.error.message}` : ""}`);
    }
    const text = readOutputText(json);
    if (!text) throw new Error("OpenAI RAG synthesis returned empty text");
    return mergeModelAnswer(parseJson(text), fallback, synthesisEvidence);
  }

  /** Translate only source-bound fields. Layout and product wording are built
   * deterministically by the MCP renderer, so the host cannot drop sections. */
  async localizeHostMcpPapers(
    question: string,
    sources: HostMcpLocalizationSource[]
  ): Promise<HostMcpLocalizedPaper[] | undefined> {
    if (!this.config.openaiApiKey || sources.length === 0) return undefined;
    const model = this.config.openaiFastPlannerModel ?? this.config.openaiModel;
    const response = await this.fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        ...(model.startsWith("gpt-5") ? { reasoning: { effort: "minimal" } } : {}),
        max_output_tokens: 1_600,
        input: [
          {
            role: "system",
            content: [
              "Translate supplied scholarly titles and result excerpts into natural Korean.",
              "title_ko must be a Korean translation of title; never copy the English title into title_ko.",
              "Use only each supplied string: do not add background facts, methods, limitations, advice, or numbers.",
              "Preserve direction, comparisons, sample sizes, effect sizes, confidence intervals, and uncertainty.",
              "Every number or spelled-out number in result must appear in result_ko; translate English number words into digits.",
              "Translate 'evidence against the claim' as evidence that contradicts the claim, never as a failure to find evidence.",
              "headline_ko must start with '이 연구에서는' and state one short result without generalizing beyond that study.",
              "For each input paper, copy paperId exactly into the output field paper_id. Never output an example or placeholder ID.",
              "Return JSON only as {papers:[{paper_id,title_ko,result_ko,headline_ko}]}."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              question,
              papers: sources
            })
          }
        ],
        text: { format: { type: "json_object" } }
      })
    });
    const json = (await response.json()) as OpenAiResponse;
    if (!response.ok) {
      throw new Error(`OpenAI MCP localization failed: ${response.status}${json.error?.message ? ` ${json.error.message}` : ""}`);
    }
    const text = readOutputText(json);
    if (!text) return undefined;
    const parsed = parseJson<HostMcpLocalizationResponse>(text);
    const localized = validateHostMcpLocalization(parsed, sources);
    if (!localized && process.env.DEBUG_HOST_MCP_LOCALIZATION === "true") {
      console.error("[mcp-localization] rejected", JSON.stringify(parsed));
    }
    return localized;
  }
}

export function validateHostMcpLocalization(
  value: HostMcpLocalizationResponse,
  sources: HostMcpLocalizationSource[]
): HostMcpLocalizedPaper[] | undefined {
  if (!Array.isArray(value.papers) || value.papers.length !== sources.length) return undefined;
  const byId = new Map(value.papers.map((paper) => [paper.paper_id, paper]));
  const localized: HostMcpLocalizedPaper[] = [];
  for (const source of sources) {
    const paper = byId.get(source.paperId);
    if (!paper) return undefined;
    const titleKo = cleanKoreanField(paper.title_ko, 5, 240);
    const resultKo = cleanKoreanField(paper.result_ko, 10, 700);
    const headlineKo = cleanKoreanField(paper.headline_ko, 8, 180);
    if (!titleKo || !resultKo || !headlineKo) return undefined;
    if (hasUnsupportedHostNumber(titleKo, source.title)) return undefined;
    const sourceText = `${source.title} ${source.result}`;
    if (hasUnsupportedHostNumber(resultKo, sourceText)) return undefined;
    if (hasUnsupportedHostNumber(headlineKo, sourceText)) return undefined;
    if (missingRequiredHostNumber(resultKo, source.result)) return undefined;
    localized.push({ paperId: source.paperId, titleKo, resultKo, headlineKo });
  }
  return localized;
}

function cleanKoreanField(value: unknown, minLength: number, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < minLength || clean.length > maxLength || !/[가-힣]/.test(clean)) return undefined;
  return clean;
}

function hasUnsupportedHostNumber(translated: string, source: string): boolean {
  const sourceNumbers = new Set(source.match(/\d+(?:[.,]\d+)?/g) ?? []);
  for (const value of englishNumberValues(source)) sourceNumbers.add(String(value));
  return (translated.match(/\d+(?:[.,]\d+)?/g) ?? []).some((number) => !sourceNumbers.has(number));
}

function missingRequiredHostNumber(translated: string, source: string): boolean {
  const translatedNumbers = new Set(translated.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const required = new Set([
    ...(source.match(/\d+(?:[.,]\d+)?/g) ?? []),
    ...englishNumberValues(source).map(String)
  ]);
  return [...required].some((number) => !translatedNumbers.has(number));
}

function englishNumberValues(value: string): number[] {
  const ones: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
    twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };
  const tokens = value.toLowerCase().match(/[a-z]+/g) ?? [];
  const numbers: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (tens[token] !== undefined) {
      const next = ones[tokens[index + 1] ?? ""];
      numbers.push(tens[token] + (next !== undefined && next < 10 ? next : 0));
      if (next !== undefined && next < 10) index += 1;
      continue;
    }
    if (ones[token] !== undefined) numbers.push(ones[token]);
  }
  return numbers;
}

function readOutputText(response: OpenAiResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" || typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}

function parseJson<T = ModelClaimJson>(text: string): T {
  const stripped = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch (error) {
    const preview = stripped.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`OpenAI JSON response could not be parsed${preview ? `: ${preview}` : " (empty output)"}`, { cause: error });
  }
}

export function normalizeFastHostQueryPlan(
  value: Record<string, unknown>,
  fallbackCategory: Exclude<Category, "auto">
): FastHostQueryPlan {
  const cleanTerms = (input: unknown): string[] => Array.isArray(input)
    ? [...new Set(input
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter((item) => item.length >= 2 && /[a-z]/i.test(item)))]
      .slice(0, 4)
    : [];
  const rawTopicTerms = cleanTerms(value.topic_terms);
  const topicTerms = [...new Set(rawTopicTerms.flatMap((term) => {
    const canonical = term
      .replace(/\b(?:exposure|supplementation effects?|supplementation|intake|use)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return canonical.length >= 3 && /[a-z]/i.test(canonical) ? [canonical, term] : [term];
  }))].slice(0, 4);
  const outcomeTerms = cleanTerms(value.outcome_terms)
    .filter((term) => !/\b(?:not primary|secondary only|unrelated)\b/i.test(term))
    .map((term) => term.replace(/\([^)]*\)/g, " ").replace(/\b(?:outcome|endpoint)\b/gi, " ").replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 2)
    .slice(0, 4);
  const allowed = new Set<Exclude<Category, "auto">>([
    "health", "nutrition", "exercise", "psychology", "childcare", "education"
  ]);
  const category = typeof value.category === "string" && allowed.has(value.category as Exclude<Category, "auto">)
    ? value.category as Exclude<Category, "auto">
    : fallbackCategory;
  if (topicTerms.length === 0) {
    throw new Error("OpenAI fast host planning returned an invalid scholarly query");
  }
  const academicQuery = [
    ...topicTerms.slice(0, 3),
    ...outcomeTerms.slice(0, 3),
    "systematic review",
    "randomized controlled trial"
  ].join(" ").slice(0, 450);
  return { academicQuery, topicTerms, outcomeTerms, category };
}

function validateEvidenceTermExpansion(
  expansion: EvidenceTermExpansion,
  sources: Array<{ index: number; title: string; abstract_excerpt: string }>
): string[] {
  const sourceByIndex = new Map(sources.map((source) => [source.index, `${source.title} ${source.abstract_excerpt}`.toLowerCase()]));
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of expansion.terms ?? []) {
    if (typeof item.term !== "string" || !Array.isArray(item.source_indices)) continue;
    if (!["same_entity", "subtype", "parent_category"].includes(String(item.relation))) continue;
    const term = item.term.replace(/\s+/g, " ").trim();
    const tokens = term.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    if (term.length < 3 || term.length > 90 || tokens.length === 0) continue;
    const supported = item.source_indices.some((index) => {
      if (typeof index !== "number") return false;
      const source = sourceByIndex.get(index);
      return Boolean(source) && tokens.every((token) => source!.includes(token));
    });
    const key = term.toLowerCase();
    if (!supported || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === 4) break;
  }
  return terms;
}

/**
 * The safety rules require the source sentence to name the exposure literally.
 * That is right when it works and catastrophic when the planner mistypes the
 * question: "소시지 몸에 안 좋아?" was classified as a safety question, so every
 * processed-meat finding was thrown away for saying "processed meat" instead of
 * "sausage", and the user was told no research exists.
 *
 * Same rule as in ranking: a question type is a guess, and a guess must not be
 * able to empty the evidence. Run the strict pass first, and only if it keeps
 * nothing, run again without the safety-specific rules.
 */
function validateGroundedFindings(
  response: GroundedFindingResponse,
  sources: Array<{ index: number; title: string; candidateSentences: string[] }>,
  intent?: ResearchIntent
): GroundedPaperFinding[] {
  const strict = validateGroundedFindingsPass(response, sources, intent, false);
  if (strict.length > 0 || intent?.questionType !== "safety") return strict;
  return validateGroundedFindingsPass(response, sources, intent, true);
}

function validateGroundedFindingsPass(
  response: GroundedFindingResponse,
  sources: Array<{ index: number; title: string; candidateSentences: string[] }>,
  intent: ResearchIntent | undefined,
  relaxSafety: boolean
): GroundedPaperFinding[] {
  const sourceByIndex = new Map(sources.map((source) => [source.index, source]));
  const bestFindingByIndex = new Map<number, { finding: GroundedPaperFinding; score: number }>();
  for (const item of response.findings ?? []) {
    if (typeof item.index !== "number") continue;
    if (typeof item.candidate_index !== "number") continue;
    if (typeof item.result_ko !== "string") continue;
    const source = sourceByIndex.get(item.index);
    const sourceSentence = source?.candidateSentences[item.candidate_index - 1];
    let resultKo = item.result_ko
      .replace(/\s+/g, " ")
      .replace(/^(?:결론적으로|종합하면|요약하면|결론|결과)\s*[:,]?\s*/u, "")
      // Each finding is shown on its own, so a leading discourse connective
      // points at a sentence the reader never sees: "그러나(어떤 식품은) LDL과
      // 중성지방을 증가시킬 수 있으며" opened a paragraph with "however".
      .replace(/^(?:그러나|하지만|반면에|반면|또한|그리고|한편|따라서|그래서)\s*[,]?\s*/u, "")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&le;/gi, "≤")
      .replace(/&ge;/gi, "≥")
      .replace(/;?\s*Cochrane\s+Q\s+P\s*=\s*[0-9.eE+-]+/gi, "")
      .replace(/\bpooled\s+p(?:-?value)?\s*(<|>|=)\s*([0-9.]+)/gi, "통합 분석 p값 $1 $2")
      .replace(/\bpooled\s+p(?:-?value)?\s+was\s+([0-9.]+)/gi, "통합 분석 p값 $1")
      .replace(/(?:통합|합산|풀링)\s*p\s*(<|>|=)\s*([0-9.]+)/gi, "통합 분석 p값 $1 $2")
      .replace(/(?:pooled|풀린|풀링된|풀링|풀된|합병된|통합된?)\s*p(?:-?value|값)/gi, "통합 분석 p값")
      .replace(/자연\s*살해\s*\(\s*NK\s*\)\s*세포/g, "자연살해세포(NK 세포)")
      .replace(/자연살해세포\s*\(\s*NK\s*\)/g, "자연살해세포(NK 세포)")
      .replace(/코티졸/g, "코르티솔")
      .replace(/그라나자임/g, "그랜자임")
      .replace(/진\s*\(\s*(?:참|실)\s*\)\s*소화율/g, "진정 소화율")
      .replace(/참\s*소화율/g, "진정 소화율")
      .replace(/전\s*트립토판(?:\s*\(\s*Tryptophan\s*\))?\s*소화율/gi, "트립토판의 진정 소화율")
      .replace(/섭취\s*상태\s*기준/g, "제품 상태(as-is) 기준")
      .replace(/오즈(?=\s*(?:가|는|은)?\s*\d)/g, "오즈비(OR)")
      .replace(/(\d+%\s*CI\s*=?\s*[\d.]+)\s+to\s+([\d.]+)/gi, "$1~$2")
      .replace(/(\d+(?:[.,]\d+)?)%\s*\(\s*증가\s*\)/g, "$1% 증가")
      .replace(/(\d+(?:[.,]\d+)?)%\s*\(\s*감소\s*\)/g, "$1% 감소")
      .trim();
    if (!source || !sourceSentence || resultKo.length < 10 || resultKo.length > 500 || sourceSentence.length < 24) continue;
    resultKo = removeUnsupportedComparisonFraming(resultKo, sourceSentence);
    if (!isExplicitResultSentence(sourceSentence)) continue;
    if (requiresNamedFoodComparisonValue(intent) && intent && !sourceSentenceNamesComparisonOption(sourceSentence, intent)) continue;
    if (hasUnsupportedStatistic(resultKo, sourceSentence)) continue;
    if (!relaxSafety && intent?.questionType === "safety" && !sourceSentenceNamesSafetyExposure(sourceSentence, intent)) continue;
    if (!relaxSafety && intent?.questionType === "safety" && isLowValueSafetySentence(sourceSentence)) continue;
    if (!/[가-힣]/.test(resultKo) || isGenericExtraction(resultKo)) continue;
    if (isCutOffSentence(resultKo)) continue;
    const headlineKo = usableHeadline(item.headline_ko, resultKo);
    if (hasUnnamedSubjectPlaceholder(resultKo)) continue;
    const finding = { index: item.index, resultKo, headlineKo, sourceSentence };
    const score = scoreResultCandidate(sourceSentence, new Set(), new Set());
    const existing = bestFindingByIndex.get(item.index);
    if (!existing || score > existing.score) bestFindingByIndex.set(item.index, { finding, score });
  }
  return [...bestFindingByIndex.values()]
    .map(({ finding }) => finding)
    .sort((left, right) => left.index - right.index);
}

/**
 * When the model cannot tell which food or drug a result sentence is about it
 * writes a placeholder subject rather than naming one: "(어떤 식품은) LDL과
 * 중성지방을 증가시킬 수 있으며". A finding that cannot name its own subject
 * cannot be attributed to the user's question either, so it is dropped instead
 * of printed as evidence.
 */
/**
 * The grounding response shares one token budget across every paper, so a long
 * Korean sentence can arrive cut off: "...(GHP, 평균차 3.29; 95% CI 1.54~5.04;"
 * ended on a semicolon with the finding missing. A half sentence reads as a
 * complete one to the user, so drop it rather than print it.
 */
/**
 * The table headline is a compression of result_ko, never a new claim. This
 * codebase already removed one model rewrite step because it produced phrases
 * such as "an effect was reported" in place of the numbers the papers gave, so
 * a headline is accepted only when it stays inside the sentence it summarises:
 * every number in it must already appear in result_ko.
 */
function usableHeadline(value: unknown, resultKo: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const headline = value.replace(/\s+/g, " ").trim();
  if (headline.length < 12 || headline.length > 120) return undefined;
  if (!/[가-힣]/.test(headline)) return undefined;
  if (isGenericExtraction(headline) || isCutOffSentence(headline)) return undefined;
  const sourceNumbers = new Set(resultKo.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const invented = (headline.match(/\d+(?:[.,]\d+)?/g) ?? [])
    .filter((number) => !sourceNumbers.has(number) && !isRoundedFrom(number, sourceNumbers));
  return invented.length === 0 ? headline : undefined;
}

/** "4.85" may legitimately be shown as "4.9배". */
function isRoundedFrom(candidate: string, sourceNumbers: Set<string>): boolean {
  const value = Number(candidate.replace(",", "."));
  if (!Number.isFinite(value)) return false;
  return [...sourceNumbers].some((source) => {
    const original = Number(source.replace(",", "."));
    return Number.isFinite(original) && Math.abs(original - value) <= Math.max(0.05, Math.abs(original) * 0.02);
  });
}

export function isCutOffSentence(resultKo: string): boolean {
  const trimmed = resultKo.trim();
  if (/[.!?。]$/.test(trimmed)) return false;
  // Korean sentences routinely end without a full stop, but not on a
  // separator, a conjunction, or an unclosed bracket.
  if (/[;,:·/([{]$/.test(trimmed)) return true;
  // A connective ending promises a clause that never arrived.
  if (/(?:및|또는|그리고|으며|하며|이며|이고|하고|면서|으로|에서|보다|와|과)$/.test(trimmed)) return true;
  return countOpen(trimmed, "(") !== countOpen(trimmed, ")");
}

function countOpen(text: string, character: string): number {
  let total = 0;
  for (const item of text) if (item === character) total += 1;
  return total;
}

export function hasUnnamedSubjectPlaceholder(resultKo: string): boolean {
  return /\(\s*(?:어떤|일부|특정|모종의)\s*[^)]{0,24}?(?:은|는|이|가)?\s*\)/u.test(resultKo);
}

export function sourceSentenceNamesSafetyExposure(sentence: string, intent: ResearchIntent): boolean {
  const normalizedSentence = ` ${sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const ignored = new Set([
    "drug", "drugs", "medicine", "medicines", "medication", "medications",
    "treatment", "treatments", "therapy", "therapies", "intervention", "interventions"
  ]);
  return [intent.exposure, ...intent.exposureTerms].some((term) => {
    const tokens = term.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
    const required = tokens.filter((token) => !ignored.has(token));
    return required.length > 0 && required.every((token) =>
      new RegExp(`\\b${escapeRegex(token)}s?\\b`, "i").test(normalizedSentence)
    );
  });
}

function isGenericExtraction(value: string): boolean {
  return /(?:추출하지 못|결과가 명확하지 않|결과가 보고되지 않|효과가 보고됐|연구가 필요|알 수 없|대표 근거로 사용할 수 있는 결과 문장|관련 문장이 명시적|이 논문에서 선택된 문장|선택된 문장은)/.test(value);
}

function removeUnsupportedComparisonFraming(resultKo: string, sourceSentence: string): string {
  // The extractor is allowed to paraphrase, but it cannot introduce a
  // comparator that was absent from the source. This catches a common Korean
  // fluency pattern without deleting genuine placebo/control comparisons.
  const hasPlacebo = /\bplacebo\b/i.test(sourceSentence);
  const hasControl = /\bcontrol(?:\s+group)?\b/i.test(sourceSentence);
  const hasComparison = /\b(?:compared(?:\s+(?:with|to))?|comparison|versus|vs\.?(?:\s|$)|relative\s+to)\b/i.test(sourceSentence);
  if (hasPlacebo || hasControl || hasComparison) {
    // Do not silently turn a control group into a placebo group. The model
    // only receives the source sentence, so this is a deterministic fidelity
    // correction rather than an inference about the study design.
    if (hasControl && !hasPlacebo) {
      resultKo = resultKo.replace(/위약(?=\s*(?:과|와|대비|보다|군)?)/gu, "대조군");
    }
    return dedupeComparisonLabel(resultKo);
  }
  return dedupeComparisonLabel(resultKo
    .replace(/^(?:(?:대조군|위약|비교군)(?:과|와)?\s*비교(?:했을\s*때|하면)?|(?:대조군|위약|비교군)\s*(?:대비|보다)|비교했을\s*때)\s*[,，:]?\s*/u, "")
    .trim());
}

function dedupeComparisonLabel(value: string): string {
  // Model translations occasionally restate a group label while translating
  // "compared with the control group". This is a purely textual cleanup and
  // does not alter which group the abstract names.
  return value
    .replace(/(대조군|위약|비교군)\s*·\s*\1(?=(?:과|와|대비|보다|군)?)/gu, "$1")
    .replace(/(대조군|위약|비교군)(?:과|와)?\s+(대조군|위약|비교군)(?=(?:과|와|대비|보다|군)?)/gu, "$1")
    .replace(/(대조군|비교군|위약군)군(?=(?:과|와|대비|보다)?)/gu, "$1")
    .trim();
}

function hasUnsupportedStatistic(resultKo: string, sourceSentence: string): boolean {
  // A translation may omit a number, but it must never turn a study's
  // significance value into an effect threshold (for example, P<0.05 into
  // P>100). Check the compact notation directly because all other numerical
  // content is still traceable to the selected source sentence.
  const normalizedSource = sourceSentence
    .replace(/\s+/g, " ")
    .replace(/p\s*-?value/gi, "p");
  const normalizedResult = resultKo
    .replace(/통합 분석 p값/gi, "p")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=");
  const resultPValues = [...normalizedResult
    .matchAll(/\bp\s*(?:값)?\s*(<=|>=|<|>|=)\s*(\d+(?:[.,]\d+)?)/gi)];
  return resultPValues.some((match) => {
    const operator = match[1]!.replace("<=", "≤").replace(">=", "≥");
    const number = match[2]!.replace(",", ".");
    const acceptedOperators = operator === "≤" ? "(?:≤|<=|<)" :
      operator === "≥" ? "(?:≥|>=|>)" : escapeRegex(operator);
    return !new RegExp(`\\bp\\s*(?:value\\s*)?${acceptedOperators}\\s*${escapeRegex(number)}`, "i")
      .test(normalizedSource.replace(/,/g, "."));
  });
}

function requiresNamedFoodComparisonValue(intent: ResearchIntent | undefined): boolean {
  return intent?.questionType === "comparison" && intent.outcomeTerms.some((term) =>
    /(?:protein\s*(?:quality|digestibility|bioaccessibility|content|efficiency)|amino\s+acid|diaas|essential\s+amino)/i.test(term)
  );
}

function sourceSentenceNamesComparisonOption(sentence: string, intent: ResearchIntent): boolean {
  const normalizedSentence = ` ${sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const options = [intent.exposure, intent.comparator ?? "", ...intent.exposureTerms, ...intent.comparatorTerms]
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 3);
  return options.some((option) => normalizedSentence.includes(` ${option} `));
}

export function selectResultCandidates(abstract: string | undefined, intent: ResearchIntent | undefined): string[] {
  const clean = abstract
    ?.replace(/&#x0*0?b1;/gi, " ± ")
    ?.replace(/<[^>]+>/g, " ")
    .replace(/&#(?:x[0-9a-f]+|\d+);/gi, " ")
    .replace(/&(nbsp|amp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  if (!clean) return [];
  const exposureTerms = resultCandidateTerms([
    ...(intent?.exposureTerms ?? []),
    ...(intent?.comparatorTerms ?? []),
    ...(intent?.contextualEvidenceTerms ?? []),
    ...(intent?.directContextTerms ?? []),
    ...(intent?.parentEvidenceTerms ?? [])
  ]);
  const outcomeTerms = resultCandidateTerms(intent?.outcomeTerms ?? []);
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 850);
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: scoreResultCandidate(sentence, exposureTerms, outcomeTerms)
  }));
  const strong = scored.filter((item) => item.score >= 8 && isExplicitResultSentence(item.sentence))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, 4)
    .map((item) => item.sentence);
  if (strong.length > 0) return strong;
  // Some older abstracts do not label results. Their conclusion is normally
  // one of the final two sentences, but it still goes through the LLM's
  // explicit result gate before becoming user-visible.
  return sentences.slice(-2);
}

function resultCandidateTerms(terms: string[]): Set<string> {
  return new Set(terms
    .flatMap((term) => term.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .filter((term) => !resultCandidateStopwords.has(term))
  );
}

function scoreResultCandidate(sentence: string, exposureTerms: Set<string>, outcomeTerms: Set<string>): number {
  const text = sentence.toLowerCase();
  const matchesTerm = (term: string) => new RegExp(`\\b${escapeRegex(term)}s?\\b`, "i").test(text);
  const exposureMatches = [...exposureTerms].filter(matchesTerm).length;
  const outcomeMatches = [...outcomeTerms].filter(matchesTerm).length;
  const resultSignal = hasResultSignal(text);
  const methodOnly = isMethodOnlySentence(text);
  let score = Math.min(3, exposureMatches * 2) + Math.min(10, outcomeMatches * 2);
  if (resultSignal) score += 14;
  if (/\b(?:results?|conclusions?|we found|we observed|our findings|in summary)\b/i.test(text)) score += 4;
  if (/\b\d+(?:[.,]\d+)?\s*(?:%|mg|g|kg|mmhg|bpm|ms|ci|rr|or|hr)\b/i.test(text)) score += 8;
  if (/\b\d+(?:[.,]\d+)?\s*%\s*(?:ci|confidence interval)\b/i.test(text)) score += 4;
  if (methodOnly && !resultSignal) score -= 28;
  if (isBackgroundOnlySentence(text)) score -= 80;
  if (/\b(?:background|objective|aim|purpose)\b/i.test(text)) score -= 12;
  if (/\b(?:ingredient|mechanism|mechanistic|believed|hypothes(?:is|ized)|may be related|might be related|potentially due to)\b/i.test(text)) score -= 6;
  return score;
}

function isExplicitResultSentence(sentence: string): boolean {
  const text = sentence.toLowerCase();
  return hasResultSignal(text) && !isMethodOnlySentence(text) && !isBackgroundOnlySentence(text);
}

function hasResultSignal(text: string): boolean {
  return /\b(?:increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|lower(?:ed|s)?|higher|greater|less|more frequent|less frequent|improv(?:ed|e|es)|worsen(?:ed|s)?|associated with|linked to|related to|did not differ|no (?:significant )?(?:difference|association|effect)|not significant|most common adverse events?|adverse events? (?:occurred|were)|side effects? (?:occurred|were)|inconclusive|inconsistent|mixed results?|no evidence)\b/i.test(text)
    || /\b(?:all|both|each|the)\b[^.]{0,100}\b(?:had|have|was|were)\b[^.]{0,80}(?:>|<|≥|≤|=)\s*\d+(?:[.,]\d+)?\b/i.test(text)
    || /\b(?:ranged?\s+from|ranging\s+from)\s*\d+(?:[.,]\d+)?[^.]{0,80}\bto\s+\d+(?:[.,]\d+)?/i.test(text)
    || /\b(?:was|were)\s+\d+(?:[.,]\d+)?\s*(?:±|\+\/-|%)/i.test(text)
    || /\b(?:presented|developed|experienced|admitted|hospitali[sz]ed|diagnosed)\b[^.]{0,180}\b(?:after|following|subsequent to)\b/i.test(text)
    || /\b(?:after|following|subsequent to)\b[^.]{0,180}\b(?:presented|developed|experienced|admitted|hospitali[sz]ed|diagnosed)\b/i.test(text);
}

function isMethodOnlySentence(text: string): boolean {
  return /\b(?:systematic review|meta[ -]?analysis|review|analysis)\b[^.]{0,100}\b(?:was|were)\s+(?:conducted|performed|carried out)\b/i.test(text)
    || /\b(?:objective|aim(?:ed|ing)?|purpose|methods?)\b/i.test(text)
    || /\b(?:databases?|literature)\b[^.]{0,100}\b(?:searched|search)\b/i.test(text)
    || /\b(?:screened|selected|extracted)\b[^.]{0,100}\b(?:studies|trials|articles|records)\b/i.test(text)
    || /\b(?:studies|trials|articles|records)\b[^.]{0,80}\b(?:were|was)\s+(?:screened|selected|included|extracted)\b/i.test(text)
    || /\b(?:papers?|studies|trials|articles|records)\b[^.]{0,180}\b(?:which|that)\b[^.]{0,100}\b(?:explored|examined|assessed|investigated)\b[^.]{0,120}\b(?:were|was)\s+included\b/i.test(text)
    || /\b(?:found|identified)\b[^.]{0,100}\b(?:only|just)\s+\d[\d,]*\b[^.]{0,120}\b(?:studies|trials|articles|records)\b/i.test(text)
    || /\b(?:only|just)\s+\d[\d,]*\b[^.]{0,120}\b(?:studies|trials|articles|records)\b[^.]{0,100}\b(?:were|was)\s+included\b/i.test(text)
    || /\b(?:literature|reports?|evidence|events?)\b[^.]{0,100}\b(?:reviewed|described|discussed)\b/i.test(text)
    // Narrative articles often use a polished conclusion-like sentence while
    // only discussing a mechanism or possible benefit. It is not a measured
    // result and must not fill a representative-paper slot merely because it
    // contains the user's topic words.
    || /\b(?:this|the)\s+(?:article|paper|review)\b[^.]{0,180}\b(?:discuss(?:es|ed)|describ(?:es|ed)|highlight(?:s|ed)|consider(?:s|ed)|argue(?:s|d))\b/i.test(text)
    || /\b(?:adverse effects?|health outcomes?|behavio(?:u)?rs?)\b[^.]{0,100}\b(?:were|was)\s+(?:explored|examined|assessed|investigated)\b/i.test(text);
}

function isBackgroundOnlySentence(text: string): boolean {
  return /\b(?:use|consumption|popularity|awareness|interest)\b[^.]{0,60}\b(?:has|have)\s+(?:increased|grown|risen)\b/i.test(text)
    || /\b(?:is|are)\s+promoted\b/i.test(text)
    || /\b(?:is|are|were)\s+(?:currently\s+)?used\s+(?:as|to)\b/i.test(text)
    || /\b(?:growing|major)\s+public health issue\b/i.test(text)
    || /\b(?:has|have) increased in (?:the )?(?:recent|past|last)\b/i.test(text);
}

function isLowValueSafetySentence(sentence: string): boolean {
  const text = sentence.toLowerCase();
  const background = /\b(?:prevalence|is common|self-reported|motivations?|associated factors?|behavio(?:u)?ral|environmental factors?|consumer patterns?)\b/i.test(text);
  const concreteSafetyResult = /\b(?:\d+(?:[.,]\d+)?\s*(?:%|mmhg|bpm|mg|g|kg|ml|l|ci|rr|or|hr)|increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|more frequent|less frequent|did not differ|no (?:significant )?(?:difference|association|effect)|not significant)\b/i.test(text);
  const concreteEndpoint = /\b(?:insomnia|sleep disturbance|palpitation|arrhythmia|tachycardia|bradycardia|blood pressure|heart rate|qtc?|ecg|electrocardiogram|nausea|vomit(?:ing)?|diarrh(?:ea|oea)?|abdominal pain|headache|dizziness|tremor|seizure|anxiety|depression|hospitali[sz]ation|death|mortality)\b/i.test(text);
  const vagueSystemLabel = /\b(?:most common adverse events?|adverse effects?)\b[^.]{0,90}\b(?:cardiovascular|neurological|gastrointestinal|psychiatric)(?:\s+(?:and|or)\s+(?:cardiovascular|neurological|gastrointestinal|psychiatric)){0,3}\s+systems?\b/i.test(text);
  const genericReviewClaim = /\b(?:this|the) review\b[^.]{0,160}\b(?:growing evidence|numerous|multiple|adverse (?:physical|mental|health) outcomes?|health outcomes?)\b/i.test(text)
    || /\b(?:studies|evidence)\b[^.]{0,100}\b(?:consistently found|growing evidence)\b/i.test(text);
  const riskBehaviourAssociation = /\b(?:risky behaviours?|risk[- ]?taking|illicit drug use|substance use|marijuana use|cannabis use|smoking)\b/i.test(text);
  const policyOrReportingContext = /\b(?:educational campaigns?|legal restrictions?|regulation|policy|poison (?:center|centre) calls?|reports? of (?:toxicity|adverse events?))\b/i.test(text);
  // Consumer surveys and self-reports can describe what people remember
  // experiencing, but they do not establish the physiological safety result
  // asked in a health question. Let measured comparisons outrank them.
  const selfReportedConsumerPattern = /\b(?:self[- ]?reported|consumer(?:s)?|survey|questionnaire|awareness|perceived)\b/i.test(text);
  return selfReportedConsumerPattern ||
    riskBehaviourAssociation ||
    genericReviewClaim ||
    policyOrReportingContext ||
    (background && !concreteSafetyResult) ||
    (vagueSystemLabel && !concreteEndpoint) ||
    (!concreteSafetyResult && !concreteEndpoint);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const resultCandidateStopwords = new Set([
  "health", "outcomes", "outcome", "effect", "effects", "study", "studies", "review", "systematic", "meta", "analysis",
  "clinical", "trial", "randomized", "controlled", "adult", "adults", "human", "humans", "disease", "risk", "risks"
]);
