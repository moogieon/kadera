import type { Config } from "./config.js";
import { ClaimCache, hostEvidenceCacheKey, type PaperReferenceRecord } from "./cache.js";
import { PubMedClient } from "./clients/pubmed.js";
import { SemanticScholarClient } from "./clients/semanticScholar.js";
import { OpenAlexClient } from "./clients/openAlex.js";
import { EuropePmcClient } from "./clients/europePmc.js";
import { CrossrefClient } from "./clients/crossref.js";
import { EricClient } from "./clients/eric.js";
import { ArxivClient } from "./clients/arxiv.js";
import { MyHealthfinderClient } from "./clients/myHealthfinder.js";
import { CoreClient } from "./clients/core.js";
import { PreprintClient } from "./clients/preprint.js";
import { WhoGhoClient } from "./clients/whoGho.js";
import { CdcClient } from "./clients/cdc.js";
import { KciClient } from "./clients/kci.js";
import { RissClient } from "./clients/riss.js";
import { OsfPreprintsClient } from "./clients/osfPreprints.js";
import { koreanBrandSearchTerms, resolveKoreanBrandAliases, RxNavClient } from "./clients/rxnav.js";
import { buildIntentSearchQueries, type SearchPlan } from "./clients/gemini.js";
import { OpenAiRagClient } from "./clients/openai.js";
import { composeAnswer, hasGroundedFindingForIntent } from "./answer.js";
import { classifyPaperForIntent, comparisonEvidenceScope, evidenceDirectness, normalizeEvidenceLevel, rankPapers } from "./evidence.js";
import { screenSafety, screenUnsupportedResearchQuestion, standardSafetyNote } from "./safety.js";
import {
  buildFocusedSearchQueries,
  buildKoreanSearchQueries,
  buildLooseSearchQueries,
  buildQueryTerms,
  broadTopicSubject,
  classifyCategory,
  isBroadTopicQuestion, normalizeQuestion } from "./text.js";
import type { Category, Citation, ClaimAnswer, ClaimDirection, DataSourceStatus, EvidenceSearchResult, GlossaryEntry, Paper, PopularClaim, ResearchIntent, SourceError, SourceTrace } from "./types.js";

export interface CheckClaimInput {
  question: string;
  category?: Category;
  audience?: string;
  limit?: number;
  skipCache?: boolean;
  searchQuery?: string;
  queryTerms?: string[];
  claimDirection?: ClaimDirection;
  researchIntent?: ResearchIntent;
}

export interface FindEvidenceInput {
  question: string;
  category?: Category;
  limit?: number;
}

export interface ExplainEvidenceInput {
  question: string;
  claimId?: string;
  category?: Category;
}

/**
 * Fast MCP retrieval contract. The host LLM resolves the user's Korean
 * wording into a compact academic query before calling this method; the MCP
 * server only retrieves and ranks source material. This keeps the tool call
 * inside Kakao's latency budget without turning the server into a second
 * general-purpose answer model.
 */
export interface HostEvidenceInput {
  question: string;
  academicQuery: string;
  topicTerms?: string[];
  parentTerms?: string[];
  outcomeTerms?: string[];
  category?: Category;
}

interface FastEvidenceOptions {
  planWithAi?: boolean;
  plannerTimeoutMs?: number;
  searchTimeoutMs?: number;
  searchPlan?: SearchPlan;
  hostDirectPubMedQuery?: string;
  hostTopicContextQuery?: string;
  hostOutcomeContextQuery?: string;
}

interface FullEvidenceOptions {
  searchTimeoutMs?: number;
  searchPlan?: SearchPlan;
}

export interface ModelComparisonRun {
  provider: "gemini" | "openai";
  model: string;
  enabled: boolean;
  elapsedMs: number;
  answer?: ClaimAnswer;
  error?: string;
}

export interface ModelComparisonResult {
  evidence: EvidenceSearchResult;
  models: {
    gemini: ModelComparisonRun;
    openai: ModelComparisonRun;
  };
}

export class ClaimCheckerService {
  private readonly cache: ClaimCache;
  private readonly pubMed: PubMedClient;
  private readonly semanticScholar: SemanticScholarClient;
  private readonly openAlex: OpenAlexClient;
  private readonly europePmc: EuropePmcClient;
  private readonly crossref: CrossrefClient;
  private readonly eric: EricClient;
  private readonly arxiv: ArxivClient;
  private readonly myHealthfinder: MyHealthfinderClient;
  private readonly core: CoreClient;
  private readonly biorxiv: PreprintClient;
  private readonly medrxiv: PreprintClient;
  private readonly whoGho: WhoGhoClient;
  private readonly cdc: CdcClient;
  private readonly kci: KciClient;
  private readonly riss: RissClient;
  private readonly osfPreprints: OsfPreprintsClient;
  private readonly rxNav: RxNavClient;
  private readonly openai: OpenAiRagClient;
  constructor(private readonly config: Config, fetchFn: typeof fetch = fetch) {
    const sourceFetchFn = withFetchTimeout(fetchFn, config.fetchTimeoutMs, "source fetch");
    const openaiFetchFn = withFetchTimeout(fetchFn, config.openaiFetchTimeoutMs, "OpenAI fetch");
    this.cache = new ClaimCache(config.databasePath);
    this.pubMed = new PubMedClient(config, sourceFetchFn);
    this.semanticScholar = new SemanticScholarClient(config, sourceFetchFn);
    this.openAlex = new OpenAlexClient(config, sourceFetchFn);
    this.europePmc = new EuropePmcClient(sourceFetchFn);
    this.crossref = new CrossrefClient(config, sourceFetchFn);
    this.eric = new EricClient(sourceFetchFn);
    this.arxiv = new ArxivClient(sourceFetchFn);
    this.myHealthfinder = new MyHealthfinderClient(sourceFetchFn);
    this.core = new CoreClient(config, sourceFetchFn);
    this.biorxiv = new PreprintClient("biorxiv", sourceFetchFn);
    this.medrxiv = new PreprintClient("medrxiv", sourceFetchFn);
    this.whoGho = new WhoGhoClient(sourceFetchFn);
    this.cdc = new CdcClient(sourceFetchFn);
    this.kci = new KciClient(config, sourceFetchFn);
    this.riss = new RissClient(config, sourceFetchFn);
    this.osfPreprints = new OsfPreprintsClient(sourceFetchFn);
    this.rxNav = new RxNavClient(sourceFetchFn);
    this.openai = new OpenAiRagClient(config, openaiFetchFn);
  }

  async checkClaim(input: CheckClaimInput): Promise<ClaimAnswer> {
    const category = classifyCategory(input.question, input.category ?? "auto");

    // screenSafety has existed since the first commit and was never called.
    // Live probe: "죽고 싶은데 어떤 약이 제일 편해?" was answered with an
    // antidepressant meta-analysis, and "지금 가슴이 조이고 식은땀이 나는데"
    // with a textbook definition of acute coronary syndrome. A research answer
    // is the wrong response to someone in danger, and Kakao Tools additionally
    // forbids handling the six identifier types this screen catches.
    const safety = screenSafety(input.question);
    if (safety.redirect) {
      return safety.reason === "suicide_support"
        ? buildHopefulSuicideSupportAnswer()
        : buildSafetyRedirectAnswer(category, safety.answer);
    }

    const unsupported = screenUnsupportedResearchQuestion(input.question);
    if (unsupported.unsupported) {
      return buildUnsupportedResearchAnswer(category, unsupported.answer);
    }

    const fallbackQueryTerms = buildQueryTerms(input.question, category);
    const suppliedSearchPlan = buildSuppliedSearchPlan(input, category, fallbackQueryTerms);
    // Every MCP invocation is a fresh research request. The old strict-latency
    // branch searched one narrow query, returned a provisional one-paper answer,
    // then relied on a cache refresh the MCP user never asked for. Use the full
    // multi-query retrieval path for the first and only response instead.
    const searchedEvidence = withReportableResults(await this.findEvidence(
      { question: input.question, category, limit: input.limit },
      { searchPlan: suppliedSearchPlan }
    ));
    const evidence = await this.selectCoreEvidence(input.question, searchedEvidence);
    const fallbackAnswer = composeAnswer(input.question, evidence, false);
    const verifiedAnswer: ClaimAnswer = {
      ...this.postProcessAnswer(
        input.question,
        await this.synthesizeVerifiedAnswer(input.question, evidence, fallbackAnswer)
      ),
      evidence_status: "verified"
    };
    return verifiedAnswer;
  }

  async explainEvidence(input: ExplainEvidenceInput): Promise<ClaimAnswer> {
    return this.checkClaim({ question: input.question, category: input.category });
  }

  async checkClaimVerified(input: CheckClaimInput): Promise<ClaimAnswer> {
    return this.checkClaim(input);
  }

  async findHostEvidence(input: HostEvidenceInput): Promise<EvidenceSearchResult> {
    const category = classifyCategory(input.question, input.category ?? "auto");
    const fallbackQueryTerms = buildQueryTerms(input.question, category);
    const academicQuery = input.academicQuery.replace(/\s+/g, " ").trim();
    const hostTopicTerms = normalizeHostEvidenceTerms(input.topicTerms, 4);
    const hostParentTerms = normalizeHostEvidenceTerms(input.parentTerms, 3);
    const hostOutcomeTerms = normalizeHostEvidenceTerms(input.outcomeTerms, 4);
    const parentSearchQueries = buildHostParentSearchQueries(hostParentTerms, hostOutcomeTerms);
    const hostDirectPubMedQuery = hostParentTerms.length === 0
      ? buildHostDirectPubMedQuery(hostTopicTerms, hostOutcomeTerms)
      : undefined;
    const hostTopicContextQuery = buildHostContextEuropePmcQuery(hostTopicTerms);
    const hostOutcomeContextQuery = buildHostContextEuropePmcQuery(hostOutcomeTerms);
    const initialSearchPlan = buildSuppliedSearchPlan({
      question: input.question,
      category,
      searchQuery: academicQuery,
      queryTerms: [academicQuery, ...hostTopicTerms, ...hostParentTerms, ...hostOutcomeTerms]
    }, category, fallbackQueryTerms);
    if (!initialSearchPlan) throw new Error("academic_query가 필요합니다.");
    // The host's exact query and the broader evidence ladder must travel as
    // separate searches. Combining "lard" and "saturated fat" into one bag
    // lets sibling oils win a relevance search; it also hides the fact that a
    // result is parent-topic context rather than direct lard evidence.
    const searchPlan: SearchPlan = {
      ...initialSearchPlan,
      searchQueries: [...new Set([academicQuery, ...parentSearchQueries])]
    };

    // Kakao Tools requires an average tool latency of 100ms and a p99 of
    // 3,000ms. A live four-database search measures 2.0-2.4s, so the average
    // is only reachable by answering a repeated retrieval from the last one.
    // Only the retrieval is reused: the host's labels are reapplied below, so
    // filtering and scope labelling still run fresh on every call.
    const ttlMs = this.config.hostEvidenceCacheTtlMs;
    const cacheKey = hostEvidenceCacheKey(category, searchPlan.searchQueries);
    const cached = ttlMs > 0 ? this.cache.getHostEvidence(cacheKey) : undefined;
    const evidence = cached ?? await this.findEvidenceFast(
      { question: input.question, category, limit: 5 },
      {
        planWithAi: false,
        searchPlan,
        // A host-written academic_query commonly lists every requested
        // endpoint as whitespace-separated words. PubMed interprets that as
        // one conjunctive query, so a paper about dyspepsia but not reflux is
        // silently excluded. Search the structured topic/outcome groups with
        // OR inside each group while the other indexes keep the host's loose
        // cross-database query.
        hostDirectPubMedQuery,
        hostTopicContextQuery,
        hostOutcomeContextQuery,
        // Source calls that miss this window are omitted from this response;
        // the host receives the papers that completed in time.
        searchTimeoutMs: 2_400
      }
    );
    // Never store a degraded retrieval. Caching a run whose sources timed out
    // would pin "관련 연구를 찾지 못했습니다" for the whole TTL on a topic that
    // has evidence.
    if (!cached && ttlMs > 0 && isCacheableHostEvidence(evidence)) {
      this.cache.saveHostEvidence(cacheKey, evidence, ttlMs);
    }
    // The brand table is an offline lookup, so the MCP path can afford the
    // same vocabulary explanation the web answer gets.
    const glossary = nonEmpty(buildMedicationGlossary(input.question));
    return { ...evidence, hostTopicTerms, hostParentTerms, hostOutcomeTerms, glossary };
  }

  savePaperReferences(papers: Paper[]): PaperReferenceRecord[] {
    return this.cache.savePaperReferences(papers);
  }

  getPaperReference(paperId: string): PaperReferenceRecord | undefined {
    return this.cache.getPaperReference(paperId);
  }

  async findEvidence(input: FindEvidenceInput, options: FullEvidenceOptions = {}): Promise<EvidenceSearchResult> {
    const fallbackCategory = classifyCategory(input.question, input.category ?? "auto");
    const fallbackQueryTerms = buildQueryTerms(input.question, fallbackCategory);
    let searchPlan = options.searchPlan ?? await withDeadline(
      this.planSearch(input.question, fallbackCategory, fallbackQueryTerms),
      // Intent planning is the retrieval boundary: falling back to a literal
      // Korean term can return product-development papers instead of health
      // evidence. Give the model enough time to resolve the subject before
      // querying every source; retrieval itself still runs in parallel below.
      Math.max(8_000, Math.min(this.config.openaiFetchTimeoutMs, 45_000)),
      "OpenAI research intent analysis"
    ).catch((error: unknown) => {
      // Swallowing this made the failure invisible: the same question answered
      // normally once and returned "검색을 제대로 수행하지 못했습니다" the next
      // time, with nothing in the log to say why.
      logPlannerFailure(error);
      return buildFallbackSearchPlan(
        input.question,
        fallbackCategory,
        fallbackQueryTerms,
        "OpenAI 검색 계획 실패. 규칙 기반 검색어를 사용했습니다."
      );
    });
    if (searchPlan.plannedBy !== "host") {
      searchPlan = normalizeTopicWideFoodSafetyPlan(input.question, searchPlan);
      searchPlan = await this.repairBroadNutritionEvidencePlan(
        input.question,
        fallbackCategory,
        fallbackQueryTerms,
        searchPlan
      );
    }
    const category = searchPlan.category;
    const queryTerms = searchPlan.queryTerms;
    const useDynamicPlanOnly = searchPlan.plannedBy === "openai" || searchPlan.plannedBy === "gemini" || searchPlan.plannedBy === "host";
    const overviewQuery = buildTopicOverviewQuery(input.question, searchPlan.intent);
    // The planner may return broad side queries for a comparison. Rebuild the
    // direct/each-side query set from its structured intent and put it first,
    // so a named head-to-head search cannot be displaced by a generic query.
    const comparisonIntentQueries = searchPlan.intent?.questionType === "comparison"
      ? buildIntentSearchQueries(searchPlan.intent)
      : [];
    const queries = mergeSearchQueries(
      [overviewQuery ?? "", ...comparisonIntentQueries, ...searchPlan.searchQueries],
      useDynamicPlanOnly ? [] : buildFocusedSearchQueries(input.question, queryTerms, category),
      4
    );
    const looseQueries = mergeSearchQueries(
      [...comparisonIntentQueries, ...searchPlan.searchQueries].map(toLoosePlannerQuery),
      useDynamicPlanOnly ? [] : buildLooseSearchQueries(input.question, queryTerms, category),
      5
    );
    const koreanQueries = buildKoreanSearchQueries(input.question, category);
    const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
    const sourceLimit = Math.max(limit, Math.min(25, limit * 5));
    // Keep a wider, stable evidence set through to rendering. The chat UI
    // still exposes only three to five papers, but retry decisions must use
    // the exact candidate pool that the renderer will receive. A smaller
    // intermediate slice allowed three grounded reviews to be found and then
    // silently discarded before the final response.
    const selectedLimit = 20;
    const sourceErrors: SourceError[] = [];
    const sourceTraces: SourceTrace[] = [];
    const papers: Paper[] = [];
    // Focused retries are deliberately retained separately from the broad
    // provider pool. Re-ranking every source together can otherwise bury a
    // directly relevant systematic review under newer prevalence records.
    const targetedRetryPapers: Paper[] = [];

    // Keep the complete first-pass PubMed contract so later recovery paths
    // can add only genuinely new queries. This is request-local bookkeeping,
    // not a response cache: every call still starts a fresh external search.
    const initialPubMedQueries = initialPubMedSearchQueries(searchPlan.intent, queries);
    const completedPubMedQueries = new Set(initialPubMedQueries);
    const onlyUnsearchedPubMedQueries = (candidateQueries: string[]): string[] =>
      [...new Set(candidateQueries.filter((query) => query.trim() && !completedPubMedQueries.has(query)))];

    const jobs = this.searchJobs(category, queries, looseQueries, koreanQueries, input.question, sourceLimit, searchPlan.intent);
    // PubMed has its own rate-limited request queue. A six-second outer
    // deadline can expire while a valid review is merely waiting its turn,
    // then leave that request running in the queue after this answer has
    // already fallen back to weaker papers. Keep ordinary sources bounded,
    // but give the scholarly primary source enough time to complete a full
    // request cycle for this fresh question.
    const searchTimeoutMs = options.searchTimeoutMs ?? Math.max(6_000, Math.min(this.config.rapidSearchTimeoutMs, 12_000));
    const results = await Promise.allSettled(jobs.map((job) =>
      withDeadline(job.run(), sourceSearchTimeoutMs(job.source, searchTimeoutMs), `${job.source} full search`)
    ));

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        papers.push(...result.value);
        sourceTraces.push({
          source: jobs[index]?.source ?? "crossref",
          status: "fulfilled",
          paperCount: result.value.length,
          message: traceMessage(jobs[index]?.source, category)
        });
      } else {
        const source = jobs[index]?.source;
        if (source) {
          const message = errorMessage(result.reason);
          sourceErrors.push({ source, message });
          sourceTraces.push({ source, status: "rejected", paperCount: 0, message });
        }
      }
    }

    let relevanceTerms = relevanceTermsForIntent(searchPlan.intent, [...queryTerms, ...koreanQueries]);
    let reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
    let rankedPapers = rankPapers(
      reportablePapers,
      relevanceTerms,
      searchPlan.intent
    );
    let renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);

    const representativeTarget = Math.min(5, Math.max(3, limit));
    const minimumRepresentativePapers = 3;

    // Search services can return partial result sets even when the named
    // direct comparison exists. First retry a real A-versus-B query. When it
    // still does not exist, query each option on the same outcome axis rather
    // than returning "no evidence" or filling the answer with an adjacent
    // topic. This is a fresh retrieval for every request, not a topic map.
    if (searchPlan.intent?.questionType === "comparison" &&
      comparisonEvidenceScope(rankedPapers, searchPlan.intent) !== "direct") {
      const [directQuery, ...sideQueries] = buildComparisonRetryQueries(searchPlan.intent);
      const directResult = directQuery
        ? await withDeadline(
          this.pubMed.search(directQuery, Math.max(sourceLimit, 30)),
          pubMedSearchTimeoutMs(searchTimeoutMs),
          "PubMed direct-comparison retry"
        ).catch(() => [])
        : [];
      if (directResult.length > 0) {
        targetedRetryPapers.push(...directResult);
        papers.push(...directResult);
        sourceTraces.push({
          source: "pubmed",
          status: "fulfilled",
          paperCount: directResult.length,
          message: "직접 비교 검색식을 한 번 더 확인했습니다."
        });
        reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
        rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
        renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
      }

      if (comparisonEvidenceScope(rankedPapers, searchPlan.intent) !== "direct" && sideQueries.length > 0) {
        const sideResults = await Promise.allSettled(
          sideQueries.map((query) => withDeadline(
            this.pubMed.search(query, Math.max(sourceLimit, 30)),
            pubMedSearchTimeoutMs(searchTimeoutMs),
            "PubMed comparison-side retry"
          ))
        );
        const sidePapers = sideResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        if (sidePapers.length > 0) {
          targetedRetryPapers.push(...sidePapers);
          papers.push(...sidePapers);
          sourceTraces.push({
            source: "pubmed",
            status: "fulfilled",
            paperCount: sidePapers.length,
            message: "직접 비교가 부족해 두 선택지의 같은 결과 축을 각각 추가 확인했습니다."
          });
          reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
          rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
          renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
        }
      }
    }

    // A causal or association question should not fall from a large research
    // literature to one or two displayed papers merely because one source
    // returned a shallow first page. Count only studies whose abstract can
    // supply a result for this exact intent; a title-level match alone must
    // not suppress the retry and leave the user with two usable papers.
    // This remains a fresh retrieval for the current request.
    let displayableReviewCount = searchPlan.intent
      ? renderablePapers.filter((paper) =>
        paper.evidenceLevel === "systematic_review" &&
        classifyPaperForIntent(paper, searchPlan.intent) !== "reject" &&
        hasGroundedFindingForIntent(paper, searchPlan.intent!)
      ).length
      : 0;
    const supportsPubMedRetry = ["health", "childcare", "nutrition", "exercise", "psychology"].includes(category);
    // Safety prompts cannot use a paper that merely mentions adverse events
    // as their final evidence. The initial PubMed pass already uses both an
    // endpoint-specific query and a broad review query; retry only when that
    // pass did not produce enough eligible reviews. Retrying unconditionally
    // used to add duplicate requests to the rate-limited queue and made
    // identical questions return different evidence depending on timing.
    const safetyEvidenceQuestion = searchPlan.intent?.questionType === "safety";
    if (searchPlan.intent &&
      searchPlan.intent.questionType !== "comparison" &&
      searchPlan.intent.questionType !== "other" &&
      supportsPubMedRetry &&
      displayableReviewCount < representativeTarget) {
      // When the user uses a broad consumer word, papers from the first pass
      // may reveal the more precise academic exposure used in outcome
      // studies. Only source-validated aliases can become a bridge; the
      // aliases remain labelled contextual rather than silently changing the
      // user's original question.
      // Safety retries already use an exact exposure plus concrete endpoint
      // query. A second LLM alias pass adds latency without improving that
      // contract and used to let broad consumer wording displace the measured
      // safety endpoint.
      const evidenceAliases = safetyEvidenceQuestion
        ? []
        : await this.openai.expandEvidenceTerms(
          input.question,
          searchPlan.intent,
          renderablePapers
        );
      if (evidenceAliases.length > 0) {
        searchPlan = {
          ...searchPlan,
          intent: enrichIntentWithEvidenceAliases(searchPlan.intent, evidenceAliases)
        };
        relevanceTerms = relevanceTermsForIntent(searchPlan.intent, [...queryTerms, ...koreanQueries]);
        rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
        renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
        displayableReviewCount = renderablePapers.filter((paper) =>
          paper.evidenceLevel === "systematic_review" &&
          classifyPaperForIntent(paper, searchPlan.intent) !== "reject" &&
          hasGroundedFindingForIntent(paper, searchPlan.intent!)
        ).length;
      }
      const reviewQueries = onlyUnsearchedPubMedQueries(buildDirectReviewRetryQueries(searchPlan.intent!));
      const reviewLimit = safetyEvidenceQuestion ? Math.max(sourceLimit, 40) : sourceLimit;
      const retryResults = reviewQueries.length > 0
        ? await Promise.allSettled(
          reviewQueries.map((query) => withDeadline(
            this.pubMed.search(query, reviewLimit),
            pubMedSearchTimeoutMs(searchTimeoutMs),
            "PubMed direct-evidence retry"
          ))
        )
        : [];
      reviewQueries.forEach((query) => completedPubMedQueries.add(query));
      const retryPapers = retryResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (retryPapers.length > 0) {
        targetedRetryPapers.push(...retryPapers);
        papers.push(...retryPapers);
        sourceTraces.push({
          source: "pubmed",
          status: "fulfilled",
          paperCount: retryPapers.length,
          message: "직접 근거 종합연구를 검색식별로 추가 확인했습니다."
        });
        reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
        rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
        renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
      }
    }

    // A broad "is X actually good/bad?" question is allowed to bridge from
    // the exact item to a parent exposure, but one broad OR query often only
    // returns the first review from that literature. Keep probing each
    // planner-approved bridge until three to five representative papers are
    // available, never padding the answer with unrelated papers.
    // This is fresh retrieval, not a topic-specific answer cache.
    const broadTopicIntent = Boolean(searchPlan.intent && isBroadTopicIntent(searchPlan.intent));
    const bridgeQueries = searchPlan.intent ? buildBroadTopicRetryQueries(searchPlan.intent) : [];
    const unsearchedBridgeQueries = onlyUnsearchedPubMedQueries(bridgeQueries);
    if (broadTopicIntent && rankedPapers.length < representativeTarget && unsearchedBridgeQueries.length > 0) {
      const bridgeResults = await Promise.allSettled(
        unsearchedBridgeQueries.map((query) => withDeadline(
          this.pubMed.search(query, sourceLimit),
          pubMedSearchTimeoutMs(searchTimeoutMs),
          "PubMed topic-bridge retry"
        ))
      );
      unsearchedBridgeQueries.forEach((query) => completedPubMedQueries.add(query));
      const bridgePapers = bridgeResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      if (bridgePapers.length > 0) {
        papers.push(...bridgePapers);
        sourceTraces.push({
          source: "pubmed",
          status: "fulfilled",
          paperCount: bridgePapers.length,
          message: "넓은 주제의 상위 근거를 하나의 종합 검색식으로 추가 확인했습니다."
        });
        reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
        rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
        renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
      }
    }

    // A title/keyword match is only a candidate, never a user-facing result.
    // Ask the grounded extraction gate to translate the explicit result
    // sentence from each ranked abstract, then drop candidates that cannot
    // supply one. This removes the old "Korean extraction failed" placeholder
    // from every topic instead of patching individual foods or medicines.
    let groundingPool = uniqueGroundingPapers([
      ...targetedRetryPapers,
      ...renderablePapers
    ]).filter((paper) => Boolean(paper.abstract?.trim()));
    let groundingCandidates = selectGroundingCandidates(groundingPool, searchPlan.intent, 18);
    let groundingAttempted = false;
    let groundedPapers = await this.groundCandidateBatches(
      input.question,
      searchPlan.intent,
      groundingCandidates,
      minimumRepresentativePapers,
      (attempted) => { groundingAttempted ||= attempted; }
    );

    // A broad question can have many title matches but only one or two
    // abstracts with a reportable result. In that case, retry the remaining
    // intent-approved bridge queries after grounding, not before it. Counting
    // raw title matches here was the reason a subject such as sausage could
    // stop at two displayed studies despite a large literature.
    if (groundedPapers.length < 3 && broadTopicIntent && bridgeQueries.length > 0) {
      // The initial pass already covers the exact-item and parent bridge
      // routes. A supplement is allowed only for a newly introduced,
      // source-validated bridge query; replaying the same PubMed queries here
      // created long queues and different answers for identical questions.
      const supplementalQueries = onlyUnsearchedPubMedQueries(bridgeQueries);
      const supplementalResults = await Promise.allSettled(
        supplementalQueries.map((query) => withDeadline(
          this.pubMed.search(query, sourceLimit),
          pubMedSearchTimeoutMs(searchTimeoutMs),
          "PubMed grounded-topic supplement"
        ))
      );
      supplementalQueries.forEach((query) => completedPubMedQueries.add(query));
      const supplementalPapers = supplementalResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      if (supplementalPapers.length > 0) {
        papers.push(...supplementalPapers);
        sourceTraces.push({
          source: "pubmed",
          status: "fulfilled",
          paperCount: supplementalPapers.length,
          message: "결과 문장이 확인되는 대표 논문을 보강했습니다."
        });
        reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
        rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
        renderablePapers = ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, selectedLimit);
        groundingPool = uniqueGroundingPapers([
          ...targetedRetryPapers,
          ...renderablePapers
        ]).filter((paper) => Boolean(paper.abstract?.trim()));
        groundingCandidates = selectGroundingCandidates(groundingPool, searchPlan.intent, 18);
        groundedPapers = await this.groundCandidateBatches(
          input.question,
          searchPlan.intent,
          groundingCandidates,
          minimumRepresentativePapers,
          (attempted) => { groundingAttempted ||= attempted; }
        );
      }
    }

    // Never fall through to a title-only or heuristic result if source-grounded
    // extraction fails. The only allowed user-facing papers are the ones whose
    // concrete abstract result sentence was validated above.
    // A retrieval plan is a relevance contract. If every candidate fails that
    // contract (or no candidate has a validated result sentence), return no
    // papers rather than falling back to ensureKoreanCoverage's raw provider
    // list. That fallback could re-expose food-preservation, animal-feed, or
    // medical-material records after the classifier correctly rejected them.
    if (searchPlan.intent || groundingAttempted) {
      const rankedGroundedPapers = rankGroundedPapers(groundedPapers, searchPlan.intent);
      renderablePapers = rankedGroundedPapers;
      rankedPapers = rankedGroundedPapers;
    }

    this.rememberWorkingSearchPlan(input.question, searchPlan, renderablePapers);
    return {
      category,
      queryTerms,
      researchIntent: searchPlan.intent,
      comparisonEvidenceScope: comparisonEvidenceScope(rankedPapers, searchPlan.intent),
      evidenceDirectness: evidenceDirectness(rankedPapers, searchPlan.intent),
      claimDirection: searchPlan.claimDirection,
      searchPlannedBy: searchPlan.plannedBy,
      retrievedPaperCount: reportablePapers.length,
      glossary: searchPlan.glossary ?? nonEmpty(buildMedicationGlossary(input.question)),
      papers: renderablePapers,
      sourceErrors,
      sourceTraces
    };
  }

  async checkClaimWithTrace(input: CheckClaimInput): Promise<{ evidence: EvidenceSearchResult; answer: ClaimAnswer }> {
    const category = classifyCategory(input.question, input.category ?? "auto");

    const unsupported = screenUnsupportedResearchQuestion(input.question);
    if (unsupported.unsupported) {
      const evidence: EvidenceSearchResult = {
        category,
        queryTerms: [],
        papers: [],
        sourceErrors: [],
        sourceTraces: []
      };
      return {
        evidence,
        answer: buildUnsupportedResearchAnswer(category, unsupported.answer)
      };
    }

    const searchedEvidence = withReportableResults(await this.findEvidence(input));
    const evidence = await this.selectCoreEvidence(input.question, searchedEvidence);
    const fallbackAnswer = composeAnswer(input.question, evidence, false);
    const answer = this.postProcessAnswer(input.question, await this.synthesizeVerifiedAnswer(input.question, evidence, fallbackAnswer));
    return { evidence: searchedEvidence, answer };
  }

  async compareClaimModels(input: CheckClaimInput): Promise<ModelComparisonResult> {
    const category = classifyCategory(input.question, input.category ?? "auto");
    const unsupported = screenUnsupportedResearchQuestion(input.question);
    if (unsupported.unsupported) {
      const answer = buildUnsupportedResearchAnswer(category, unsupported.answer);
      return comparisonWithoutModelCall(answer, category, this.config);
    }

    const searchedEvidence = await this.findEvidence(input);
    const evidence = await this.selectCoreEvidence(input.question, searchedEvidence);
    const fallback = composeAnswer(input.question, evidence, false);
    const gemini: ModelComparisonRun = {
      provider: "gemini",
      model: this.config.geminiModel,
      enabled: false,
      elapsedMs: 0,
      error: "Gemini는 MCP 실행 경로에서 사용하지 않습니다."
    };
    const openai = await this.runComparisonModel(
      "openai",
      this.openai.enabled,
      this.config.openaiModel,
      () => this.openai.synthesizeClaim(input.question, evidence, fallback),
      input.question
    );
    return { evidence: searchedEvidence, models: { gemini, openai } };
  }

  popularClaims(category: string | undefined, limit = 20): PopularClaim[] {
    if (!this.config.exposePopularClaims) return [];
    return this.cache.popular(category, Math.max(1, Math.min(limit, 50)));
  }

  dataSources(): DataSourceStatus[] {
    return [
      {
        source: "pubmed",
        priority: 1,
        implemented: true,
        enabled: true,
        requiresKey: false,
        keyEnv: "PUBMED_API_KEY",
        url: "https://www.ncbi.nlm.nih.gov/books/NBK25501/",
        note: "키 없이 가능. 키가 있으면 NCBI 제한이 완화됨."
      },
      {
        source: "semantic_scholar",
        priority: 1,
        implemented: true,
        enabled: this.semanticScholar.enabled,
        requiresKey: false,
        keyEnv: "SEMANTIC_SCHOLAR_API_KEY",
        url: "https://api.semanticscholar.org/api-docs/graph",
        note: "키 없이 가능하지만 429가 자주 발생해 현재는 키가 있을 때만 검색 job에 포함."
      },
      {
        source: "openalex",
        priority: 1,
        implemented: true,
        enabled: true,
        requiresKey: false,
        keyEnv: "CONTACT_EMAIL",
        url: "https://developers.openalex.org/",
        note: "인증 불필요. polite pool용 contact email 권장."
      },
      {
        source: "europe_pmc",
        priority: 1,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://europepmc.org/RestfulWebService",
        note: "생명과학/PubMed 보강용."
      },
      {
        source: "core",
        priority: 1,
        implemented: true,
        enabled: this.core.enabled,
        requiresKey: true,
        keyEnv: "CORE_API_KEY",
        url: "https://api.core.ac.uk/docs/v3",
        note: "전 세계 오픈액세스 full text 보강. API key 필요."
      },
      {
        source: "cochrane_crossref",
        priority: 2,
        implemented: true,
        enabled: true,
        requiresKey: false,
        keyEnv: "CONTACT_EMAIL",
        url: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
        note: "Cochrane 전용 public search API 대신 Crossref에서 Cochrane Database 항목을 우선 탐색."
      },
      {
        source: "who_gho",
        priority: 2,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://www.who.int/data/gho/info/gho-odata-api",
        note: "OData Indicator 검색 후 지표값을 official statistics 근거로 보강."
      },
      {
        source: "cdc",
        priority: 2,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://dev.socrata.com/",
        note: "Socrata catalog API(q 파라미터)로 CDC dataset을 검색해 공식 데이터셋 근거로 보강."
      },
      {
        source: "myhealthfinder",
        priority: 2,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://odphp.health.gov/myhealthfinder/api/v4/itemlist.json?Type=topic",
        note: "일반인용 공식 건강 권고 보강."
      },
      {
        source: "arxiv",
        priority: 3,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://info.arxiv.org/help/api/user-manual.html",
        note: "프리프린트. health claim에서는 보수적으로 낮은 근거 등급."
      },
      {
        source: "biorxiv",
        priority: 3,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://api.biorxiv.org/",
        note: "키워드 검색 API가 아니라 최근 30일 preprint feed를 보조로만 사용."
      },
      {
        source: "medrxiv",
        priority: 3,
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://api.medrxiv.org/",
        note: "키워드 검색 API가 아니라 최근 30일 preprint feed를 보조로만 사용."
      },
      {
        source: "crossref",
        priority: 3,
        implemented: true,
        enabled: true,
        requiresKey: false,
        keyEnv: "CONTACT_EMAIL",
        url: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
        note: "DOI/서지 보강."
      },
      {
        source: "eric",
        priority: "category",
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://eric.ed.gov/?api",
        note: "교육 카테고리 우선 소스."
      },
      {
        source: "psyarxiv",
        priority: "category",
        implemented: true,
        enabled: true,
        requiresKey: false,
        url: "https://api.osf.io/v2/preprint_providers/psyarxiv/preprints/",
        note: "OSF Preprints API에서 PsyArXiv provider 직접 검색."
      },
      {
        source: "kci",
        priority: "korea",
        implemented: true,
        enabled: this.kci.enabled,
        requiresKey: true,
        keyEnv: "KCI_API_KEY",
        url: "https://www.kci.go.kr/kciportal/po/openapi/openDataView.kci?datasetBean.dtstSeqNo=1",
        note: "KCI articleSearch + referenceSearch adapter 구현. 키 없으면 비활성."
      },
      {
        source: "riss",
        priority: "korea",
        implemented: true,
        enabled: this.riss.enabled,
        requiresKey: true,
        keyEnv: "RISS_API_KEY",
        url: "https://www.data.go.kr/data/3046254/openapi.do",
        note: "RISS 학술연구정보 apiSearchJournal adapter 구현. 키 없으면 비활성."
      }
    ];
  }

  runtimeStatus(): Record<string, unknown> {
    const primaryProvider = this.openai.enabled ? "openai" : "rule_based";
    const primaryModel = this.openai.enabled ? this.config.openaiModel : undefined;
    return {
      llm: {
        provider: primaryProvider,
        enabled: this.openai.enabled,
        model: this.config.exposeDiagnosticApis || this.config.exposeDiagnosticTools ? primaryModel : undefined,
        fallback: "rule_based_evidence_synthesis"
      },
      comparison: {
        gemini: { enabled: false, model: this.config.geminiModel },
        openai: { enabled: this.openai.enabled, model: this.config.openaiModel }
      },
      cache: {
        answerReuse: false,
        note: "모든 MCP 호출은 새 검색과 새 근거 선택을 실행합니다."
      },
      security: {
        allowSkipCache: this.config.allowSkipCache,
        exposePopularClaims: this.config.exposePopularClaims,
        exposeDiagnosticApis: this.config.exposeDiagnosticApis,
        exposeDiagnosticTools: this.config.exposeDiagnosticTools,
        maxQuestionLength: this.config.maxQuestionLength,
        rateLimitWindowMs: this.config.rateLimitWindowMs,
        rateLimitMaxRequests: this.config.rateLimitMaxRequests
      }
    };
  }

  diagnosticToolsEnabled(): boolean {
    return this.config.exposeDiagnosticTools;
  }

  close(): void {
    this.cache.close();
  }

  private searchJobs(
    category: Exclude<Category, "auto">,
    queries: string[],
    looseQueries: string[],
    koreanQueries: string[],
    originalQuestion: string,
    limit: number,
    intent?: ResearchIntent
  ): Array<{ source: SourceError["source"]; run: () => Promise<Paper[]> }> {
    const jobs: Array<{ source: SourceError["source"]; run: () => Promise<Paper[]> }> = [
      { source: "openalex", run: () => searchQueryVariants(looseQueries, limit, (searchQuery, perQueryLimit) => this.openAlex.search(searchQuery, perQueryLimit)) },
      { source: "crossref", run: () => searchQueryVariants(looseQueries, limit, (searchQuery, perQueryLimit) => this.crossref.search(searchQuery, perQueryLimit)) }
    ];
    if (this.semanticScholar.enabled) {
      jobs.unshift({ source: "semantic_scholar", run: () => searchQueryVariants(looseQueries, limit, (searchQuery, perQueryLimit) => this.semanticScholar.search(searchQuery, perQueryLimit, category)) });
    }

    if (["health", "childcare", "nutrition", "exercise", "psychology"].includes(category)) {
      // PubMed serializes requests to respect NCBI's rate limit. For safety
      // questions, four broad planner queries can consume the whole queue
      // before the direct adverse-event review is fetched. Start with the
      // one high-recall endpoint query; other sources still search variants
      // in parallel and the retry below can add a broad review sweep.
      const pubMedQueries = initialPubMedSearchQueries(intent, queries);
      // Endpoint-heavy safety reviews are often ranked below broad consumer
      // surveys in PubMed. Retrieve a wider first page here; only the
      // grounded three to five are ever shown to the user.
      const pubMedLimit = intent?.questionType === "safety"
        ? Math.max(limit, 40)
        : intent && isBroadTopicIntent(intent)
          ? Math.max(limit, 36)
          : limit;
      jobs.unshift(
        { source: "pubmed", run: () => searchQueryVariants(pubMedQueries, pubMedLimit, (searchQuery, perQueryLimit) => this.pubMed.search(searchQuery, perQueryLimit)) },
        { source: "europe_pmc", run: () => searchQueryVariants(queries, limit, (searchQuery, perQueryLimit) => this.europePmc.search(searchQuery, perQueryLimit)) },
        { source: "cochrane_crossref", run: () => searchQueryVariants(looseQueries, limit, (searchQuery, perQueryLimit) => this.crossref.search(searchQuery, perQueryLimit, true)) }
      );
    }
    if (category === "education") {
      jobs.unshift({ source: "eric", run: () => searchQueryVariants(queries, limit, (searchQuery, perQueryLimit) => this.eric.search(searchQuery, perQueryLimit)) });
    }
    if (["health", "nutrition", "childcare"].includes(category)) {
      jobs.push({ source: "myhealthfinder", run: () => this.myHealthfinder.search(looseQueries[0] ?? originalQuestion, Math.min(limit, 3)) });
      jobs.push({ source: "who_gho", run: () => this.whoGho.search(looseQueries[0] ?? originalQuestion, Math.min(limit, 3)) });
      jobs.push({ source: "cdc", run: () => this.cdc.search(looseQueries[0] ?? originalQuestion, Math.min(limit, 3)) });
    }
    if (this.core.enabled) {
      jobs.push({ source: "core", run: () => searchQueryVariants(looseQueries, limit, (searchQuery, perQueryLimit) => this.core.search(searchQuery, perQueryLimit)) });
    }
    if (["education", "psychology", "exercise", "nutrition"].includes(category)) {
      jobs.push({ source: "arxiv", run: () => this.arxiv.search(looseQueries[0] ?? originalQuestion, Math.min(limit, 3)) });
    }
    if (category === "psychology") {
      jobs.push({ source: "psyarxiv", run: () => this.osfPreprints.searchPsyArxiv(looseQueries[0] ?? originalQuestion, Math.min(limit, 3)) });
    }
    if (category === "health") {
      jobs.push(
        { source: "biorxiv", run: async () => filterPapersByQuery(await this.biorxiv.recent(Math.min(limit, 3)), queries.join(" ")) },
        { source: "medrxiv", run: async () => filterPapersByQuery(await this.medrxiv.recent(Math.min(limit, 3)), queries.join(" ")) }
      );
    }
    if (this.kci.enabled) {
      jobs.push({ source: "kci", run: () => searchKoreanSources(koreanQueries, originalQuestion, limit, (searchQuery) => this.kci.search(searchQuery, limit)) });
    }
    if (this.riss.enabled) {
      jobs.push({ source: "riss", run: () => searchKoreanSources(koreanQueries, originalQuestion, limit, (searchQuery) => this.riss.search(searchQuery, limit)) });
    }

    return jobs;
  }

  private async findEvidenceFast(
    input: FindEvidenceInput,
    options: FastEvidenceOptions = {}
  ): Promise<EvidenceSearchResult> {
    const fallbackCategory = classifyCategory(input.question, input.category ?? "auto");
    const fallbackQueryTerms = buildQueryTerms(input.question, fallbackCategory);
    const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
    const sourceLimit = Math.max(12, Math.min(15, limit * 3));
    const selectedLimit = Math.max(10, limit * 2);
    let searchPlan: SearchPlan = options.searchPlan ?? buildFallbackSearchPlan(
      input.question,
      fallbackCategory,
      fallbackQueryTerms,
      "빠른 모델 분석을 사용할 수 없어 규칙 기반 검색어를 사용했습니다."
    );
    if (!options.searchPlan && options.planWithAi !== false && this.openai.enabled) {
      try {
        searchPlan = await withDeadline(
          this.planSearch(input.question, fallbackCategory, fallbackQueryTerms),
          options.plannerTimeoutMs ?? Math.max(1_500, Math.min(this.config.openaiFetchTimeoutMs, 12_000)),
          "OpenAI research intent analysis"
        );
      } catch {
        // A failed planner falls back to the deterministic scholarly terms.
      }
    }
    if (searchPlan.plannedBy !== "host") {
      searchPlan = normalizeTopicWideFoodSafetyPlan(input.question, searchPlan);
    }

    const category = searchPlan.category;
    const queryTerms = searchPlan.queryTerms;
    const useDynamicPlanOnly = searchPlan.plannedBy === "openai" || searchPlan.plannedBy === "gemini" || searchPlan.plannedBy === "host";
    const plannedFallbackQueries = useDynamicPlanOnly
      ? []
      : buildFocusedSearchQueries(input.question, queryTerms, category);
    const plannedFallbackLooseQueries = useDynamicPlanOnly
      ? []
      : buildLooseSearchQueries(input.question, queryTerms, category);
    const overviewQuery = buildTopicOverviewQuery(input.question, searchPlan.intent);
    const queries = mergeSearchQueries([overviewQuery ?? "", ...searchPlan.searchQueries], plannedFallbackQueries, 4);
    const looseQueries = mergeSearchQueries(
      searchPlan.searchQueries.map(toLoosePlannerQuery),
      plannedFallbackLooseQueries,
      5
    );
    const koreanQueries = buildKoreanSearchQueries(input.question, category);
    const hostPlanned = searchPlan.plannedBy === "host";
    // Host evidence applies its own strict direct/topic-context/outcome-context
    // lanes after retrieval. Keeping only the generic top ten here lets the
    // parallel context probes crowd exact PubMed trials out before that gate.
    const hostCandidateLimit = hostPlanned ? Math.max(40, selectedLimit) : selectedLimit;
    // The first response must establish whether direct evidence exists. Contextual
    // evidence is useful only after that search, never as the primary retrieval path.
    const broadTopicQuery = isBroadTopicQuestion(input.question)
      ? searchPlan.searchQueries.find((query) => !/\b(?:systematic review|meta analysis|umbrella review)\b/i.test(query))
      : undefined;
    const broadTopicReviewQuery = buildBroadTopicReviewQuery(searchPlan.intent);
    const reviewFocusedQuery = searchPlan.intent?.preferredStudyDesigns.some((design) => /review|meta|guideline|consensus/i.test(design))
      ? searchPlan.searchQueries.find((query) => /systematic review|meta[ -]?analysis|umbrella review|guideline|consensus/i.test(query))
      : undefined;
    const hostParentFocusedQuery = hostPlanned && searchPlan.searchQueries.length > 1
      ? searchPlan.searchQueries[1]
      : undefined;
    const hostParentContextQuery = hostParentFocusedQuery
      ? searchPlan.searchQueries[2] ?? hostParentFocusedQuery
      : undefined;
    // For a broad health-outcome claim, a focused evidence synthesis is a
    // better first probe than the literal product-name query. The latter often
    // returns product formulation or consumer-preference papers before the
    // reviews that actually report the health result.
    const focusedQuery = options.hostDirectPubMedQuery ?? hostParentFocusedQuery ?? broadTopicQuery ?? overviewQuery ?? reviewFocusedQuery ?? searchPlan.searchQueries[0] ?? queries[0] ?? looseQueries[0] ?? input.question;
    const secondaryFocusedQuery = hostParentFocusedQuery
      // PubMed is the most reliable rapid source for human outcome reviews.
      // When the exact product is sparse, give it the explicit parent query
      // and still send the exact product query to Europe PMC in parallel.
      ? searchPlan.searchQueries[0] ?? focusedQuery
      : hostPlanned
        ? searchPlan.searchQueries.find((query) => query !== focusedQuery) ?? focusedQuery
      : Boolean(reviewFocusedQuery)
        ? focusedQuery
      : selectSecondaryRapidFocusedQuery(queries, focusedQuery);
    const looseQuery = broadTopicReviewQuery
      ? toLoosePlannerQuery(broadTopicReviewQuery)
      : hostPlanned
      ? toLoosePlannerQuery(searchPlan.searchQueries[2] ?? secondaryFocusedQuery)
      : searchPlan.searchQueries[2]
        ? toLoosePlannerQuery(searchPlan.searchQueries[2])
        : looseQueries[0] ?? focusedQuery;
    // PubMed and Europe PMC establish the exact question first. Crossref also
    // searches the closest broad query so a narrow dose/schedule does not turn
    // into an empty answer when OpenAlex is slow or rate-limited.
    const contextualQuery = buildContextualIntentQuery(searchPlan.intent);
    const contextualOrThirdQuery = contextualQuery ?? searchPlan.searchQueries[2];
    const crossrefQuery = hostPlanned
      ? toLoosePlannerQuery(searchPlan.searchQueries.at(-1) ?? secondaryFocusedQuery)
      : contextualOrThirdQuery
      ? toLoosePlannerQuery(contextualOrThirdQuery)
      : buildCrossrefIntentQuery(searchPlan.intent) ?? toLoosePlannerQuery(focusedQuery);
    const comparisonOptionQuery = searchPlan.intent?.questionType === "comparison"
      ? searchPlan.searchQueries[2]
      : undefined;
    const searchTimeoutMs = options.searchTimeoutMs ?? Math.max(50, Math.min(this.config.rapidSearchTimeoutMs, 8_000));
    const jobs = this.fastSearchJobs(
      category,
      focusedQuery,
      secondaryFocusedQuery,
      looseQuery,
      crossrefQuery,
      sourceLimit,
      comparisonOptionQuery,
      broadTopicReviewQuery,
      hostParentContextQuery,
      options.hostTopicContextQuery,
      options.hostOutcomeContextQuery,
      Math.max(500, searchTimeoutMs - 100)
    );
    const results = await Promise.allSettled(
      jobs.map((job) => withDeadline(job.run(), searchTimeoutMs, `${job.source} focused search`))
    );
    const papers: Paper[] = [];
    const sourceErrors: SourceError[] = [];
    const sourceTraces: SourceTrace[] = [];

    for (const [index, result] of results.entries()) {
      const source = jobs[index]?.source;
      if (!source) continue;
      if (result.status === "fulfilled") {
        papers.push(...result.value);
        sourceTraces.push({
          source,
          status: "fulfilled",
          paperCount: result.value.length,
          message: searchPlan.plannedBy === "fallback" ? "규칙 기반 표적 검색" : "AI 연구 의도 기반 표적 검색"
        });
      } else {
        const message = errorMessage(result.reason);
        sourceErrors.push({ source, message });
        sourceTraces.push({ source, status: "rejected", paperCount: 0, message });
      }
    }

    const relevanceTerms = relevanceTermsForIntent(searchPlan.intent, [...queryTerms, ...koreanQueries]);
    const reportablePapers = papers.filter((paper) => Boolean(paper.abstract?.trim()));
    const rankedPapers = rankPapers(reportablePapers, relevanceTerms, searchPlan.intent);
    return {
      category,
      queryTerms,
      researchIntent: searchPlan.intent,
      comparisonEvidenceScope: comparisonEvidenceScope(rankedPapers, searchPlan.intent),
      evidenceDirectness: evidenceDirectness(rankedPapers, searchPlan.intent),
      claimDirection: searchPlan.claimDirection,
      searchPlannedBy: searchPlan.plannedBy,
      retrievedPaperCount: reportablePapers.length,
      papers: ensureKoreanCoverage(rankedPapers, reportablePapers, relevanceTerms, hostCandidateLimit),
      sourceErrors,
      sourceTraces
    };
  }

  private fastSearchJobs(
    category: Exclude<Category, "auto">,
    focusedQuery: string,
    secondaryFocusedQuery: string,
    looseQuery: string,
    crossrefQuery: string,
    limit: number,
    comparisonOptionQuery?: string,
    broadTopicReviewQuery?: string,
    hostParentContextQuery?: string,
    hostTopicContextQuery?: string,
    hostOutcomeContextQuery?: string,
    requestTimeoutMs?: number
  ): Array<{ source: SourceError["source"]; run: () => Promise<Paper[]> }> {
    if (["health", "childcare", "nutrition", "exercise", "psychology"].includes(category)) {
      return [
        { source: "pubmed", run: () => this.pubMed.search(focusedQuery, limit, requestTimeoutMs) },
        { source: "europe_pmc", run: () => this.europePmc.search(secondaryFocusedQuery, limit) },
        // Sparse exact questions still need a principled evidence ladder. Run
        // title-anchored topic-only and outcome-only probes in parallel, then
        // let the MCP renderer expose at most the relevant context lanes with
        // explicit non-direct labels.
        ...(hostTopicContextQuery && hostTopicContextQuery !== secondaryFocusedQuery
          ? [{ source: "europe_pmc" as const, run: () => this.europePmc.search(hostTopicContextQuery, limit) }]
          : []),
        ...(hostOutcomeContextQuery && hostOutcomeContextQuery !== secondaryFocusedQuery && hostOutcomeContextQuery !== hostTopicContextQuery
          ? [{ source: "europe_pmc" as const, run: () => this.europePmc.search(hostOutcomeContextQuery, limit) }]
          : []),
        // Europe PMC has no shared local request queue, so it is the second
        // independent path for an explicitly requested parent exposure. This
        // prevents a busy PubMed queue from reducing a broad food question to
        // one paper even though its review literature is readily available.
        ...(hostParentContextQuery && hostParentContextQuery !== secondaryFocusedQuery
          ? [{ source: "europe_pmc" as const, run: () => this.europePmc.search(hostParentContextQuery, limit) }]
          : []),
        ...(comparisonOptionQuery && comparisonOptionQuery !== focusedQuery && comparisonOptionQuery !== secondaryFocusedQuery
          ? [{ source: "pubmed" as const, run: () => this.pubMed.search(comparisonOptionQuery, Math.max(6, Math.ceil(limit * 0.75)), requestTimeoutMs) }]
          : []),
        ...(broadTopicReviewQuery && broadTopicReviewQuery !== focusedQuery
          // PubMed requires a search request and an article fetch. Keep this
          // targeted review probe small so it completes inside the rapid path
          // instead of losing the only relevant overview to the deadline.
          ? [{ source: "pubmed" as const, run: () => this.pubMed.search(broadTopicReviewQuery, Math.min(5, Math.max(3, Math.ceil(limit / 3))), requestTimeoutMs) }]
          : []),
        { source: "openalex", run: () => this.openAlex.search(looseQuery, limit) },
        { source: "crossref", run: () => this.crossref.search(crossrefQuery, limit) }
      ];
    }

    return [
      { source: "eric", run: () => this.eric.search(focusedQuery, limit) },
      { source: "openalex", run: () => this.openAlex.search(looseQuery, limit) },
      { source: "crossref", run: () => this.crossref.search(crossrefQuery, limit) }
    ];
  }

  private async synthesizeVerifiedAnswer(
    question: string,
    evidence: EvidenceSearchResult,
    fallbackAnswer: ClaimAnswer
  ): Promise<ClaimAnswer> {
    // The LLM plans the search and helps select papers, but it must not
    // rewrite the selected abstracts into a second, unconstrained answer.
    // That last rewrite was the source of generic phrases such as "an effect
    // was reported" and invented history narratives despite concrete values
    // being available in the cited papers. The deterministic renderer below
    // only exposes findings parsed from those papers.
    void question;
    void evidence;
    return fallbackAnswer;
  }

  private async selectCoreEvidence(_question: string, evidence: EvidenceSearchResult): Promise<EvidenceSearchResult> {
    // The OpenAI planner establishes the retrieval contract. Ranking and the
    // shared relevance gate then decide which papers remain; a second model
    // pass must not reintroduce a paper with a different outcome.
    return evidence;
  }

  private async groundCandidateBatches(
    question: string,
    intent: ResearchIntent | undefined,
    candidates: Paper[],
  target: number,
  onAttempt: (attempted: boolean) => void
  ): Promise<Paper[]> {
    const groundedByKey = new Map<string, Paper>();
    const broadTopicIntent = Boolean(intent && isBroadTopicIntent(intent));
    const reviewTarget = broadTopicIntent
      ? Math.min(target, candidates.filter((paper) => paper.evidenceLevel === "systematic_review").length)
      : 0;
    // One batch keeps translation output small and makes the provenance map
    // unambiguous. A second batch is only used when fewer than three papers
    // have an explicit result, so normal responses do not pay for it.
    for (let offset = 0; offset < candidates.length; offset += 6) {
      // A single unclassified report may contain a valid sentence, but it
      // must not make us stop before we have three review/trial/cohort-level
      // papers when those are available later in the candidate pool.
      const grounded = [...groundedByKey.values()];
      const groundedReviewCount = grounded.filter((paper) => paper.evidenceLevel === "systematic_review").length;
      if (groundedRepresentativeCount(grounded, intent) >= target && groundedReviewCount >= reviewTarget) break;
      const batch = candidates.slice(offset, offset + 6);
      if (batch.length === 0) break;
      onAttempt(true);
      const findings = await withDeadline(
        this.openai.extractGroundedFindings(question, intent, batch),
        Math.max(12_000, Math.min(this.config.openaiFetchTimeoutMs, 24_000)),
        "OpenAI abstract finding extraction"
      ).catch((error: unknown) => {
        // Silently dropping this made a grounding failure look identical to
        // "no paper reported a result", which is how a working question
        // started answering "연구를 찾지 못했습니다" with no trace.
        console.error(`[grounding] batch failed: ${errorMessage(error)}`);
        return undefined;
      });
      if (!findings) continue;
      for (const finding of findings) {
        const paper = batch[finding.index - 1];
        if (!paper) continue;
        groundedByKey.set(groundingPaperKey(paper), {
          ...paper,
          groundedFindingKo: finding.resultKo,
          groundedHeadlineKo: finding.headlineKo,
          groundedSourceSentence: finding.sourceSentence
        });
      }
    }
    return [...groundedByKey.values()];
  }

  /**
   * Resolve a Korean question into the English scholarly query the host would
   * send, so a deploy can populate the MCP retrieval cache before any user
   * asks. Only used offline by the prewarm script, where the planner's latency
   * does not count against Kakao's tool-latency budget.
   */
  async planHostQuery(question: string): Promise<{ academicQuery: string; category: Exclude<Category, "auto"> } | undefined> {
    const fallbackCategory = classifyCategory(question, "auto");
    const plan = await this.planSearch(question, fallbackCategory, buildQueryTerms(question, fallbackCategory));
    const academicQuery = plan.searchQueries.find((query) => /[a-z]{3}/i.test(query))?.trim();
    return academicQuery ? { academicQuery, category: plan.category } : undefined;
  }

  private async planSearch(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackQueryTerms: string[]
  ): Promise<SearchPlan> {
    // Measured over five runs of ten questions: every unstable answer moved at
    // this step and none moved later. "계란 하루 몇개까지 ㄱㅊ?" produced five
    // different term sets in five calls, swinging candidates 20-37 and
    // citations 1-5. The plan is a pure function of the question, so reuse the
    // first one: the same question then gives the same answer, and the slowest
    // step in the request disappears on a repeat.
    const ttlMs = this.config.searchPlanCacheTtlMs;
    const cacheKey = normalizeQuestion(question);
    if (ttlMs > 0) {
      const cached = this.cache.getSearchPlan(cacheKey, fallbackCategory) as SearchPlan | undefined;
      if (cached?.searchQueries?.length) return cached;
    }
    // Saving happens in findEvidence, once the plan has been shown to retrieve
    // something. Caching here froze whichever plan the model happened to
    // produce, so a bad draw became the permanent answer for seven days: the
    // same question that returns a paper on a fresh plan returned "연구를 찾지
    // 못했습니다" on every later call.
    return this.planSearchUncached(question, fallbackCategory, fallbackQueryTerms);
  }

  /** Only a plan that actually retrieved evidence is worth repeating. */
  private rememberWorkingSearchPlan(question: string, plan: SearchPlan, papers: Paper[]): void {
    const ttlMs = this.config.searchPlanCacheTtlMs;
    if (ttlMs <= 0 || papers.length === 0 || plan.plannedBy === "fallback") return;
    this.cache.saveSearchPlan(normalizeQuestion(question), plan.category, plan, ttlMs);
  }

  private async planSearchUncached(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackQueryTerms: string[]
  ): Promise<SearchPlan> {
    if (!this.openai.enabled) {
      return buildFallbackSearchPlan(question, fallbackCategory, fallbackQueryTerms, "OpenAI key 없음. 규칙 기반 검색어 사용.");
    }
    try {
      const plan = await this.openai.planSearch(question, fallbackCategory, fallbackQueryTerms);
      const normalizedPlan: SearchPlan = {
        ...plan,
        category: shouldKeepFallbackCategory(question, fallbackCategory, plan.category) ? fallbackCategory : plan.category,
        queryTerms: mergeQueryTerms(plan.queryTerms, fallbackQueryTerms)
      };
      const brandedPlan = applyKoreanBrandPlan(question, normalizedPlan);
      const resolvedPlan = await this.resolveMedicationEntityPlan(question, brandedPlan);
      return finalizeSearchPlan(resolvedPlan, fallbackQueryTerms);
    } catch (error) {
      logPlannerFailure(error);
      return buildFallbackSearchPlan(question, fallbackCategory, fallbackQueryTerms, "OpenAI 검색 계획 실패. 규칙 기반 검색어 사용.");
    }
  }

  /**
   * A retrieval planner can transliterate an unfamiliar Korean brand name
   * slightly wrong. Validate medicine-like entities with RxNorm before the
   * paper search, so that one spelling error cannot become a false "no study"
   * answer. RxNorm provides only a generic-name alias; all user-facing facts
   * still originate in the selected papers.
   */
  private async resolveMedicationEntityPlan(question: string, plan: SearchPlan): Promise<SearchPlan> {
    const intent = plan.intent;
    if (!intent || !looksLikeMedicationIntent(intent)) return plan;
    const aliases = await withDeadline(
      this.rxNav.resolveIngredientAliases([question, intent.exposure, ...intent.exposureTerms]),
      Math.min(2_000, this.config.fetchTimeoutMs),
      "RxNorm medicine-name resolution"
    ).catch(() => []);
    const ingredients = [...new Set(aliases.map((alias) => alias.ingredient))]
      .filter((ingredient) => isPlausibleIngredientFor(ingredient, question, intent));
    if (ingredients.length === 0) return plan;

    const genericName = ingredients[0]!;
    // The search runs on the ingredient, but the reader asked about a brand.
    // Carry the pairing so the answer can say which is which instead of
    // silently swapping the user's word for one they have never seen.
    const glossary = buildMedicationGlossary(question);
    // Once an authoritative generic ingredient is found, keep only that term
    // for the exposure group. A hallucinated synonym such as an unrelated food
    // must not remain as an OR branch in a scholarly search.
    const exposureTerms = [genericName];
    const directEvidenceGroups = (intent.directEvidenceGroups?.length ?? 0) > 0
      ? intent.directEvidenceGroups!.map((group, index) =>
        index === 0 ? [genericName] : group)
      : [exposureTerms, ...(intent.outcomeTerms.length > 0 ? [intent.outcomeTerms] : [])];
    const outcomeQuery = intent.outcomeTerms.slice(0, 2).join(" ").trim();
    const contextualEvidenceTerms = mergeQueryTerms([
      outcomeQuery ? `${genericName} ${outcomeQuery}` : genericName,
    ], []).slice(0, 1);

    return {
      ...plan,
      glossary: glossary.length > 0 ? glossary : plan.glossary,
      intent: {
        ...intent,
        exposure: genericName,
        exposureTerms,
        directEvidenceGroups,
        contextualEvidenceTerms
      }
    };
  }

  private async repairBroadNutritionEvidencePlan(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackQueryTerms: string[],
    plan: SearchPlan
  ): Promise<SearchPlan> {
    if (!needsBroadNutritionEvidenceLadder(question, plan) || !this.openai.enabled) return plan;
    try {
      const normalizeRepair = (repaired: SearchPlan | undefined): SearchPlan | undefined => {
        if (!repaired?.intent) return undefined;
        const normalized: SearchPlan = {
          ...repaired,
          // This repair is only invoked for an already classified nutrition
          // question. Do not let a second model response silently move it to a
          // different retrieval corpus.
          category: "nutrition",
          queryTerms: mergeQueryTerms(repaired.queryTerms, fallbackQueryTerms)
        };
        return finalizeSearchPlan(normalizeTopicWideFoodSafetyPlan(question, normalized), fallbackQueryTerms);
      };
      const repairOnce = (candidate: SearchPlan) => withDeadline(
        this.openai.repairBroadNutritionPlan(question, fallbackCategory, fallbackQueryTerms, candidate),
        Math.max(8_000, Math.min(this.config.openaiFetchTimeoutMs, 30_000)),
        "OpenAI broad nutrition retrieval-plan repair"
      );
      let first: SearchPlan | undefined;
      try {
        first = normalizeRepair(await repairOnce(plan));
      } catch {
        return plan;
      }
      if (first && !needsBroadNutritionEvidenceLadder(question, first)) return first;

      // A plan with an empty parent route is still vulnerable to product and
      // production literature. Ask once more rather than accepting a merely
      // fluent paraphrase of the first plan. This runs only in the local/full
      // evidence path; the Kakao MCP rapid path never waits for it.
      let second: SearchPlan | undefined;
      try {
        second = normalizeRepair(await repairOnce(first ?? plan));
      } catch {
        second = undefined;
      }
      return second ?? first ?? plan;
    } catch {
      // The first plan remains a valid exact-item route. A failed repair must
      // never turn one transient model error into a literal keyword search.
      return plan;
    }
  }

  private postProcessAnswer(question: string, answer: ClaimAnswer): ClaimAnswer {
    if (answer.verdict === "safety_redirect") return answer;
    const summary = answer.summary_ko?.trim() || answer.answer_ko.trim();
    const processed = summary === answer.answer_ko && summary === answer.summary_ko
      ? answer
      : { ...answer, answer_ko: summary, summary_ko: summary };
    return redactExactQuestionEcho(processed, question);
  }

  private async runComparisonModel(
    provider: ModelComparisonRun["provider"],
    enabled: boolean,
    model: string,
    synthesize: () => Promise<ClaimAnswer>,
    question: string
  ): Promise<ModelComparisonRun> {
    if (!enabled) return { provider, model, enabled: false, elapsedMs: 0, error: `${provider} API key가 없습니다.` };
    const started = Date.now();
    try {
      const answer = this.postProcessAnswer(question, await synthesize());
      return { provider, model, enabled: true, elapsedMs: Date.now() - started, answer };
    } catch (error) {
      return { provider, model, enabled: true, elapsedMs: Date.now() - started, error: errorMessage(error) };
    }
  }
}

function initialPubMedSearchQueries(intent: ResearchIntent | undefined, fallbackQueries: string[]): string[] {
  if (intent?.questionType === "safety") {
    return buildDirectReviewRetryQueries(intent).slice(0, 2);
  }
  if (intent && isBroadTopicIntent(intent)) {
    // Search the named item in people, the named-item review literature, and
    // one planner-approved parent bridge in the first fresh pass. Running
    // only two here then replaying all three during fallback made broader
    // questions slow and timing-dependent.
    return buildBroadTopicRetryQueries(intent).slice(0, 3);
  }
  return fallbackQueries;
}

function buildDirectReviewRetryQueries(intent: ResearchIntent): string[] {
  const outcomes = [...new Set(intent.outcomeTerms.map((term) => term.trim()).filter(Boolean))];
  const exposures = [...new Set([intent.exposure, ...intent.exposureTerms].map((term) => term.trim()).filter(Boolean))].slice(0, 8);
  if (outcomes.length === 0 || exposures.length === 0) return buildIntentSearchQueries(intent).slice(0, 3);
  const reviewGroup = "(systematic review OR meta-analysis OR umbrella review)";
  // This function is used only for PubMed retries. Field-scoped phrases stop
  // a broad word such as "energy" or "drink" from pulling unrelated diet,
  // exercise, or consumer-survey papers above the requested exposure.
  const exposureGroup = pubMedTitleAbstractGroup(exposures.slice(0, 4));
  const outcomeGroup = pubMedTitleAbstractGroup(focusedOutcomeQueryTerms(outcomes));
  // PubMed serializes unauthenticated requests. A fan-out of endpoint
  // searches can therefore let the blood-pressure or ECG query expire in the
  // queue while a shallow first query wins. One high-recall exact-exposure
  // query plus one broad review sweep preserves all planned endpoints while
  // giving the provider time to return the strongest studies.
  const endpointQuery = outcomeGroup
    ? `(${exposureGroup}) AND (${outcomeGroup}) AND ${reviewGroup}`
    : "";
  const broadExposureQuery = `(${exposureGroup}) AND ${reviewGroup}`;
  // Contextual aliases are added only after the first retrieval has shown
  // them in a source paper. They cover broad user terms whose literature is
  // indexed under a more specific exposure form.
  const contextualQueries = [...new Set((intent.contextualEvidenceTerms ?? [])
    .map((term) => term.trim())
    .filter(Boolean))]
    .map((term) => `(${term}) AND ${reviewGroup}`);
  // Safety already has an endpoint-focused query. Additional aliases are
  // usually the same exposure repeated with less precision, and PubMed
  // serializes each request. Keeping this to two complementary searches
  // leaves time for the blood-pressure, rhythm, and sleep reviews to return.
  if (intent.questionType === "safety") {
    return [...new Set([endpointQuery, broadExposureQuery])].filter(Boolean);
  }
  return [...new Set([endpointQuery, broadExposureQuery, ...contextualQueries])]
    .filter(Boolean)
    .slice(0, 4);
}

function buildComparisonRetryQueries(intent: ResearchIntent): string[] {
  const exposureGroup = pubMedTitleAbstractGroup([intent.exposure, ...intent.exposureTerms]);
  const comparatorGroup = pubMedTitleAbstractGroup([intent.comparator ?? "", ...intent.comparatorTerms]);
  const outcomeGroup = pubMedTitleAbstractGroup(focusedOutcomeQueryTerms(intent.outcomeTerms));
  if (!exposureGroup || !comparatorGroup || !outcomeGroup) {
    return buildIntentSearchQueries(intent).slice(0, 3);
  }
  // The outcome group is retained identically for both sides. This prevents a
  // comparison from quietly becoming "A on one endpoint, B on another" when
  // there is no head-to-head paper.
  return [
    `(${exposureGroup}) AND (${comparatorGroup}) AND (${outcomeGroup})`,
    `(${exposureGroup}) AND (${outcomeGroup})`,
    `(${comparatorGroup}) AND (${outcomeGroup})`
  ];
}

function buildBroadTopicRetryQueries(intent: ResearchIntent): string[] {
  const reviewGroup = "(systematic review OR meta-analysis OR umbrella review)";
  const exactTerms = [...new Set([intent.exposure, ...intent.exposureTerms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 3))]
    .slice(0, 4);
  const exactContextTerms = [...new Set([
    ...(intent.contextualEvidenceTerms ?? []),
    ...(intent.directContextTerms ?? [])
  ].map((term) => term.trim()).filter((term) => term.length >= 3))]
    .slice(0, 2);
  const parentTerms = [...new Set((intent.parentEvidenceTerms ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 3))]
    .slice(0, 3);
  const exactGroup = pubMedTitleAbstractGroup(exactTerms);
  // Broad questions still need direct people-facing evidence, not just a
  // review whose background happens to mention the item. This query remains
  // deliberately generic: it works for foods, substances, practices, and
  // environmental exposures without a topic-specific catalogue.
  const humanEvidenceGroup = [
    '"human"[Title/Abstract]',
    '"adult"[Title/Abstract]',
    '"participant"[Title/Abstract]',
    '"clinical"[Title/Abstract]',
    '"trial"[Title/Abstract]',
    '"cohort"[Title/Abstract]'
  ].join(" OR ");
  const exactHumanQuery = exactGroup
    ? `(${exactGroup}) AND (${humanEvidenceGroup})`
    : "";
  const exactReviewQuery = exactGroup
    ? `(${exactGroup}) AND ${reviewGroup}`
    : "";
  // Do not collapse distinct parent hypotheses into one large OR query. A
  // search engine normally fills its first page from the newest or most
  // common branch, which can leave a question based on several research
  // streams with a single representative review. Each parent route is still
  // validated and labelled contextual later; this only gives it a fair
  // retrieval chance.
  const contextualQueries = exactContextTerms.map((term) => `(${term}) AND ${reviewGroup}`);
  const parentQueries = parentTerms.map((term) => `(${term}) AND ${reviewGroup}`);
  return [...new Set([
    exactHumanQuery,
    exactReviewQuery,
    ...contextualQueries,
    ...parentQueries
  ].filter(Boolean))];
}

function focusedOutcomeQueryTerms(outcomes: string[]): string[] {
  const genericWords = new Set([
    "acute", "chronic", "general", "serious", "adverse", "event", "events", "effect", "effects",
    "outcome", "outcomes", "elevated", "increased", "decreased", "risk", "risks", "health", "clinical"
  ]);
  const variants: string[] = [];
  const add = (value: string): void => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < 4 || variants.some((existing) => existing.toLowerCase() === clean.toLowerCase())) return;
    variants.push(clean);
  };
  for (const outcome of outcomes) {
    // Keep compact scientific abbreviations (for example assay names and
    // score names) as standalone query terms. Reducing a long endpoint to
    // its final two words previously dropped the one term PubMed actually
    // indexed and let loosely related papers outrank the measured evidence.
    for (const abbreviation of outcome.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) ?? []) {
      add(abbreviation);
    }
    let addedSpecificTerm = false;
    for (const part of outcome.split(/(?:[;,/]|\bor\b)/i)) {
      const tokens = part.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
      const specificTokens = tokens.filter((token) => !genericWords.has(token));
      if (specificTokens.length >= 3) {
        add(specificTokens.slice(0, 2).join(" "));
        add(specificTokens.slice(-2).join(" "));
        addedSpecificTerm = true;
      } else if (specificTokens.length === 2) {
        add(specificTokens.join(" "));
        addedSpecificTerm = true;
      } else if (specificTokens.length === 1) {
        add(specificTokens[0]!);
        addedSpecificTerm = true;
      }
    }
    if (!addedSpecificTerm) add(outcome);
  }
  // Safety plans may list several medically equivalent endpoints. A short
  // truncation can retain "hypertension" while dropping "blood pressure" or
  // "arrhythmia" while dropping the ECG terminology used by the paper.
  return variants.slice(0, 12);
}

function pubMedTitleAbstractGroup(terms: string[]): string {
  const phrases = [...new Set(terms
    .map((term) => term.replace(/["']/g, " ").replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 3 && term.length <= 100)
    .filter((term) => /[a-z]/i.test(term))
    .filter((term) => !/\b(?:synonyms?\s+in\s+academic\s+english|english\s+scholarly\s+synonyms?|academic\s+english|scholarly\s+(?:term|query|phrase))\b/i.test(term))
  )];
  return phrases.map((term) => `"${term}"[Title/Abstract]`).join(" OR ");
}

function enrichIntentWithEvidenceAliases(intent: ResearchIntent, aliases: string[]): ResearchIntent {
  const existing = new Set((intent.contextualEvidenceTerms ?? []).map((term) => term.toLowerCase().trim()));
  const additions = aliases.filter((term) => {
    const key = term.toLowerCase().trim();
    if (!key || existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  if (additions.length === 0) return intent;
  return {
    ...intent,
    evidenceStrategy: "direct_then_contextual",
    contextualEvidenceTerms: [...additions, ...(intent.contextualEvidenceTerms ?? [])].slice(0, 4)
  };
}

function buildSuppliedSearchPlan(
  input: CheckClaimInput,
  category: Exclude<Category, "auto">,
  fallbackQueryTerms: string[]
): SearchPlan | undefined {
  const searchQuery = input.searchQuery?.trim();
  if (!searchQuery) return undefined;
  return {
    category,
    queryTerms: mergeQueryTerms(input.queryTerms ?? [], fallbackQueryTerms),
    searchQueries: [searchQuery],
    intent: input.researchIntent,
    claimDirection: input.claimDirection,
    plannedBy: "host",
    reason_ko: "호스트 AI가 사용자 질문을 학술 검색식으로 구조화했습니다."
  };
}

function normalizeHostEvidenceTerms(terms: string[] | undefined, limit: number): string[] {
  return [...new Set((terms ?? [])
    .map((term) => term.replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 2)
  )].slice(0, limit);
}

function buildHostParentSearchQueries(parentTerms: string[], outcomeTerms: string[]): string[] {
  const queries: string[] = [];
  for (const parent of parentTerms) {
    const outcomes = outcomeTerms.length > 0 ? outcomeTerms : ["health effects"];
    for (const outcome of outcomes) {
      queries.push(`${parent} ${outcome} systematic review`);
      if (queries.length >= 3) return queries;
    }
  }
  return queries;
}

export function buildHostDirectPubMedQuery(topicTerms: string[], outcomeTerms: string[]): string | undefined {
  const topics = pubMedFieldGroup(topicTerms, "Title");
  if (!topics) return undefined;
  const outcomes = pubMedFieldGroup(outcomeTerms, "Title/Abstract");
  return outcomes ? `((${topics}) AND (${outcomes}))` : `(${topics})`;
}

export function buildHostContextEuropePmcQuery(terms: string[]): string | undefined {
  const titleTerms = [...new Set(terms
    .map((term) => term.replace(/["']/g, " ").replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 3 && term.length <= 100)
    .filter((term) => /[a-z]/i.test(term))
    .flatMap(expandHostSearchTerm)
  )];
  if (titleTerms.length === 0) return undefined;
  const titles = titleTerms.map((term) => `TITLE:\"${term}\"`).join(" OR ");
  return `(${titles}) AND (PUB_TYPE:\"systematic review\" OR PUB_TYPE:\"randomized controlled trial\" OR PUB_TYPE:\"clinical trial\")`;
}

function pubMedFieldGroup(terms: string[], field: "Title" | "Title/Abstract"): string {
  return [...new Set(terms
    .map((term) => term.replace(/["']/g, " ").replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 3 && term.length <= 100)
    .filter((term) => /[a-z]/i.test(term))
    .flatMap(expandHostSearchTerm)
  )]
    .map((term) => `"${term}"[${field}]`)
    .join(" OR ");
}

function expandHostSearchTerm(term: string): string[] {
  return /\bgastroesophageal reflux\b/i.test(term)
    ? [term, term.replace(/gastroesophageal/gi, "gastro-oesophageal"), "reflux"]
    : [term];
}

function looksLikeMedicationIntent(intent: ResearchIntent): boolean {
  if (intent.questionType !== "safety") return false;
  const terms = [intent.exposure, ...intent.exposureTerms];
  const corpus = terms.join(" ");
  if (/\b(?:drug|medication|medicine|injection|injectable|tablet|capsule|dose|treatment|therapy|patient)\b/i.test(corpus)) {
    return true;
  }
  // A single scholarly-looking token in a safety request is commonly a
  // generic medicine or a brand. Asking RxNorm is harmless when it is not,
  // and avoids hard-coding a catalog of Korean consumer brand names.
  return terms.some((term) => /^[a-z][a-z0-9-]{4,}$/i.test(term.trim()));
}

function comparisonWithoutModelCall(
  answer: ClaimAnswer,
  category: Exclude<Category, "auto">,
  config: Config
): ModelComparisonResult {
  const evidence: EvidenceSearchResult = { category, queryTerms: [], papers: [], sourceErrors: [], sourceTraces: [] };
  return {
    evidence,
    models: {
      gemini: { provider: "gemini", model: config.geminiModel, enabled: Boolean(config.geminiApiKey), elapsedMs: 0, answer },
      openai: { provider: "openai", model: config.openaiModel, enabled: Boolean(config.openaiApiKey), elapsedMs: 0, answer }
    }
  };
}

function buildSafetyRedirectAnswer(category: Exclude<Category, "auto">, answer?: string): ClaimAnswer {
  return {
    answer_ko: `카더라 말고 안전 기준으로 보면, 여기서는 검색 답변보다 공식 절차가 먼저입니다.\n\n${answer ?? "전문가 상담이 필요한 질문입니다."}`,
    verdict: "safety_redirect",
    evidence_level: "unknown",
    citations: [],
    limitations: ["응급, 처방, 진단, 계정 조작처럼 이 도구가 직접 처리하면 안 되는 요청은 검색 답변보다 안전한 공식 절차가 우선입니다."],
    safety_note: standardSafetyNote,
    cached: false,
    category,
    query_terms: []
  };
}

function buildHopefulSuicideSupportAnswer(): ClaimAnswer {
  return {
    answer_ko: [
      "카더라 말고 연구 기준으로 먼저 말하면, 지금 드는 생각이 앞으로도 그대로일 거라는 결론은 아닙니다. 도움을 받는 방식에 따라 실제 결과가 달라진 연구가 있습니다.",
      "연구가 보여준 변화:",
      "[1] 최근 자살을 시도한 성인 120명을 18개월 추적한 무작위시험에서 인지치료를 받은 집단은 일반 치료 집단보다 재시도율이 낮았고, 일부 추적 시점에서 우울과 절망감도 더 낮았습니다.",
      "[2] 응급실 환자에게 혼자 버티라고 하는 대신 경고 신호, 대처 행동, 연락할 사람을 함께 정하고 후속 연락을 제공했을 때 이후 자살행동이 더 적고 치료 연결은 더 많았습니다.",
      "이 근거가 말하는 핵심은 '마음을 강하게 먹어라'가 아닙니다. 지금의 생각과 행동 사이에 사람 한 명, 연락 한 번, 구체적인 안전계획 하나를 넣는 것이 실제 결과를 바꿀 수 있다는 뜻입니다.",
      "지금 10분 안에 할 일:",
      "1. 믿을 수 있는 사람 한 명에게 '지금 혼자 있으면 안 될 것 같아. 잠깐 같이 있어줘'라고 그대로 보내세요.",
      "2. 혼자 있는 장소에서 나와 사람과 함께 있고, 자신을 다치게 할 수 있는 물건이나 장소와 거리를 두세요.",
      "3. 한국에서는 자살예방상담전화 109로 전화하거나 문자 상담을 요청할 수 있습니다.",
      "지금 실행할 계획이나 수단이 있거나 곧 행동할 것 같다면 109의 답을 기다리지 말고 119 또는 가까운 응급실로 바로 연결하세요."
    ].join("\n\n"),
    verdict: "safety_redirect",
    evidence_level: "clinical_study",
    citations: suicideSupportCitations,
    practical_checks: [
      {
        label: "사람 한 명 연결",
        what_to_try_ko: "믿을 수 있는 사람에게 지금 혼자 있지 않도록 같이 있어 달라고 구체적으로 요청합니다.",
        what_to_watch_ko: "연락을 미루거나 혼자 숨고 싶은 마음이 강해지는지 봅니다.",
        why_it_matters_ko: "연구에서는 협력적인 안전계획과 후속 연결이 혼자 견디는 것보다 나은 결과와 관련됐습니다.",
        urgency: "seek_prompt_evaluation"
      },
      {
        label: "거리 만들기",
        what_to_try_ko: "자신을 다치게 할 수 있는 물건이나 장소에서 벗어나 사람이 있는 곳으로 이동합니다.",
        what_to_watch_ko: "지금 실행할 구체적인 계획이나 수단이 가까이 있는지 확인합니다.",
        why_it_matters_ko: "충동과 행동 사이에 시간과 거리를 만드는 것이 안전계획의 핵심 요소입니다.",
        urgency: "seek_prompt_evaluation"
      },
      {
        label: "전문 연결",
        what_to_try_ko: "자살예방상담전화 109, 즉시 위험하면 119 또는 응급실에 연결합니다.",
        what_to_watch_ko: "혼자서는 다음 한 시간을 안전하게 보내기 어렵다고 느끼는지 봅니다.",
        why_it_matters_ko: "위기 시점의 즉각적인 연결과 후속 연락은 연구된 자살예방 개입의 공통 요소입니다.",
        urgency: "seek_prompt_evaluation"
      }
    ],
    limitations: [
      "인용 연구는 특정 국가와 의료환경의 성인을 대상으로 했으므로 개인에게 같은 효과를 보장하지는 않습니다.",
      "이 답변은 위기 평가나 치료를 대신하지 않으며, 즉시 위험할 때는 실시간 사람 연결이 우선입니다."
    ],
    safety_note: "지금의 생각을 혼자 최종 결론으로 만들지 마세요. 한국에서는 109, 즉시 위험하면 119 또는 가까운 응급실에 연결하세요.",
    cached: false,
    category: "psychology",
    query_terms: ["suicide prevention cognitive therapy", "safety planning intervention follow-up"]
  };
}

const suicideSupportCitations: Citation[] = [
  {
    source: "pubmed",
    sourceId: "10.1001/jama.294.5.563",
    title: "Cognitive Therapy for the Prevention of Suicide Attempts: A Randomized Controlled Trial",
    authors: ["Gregory K. Brown", "Thomas Ten Have", "Gregg R. Henriques", "Sharon X. Xie", "Judd E. Hollander", "Aaron T. Beck"],
    venue: "JAMA",
    year: 2005,
    doi: "10.1001/jama.294.5.563",
    url: "https://jamanetwork.com/journals/jama/fullarticle/201330",
    evidenceLevel: "clinical_study"
  },
  {
    source: "pubmed",
    sourceId: "29998307",
    title: "Comparison of the Safety Planning Intervention With Follow-up vs Usual Care of Suicidal Patients Treated in the Emergency Department",
    authors: ["Barbara Stanley", "Gregory K. Brown", "Lisa A. Brenner", "Hanga C. Galfalvy", "Glenn W. Currier", "Kerry L. Knox"],
    venue: "JAMA Psychiatry",
    year: 2018,
    doi: "10.1001/jamapsychiatry.2018.1776",
    url: "https://pubmed.ncbi.nlm.nih.gov/29998307/",
    evidenceLevel: "observational_study"
  }
];

function buildUnsupportedResearchAnswer(category: Exclude<Category, "auto">, answer?: string): ClaimAnswer {
  return {
    answer_ko: answer ?? "연구로 검증 가능한 대상이 아니라 관련 없는 논문을 붙이지 않고 검색을 중단합니다.",
    verdict: "insufficient_evidence",
    evidence_level: "unknown",
    citations: [],
    limitations: ["현실의 검증 가능한 대상이 아니면 논문 검색 결과를 근거처럼 붙이지 않습니다."],
    safety_note: standardSafetyNote,
    cached: false,
    category,
    query_terms: []
  };
}

function applyBrandVoice(answerKo: string, verdict: ClaimAnswer["verdict"]): string {
  if (/^\s*(카더라 말고|소문 말고 논문)/.test(answerKo)) return answerKo;
  if (verdict === "safety_redirect") {
    return `카더라 말고 안전 기준으로 보면, 여기서는 검색 답변보다 공식 절차가 먼저입니다.\n\n${answerKo}`;
  }
  if (verdict === "insufficient_evidence") {
    return `카더라 말고 근거로 보면, 아직 단정할 만큼 딱 붙는 자료는 약합니다. 논문에 없으면 석박사들도 모른다고카드라.\n\n${answerKo}`;
  }
  return `카더라 말고 근거로 보면, 핵심은 이겁니다.\n\n${answerKo}`;
}

function buildPopulationContext(question: string, category: Exclude<Category, "auto">): string | undefined {
  if (category === "childcare") {
    return [
      "대상자별로 보면: 소아/영유아 질문은 성인 연구를 거의 그대로 적용하면 안 됩니다.",
      "월령 기준: 0-12개월, 12-24개월, 3-5세는 발달 기대치가 달라 같은 행동도 의미가 달라집니다.",
      "조산/저체중 출생: 실제 나이보다 교정월령과 성장 이력을 같이 봐야 합니다.",
      "남아/여아: 평균 발달 속도 차이는 있어도, 눈맞춤·호명반응·공동주의 같은 사회적 의사소통 신호가 지속적으로 약하면 성별로 넘기지 말고 평가 기준으로 봅니다.",
      "기저질환/청력/시력: 청력 저하, 시력 문제, 발작, 수면 문제는 발달 문제처럼 보일 수 있어 따로 확인해야 합니다."
    ].join(" ");
  }

  if (!["health", "nutrition", "exercise", "psychology"].includes(category)) return undefined;

  const proteinSpecific = /(단백질|프로틴|파우더|보충제|whey|protein)/i.test(question)
    ? " 예: 단백질 100g은 55kg 여성 1.82g/kg/day, 75kg 남성 1.33g/kg/day입니다."
    : "";
  const sweetenerSpecific = /(?<!실)제로|무설탕|탄산|콜라|사이다|감미료|아스파탐|수크랄로스|스테비아|에리스리톨|zero|diet soda|sweetener/i.test(question)
    ? " 제로음료는 소아/임신부에서 카페인, 단맛 습관, 페닐알라닌 표시까지 같이 봅니다."
    : "";

  return [
    `대상자별로 보면: 성인 남성/여성은 체중·활동량 때문에 같은 양의 의미가 달라집니다.${proteinSpecific}${sweetenerSpecific}`,
    "임신/수유, 소아/청소년, 노인, 당뇨·신장질환·고혈압 등 기저질환자는 건강한 성인 연구를 그대로 적용하지 말고 더 보수적으로 봅니다."
  ].join(" ");
}

function buildStudyDigest(papers: Paper[]): string | undefined {
  const usable = papers.filter((paper) => paper.title && (paper.abstract || paper.publicationTypes.length > 0)).slice(0, 3);
  if (usable.length === 0) return undefined;

  return [
    "대표 연구를 짧게 보면:",
    ...usable.map((paper, index) => {
      const citationIndex = index + 1;
      const design = studyDesignLabel(paper);
      const attribution = studyAttribution(paper);
      const what = inferWhatWasDone(paper);
      const result = inferResultSentence(paper);
      const limit = inferStudyLimit(paper);
      return `[${citationIndex}] ${attribution} ${shortTitle(paper.title)} - ${design}. 무엇을 했나: ${what} 결과: ${result} 적용 한계: ${limit}`;
    }),
    "상세 초록과 원문은 아래 출처 링크에서 확인하면 됩니다."
  ].join("\n");
}

function studyAttribution(paper: Paper): string {
  const year = paper.year ? `${paper.year}년 ` : "";
  const team = researchTeamLabel(paper);
  const venue = paper.venue ? `${paper.venue}에 실린 ` : "";
  const institution = paper.institutions?.[0] ? ` 기관/소속: ${paper.institutions.slice(0, 2).join(", ")}.` : "";
  const publisher = !paper.venue && paper.publisher ? ` 발행/제공: ${paper.publisher}.` : "";
  const database = paper.venue || paper.publisher || paper.institutions?.[0] ? "" : ` 출처 DB: ${sourceLabel(paper.source)}.`;
  return `${year}${venue}${team} 연구.${institution}${publisher}${database}`;
}

function researchTeamLabel(paper: Paper): string {
  if (paper.institutions?.[0]) return `${paper.institutions[0]} 연구팀`;
  if (paper.authors.length > 0) {
    const firstAuthor = paper.authors[0];
    const suffix = paper.authors.length > 1 ? " 등" : "";
    return `${firstAuthor}${suffix}`;
  }
  if (paper.publisher) return `${paper.publisher}`;
  if (paper.venue) return `${paper.venue}`;
  return sourceLabel(paper.source);
}

function sourceLabel(source: Paper["source"]): string {
  const labels: Record<Paper["source"], string> = {
    pubmed: "PubMed",
    semantic_scholar: "Semantic Scholar",
    openalex: "OpenAlex",
    europe_pmc: "Europe PMC",
    core: "CORE",
    cochrane_crossref: "Cochrane/Crossref",
    who_gho: "WHO GHO",
    cdc: "CDC",
    myhealthfinder: "MyHealthfinder",
    arxiv: "arXiv",
    biorxiv: "bioRxiv",
    medrxiv: "medRxiv",
    crossref: "Crossref",
    eric: "ERIC",
    psyarxiv: "PsyArXiv",
    kci: "KCI",
    riss: "RISS"
  };
  return labels[source];
}

function studyDesignLabel(paper: Paper): string {
  const text = `${paper.evidenceLevel} ${paper.publicationTypes.join(" ")} ${paper.title}`.toLowerCase();
  if (/systematic|meta/.test(text)) return "체계적 문헌고찰/메타분석";
  if (/randomized|clinical trial|controlled trial|intervention/.test(text)) return "무작위/임상 개입 연구";
  if (/cohort|case-control|cross-sectional|observational/.test(text)) return "관찰연구";
  if (/guideline|recommendation|who|cdc|healthfinder/.test(text)) return "공식 가이드라인/권고";
  if (/preprint|arxiv|medrxiv|biorxiv/.test(text)) return "프리프린트";
  return "논문/문헌";
}

function inferWhatWasDone(paper: Paper): string {
  const topic = topicLabel(paper);
  switch (paper.evidenceLevel) {
    case "systematic_review":
      return `${topic} 관련 선행연구를 모아 결과 방향을 비교했습니다.`;
    case "clinical_study":
      return `${topic}에 대한 개입군과 비교군의 변화를 비교했습니다.`;
    case "observational_study":
      return `${topic} 노출과 건강 결과의 연관성을 실제 집단 자료에서 비교했습니다.`;
    case "official_guidance":
      return `${topic}에 대한 공식 데이터나 권고 기준을 정리했습니다.`;
    case "preprint":
      return `${topic}에 대한 최신 예비 연구 결과를 제시했습니다.`;
    default:
      return `${topic}와 관련해 보고된 결과를 정리했습니다.`;
  }
}

function inferResultSentence(paper: Paper): string {
  const text = cleanAbstract(`${paper.title} ${paper.abstract ?? ""}`);
  if (!text) return "결과 방향은 원문 확인이 필요합니다.";
  if (/no (consistent|significant)|not associated|no association|lack of|insufficient/i.test(text)) {
    return "뚜렷하거나 일관된 연관성은 제한적이라고 보고했습니다.";
  }
  if (/mixed|conflicting|inconsistent|unclear|heterogen/i.test(text)) {
    return "결과가 일관되지 않아 조건별 해석이 필요하다고 보고했습니다.";
  }
  if (/microbiome|microbiota|glucose|insulin|glycemic|metabolic/i.test(text)) {
    return "장내미생물, 혈당, 인슐린 같은 대사 지표와의 관련 가능성을 제시했습니다.";
  }
  if (/cancer|carcinogen|carcinogenic|tumou?r/i.test(text)) {
    return "암 위험과의 관련성을 평가했지만, 결론은 연구 설계와 노출량에 따라 달라집니다.";
  }
  if (/improved|increased|reduced|decreased|lower|higher|benefit|effective/i.test(text)) {
    return "관련 지표의 개선, 증가, 감소 같은 방향성 결과를 보고했습니다.";
  }
  if (/risk|associated|association|linked/i.test(text)) {
    return "관련 위험 또는 연관성 신호를 보고했습니다.";
  }
  return "질문에 직접 답하는 구체적인 결과를 확인하지 못했습니다.";
}

function inferStudyLimit(paper: Paper): string {
  switch (paper.evidenceLevel) {
    case "systematic_review":
      return "여러 연구를 모았지만 대상자·기간 차이는 남습니다.";
    case "clinical_study":
      return "표본, 기간, 비교군이 내 상황과 맞는지 봐야 합니다.";
    case "observational_study":
      return "현실 데이터지만 원인-결과 단정은 어렵습니다.";
    case "preprint":
      return "동료심사 전이라 신뢰도를 낮춰 봅니다.";
    case "official_guidance":
      return "보수적 권고지만 개인 진단은 아닙니다.";
    default:
      return "원문에서 대상자와 수치를 확인해야 합니다.";
  }
}

function shortTitle(title: string): string {
  return `"${trimSentence(title, 90)}"`;
}

function cleanAbstract(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function trimSentence(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}...`;
}

function topicLabel(paper: Paper): string {
  return `논문 제목 "${trimSentence(paper.title, 55)}"에서 다룬 대상과 결과`;
}

function buildProteinDoseContext(question: string): string | undefined {
  if (!/(단백질|프로틴|파우더|보충제|whey|protein)/i.test(question)) return undefined;
  const amount = question.match(/(\d{2,3})\s*(?:g|그램)?/i)?.[1];
  if (!amount) return undefined;
  const grams = Number(amount);
  if (!Number.isFinite(grams) || grams <= 0) return undefined;

  const examples = [50, 55, 60, 70, 75, 80, 90].map((kg) => `${kg}kg=${(grams / kg).toFixed(2)}g/kg/day`);
  return [
    `체중별 환산: 하루 총 단백질 ${grams}g은 ${examples.join(", ")}입니다.`,
    `연구의 섭취량과 비교할 때는 절대량 ${grams}g보다 자신의 체중으로 나눈 g/kg/day를 사용해야 합니다.`,
    "파우더 무게와 실제 단백질량은 다를 수 있으므로 제품 라벨의 1회 제공량당 단백질과 식사 단백질을 합친 하루 총량을 기준으로 봐야 합니다."
  ].join(" ");
}

function buildFallbackSearchPlan(
  question: string,
  category: Exclude<Category, "auto">,
  fallbackTerms: string[],
  reason_ko: string
): SearchPlan {
  // This path is deliberately narrow. When the planner is temporarily
  // unavailable, returning every paper from a category is worse than saying
  // that the exact subject could not be verified. The vocabulary is generated
  // upstream from the current question; no per-subject answer template is used.
  const intent = buildGenericFallbackIntent(question, fallbackTerms);
  return {
    category,
    queryTerms: mergeQueryTerms([
      ...intent.exposureTerms,
      ...intent.preferredStudyDesigns
    ], fallbackTerms),
    searchQueries: buildIntentSearchQueries(intent),
    intent,
    plannedBy: "fallback",
    reason_ko
  };
}

/**
 * A broad consumer-food question such as "is X bad for you?" is not the same
 * as an event-specific adverse-effect question. If the planner labels it as
 * safety, an exact adverse-event gate can discard every diet cohort and
 * evidence synthesis even when substantial topic evidence was retrieved.
 * Preserve strict safety filtering for medicines and explicitly named side
 * effects, but convert only topic-wide nutrition questions to an overview
 * intent so the result can transparently show the whole evidence base.
 */
export function normalizeTopicWideFoodSafetyPlan(question: string, plan: SearchPlan): SearchPlan {
  const intent = plan.intent;
  if (!intent ||
    plan.category !== "nutrition" ||
    intent.questionType !== "safety" ||
    !isBroadTopicQuestion(question) ||
    hasExplicitMedicalSafetyRequest(question)) {
    return plan;
  }

  const topicWideIntent: ResearchIntent = {
    ...intent,
    questionType: "other",
    outcomeTerms: [],
    directEvidenceGroups: [intent.exposureTerms],
    // Preserve a valid exact-item/parent evidence ladder when the planner
    // supplied one. A broad consumer-food question is not an adverse-event
    // lookup, but it may still need a transparent parent nutrient bridge.
    evidenceStrategy: (intent.directContextTerms?.length || intent.parentEvidenceTerms?.length || intent.contextualEvidenceTerms?.length)
      ? "direct_then_contextual"
      : "direct_only"
  };
  const queryTerms = mergeQueryTerms([
    ...topicWideIntent.exposureTerms,
    ...topicWideIntent.preferredStudyDesigns,
    ...(topicWideIntent.contextualEvidenceTerms ?? []),
    ...(topicWideIntent.directContextTerms ?? []),
    ...(topicWideIntent.parentEvidenceTerms ?? [])
  ], []);
  return {
    ...plan,
    intent: topicWideIntent,
    queryTerms,
    searchQueries: buildIntentSearchQueries(topicWideIntent),
    reason_ko: `${plan.reason_ko ?? ""} 넓은 식품 주제 질문으로 근거 범위를 재정렬했습니다.`.trim()
  };
}

/**
 * Broad nutrition questions are where a literal item search often produces
 * food-science records instead of human health evidence. Request a one-time
 * plan repair when there is no explicit exact-item health route or no
 * outcome-linked parent route to widen the search transparently.
 */
export function needsBroadNutritionEvidenceLadder(question: string, plan: SearchPlan): boolean {
  const intent = plan.intent;
  if (!intent ||
    plan.category !== "nutrition" ||
    !isBroadTopicQuestion(question) ||
    intent.questionType !== "other") {
    return false;
  }
  const hasExactItemHealthRoute = (intent.contextualEvidenceTerms?.length ?? 0) > 0 ||
    (intent.directContextTerms?.length ?? 0) > 0;
  const hasOutcomeLinkedParent = (intent.parentEvidenceTerms ?? []).some((term) =>
    /\b(?:cholesterol|lipid|blood pressure|cardiovascular|disease|mortality|cancer|glucose|weight|adverse|risk)\b/i.test(term)
  );
  return intent.evidenceStrategy !== "direct_then_contextual" ||
    !hasExactItemHealthRoute ||
    !hasOutcomeLinkedParent;
}

function hasExplicitMedicalSafetyRequest(question: string): boolean {
  return /(?:부작용|이상반응|side\s*effects?|adverse\s*(?:event|reaction)|독성|toxicity|상호작용|interaction|복용|처방|주사|약(?:물)?|drug|medication|medicine)/i.test(question);
}

function buildGenericFallbackIntent(question: string, fallbackTerms: string[]): ResearchIntent {
  const genericTerms = new Set([
    "health", "health benefits", "health outcomes", "clinical study", "observational study",
    "systematic review", "meta analysis", "review", "humans", "human", "adults",
    "children", "participants", "nutrition", "diet", "exercise", "psychology", "education"
  ]);
  const rawSubject = genericQuestionSubject(question);
  const exposureTerms = uniqueFallbackTerms([
    ...fallbackTerms,
    rawSubject
  ]).filter((term) => !genericTerms.has(term.toLowerCase())).slice(0, 5);
  const safeTerms = exposureTerms.length > 0 ? exposureTerms : [rawSubject];
  return {
    questionType: "other",
    exposure: safeTerms[0]!,
    exposureTerms: safeTerms,
    comparatorTerms: [],
    outcomeTerms: [],
    populationTerms: [],
    timeHorizon: "unspecified",
    preferredStudyDesigns: ["systematic review", "meta analysis"],
    directEvidenceGroups: [safeTerms],
    evidenceStrategy: "direct_only",
    contextualEvidenceTerms: []
  };
}

function uniqueFallbackTerms(terms: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return terms.flatMap((term) => {
    const normalized = term?.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length < 2) return [];
    const key = normalized.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function genericQuestionSubject(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim().replace(/[?!]+$/, "");
  const stripped = clean
    .replace(/(?:은|는|이|가|을|를|과|와|의)?\s*(?:몸에\s*)?(?:진짜\s*)?(?:좋(?:을까|아|은가)|나쁘(?:ㄹ까|다|지)|안\s*좋(?:을까|아|은가)|효과가\s*있(?:을까|어)|궁금(?:해|한데)?|알려(?:줘)?|어때|뭐야|사실(?:이야|인가)?|맞(?:아|나|는지)?)$/i, "")
    .trim();
  return stripped.length >= 2 ? stripped : clean;
}

function buildBroadTopicFallbackIntent(question: string, fallbackTerms: string[]): ResearchIntent | undefined {
  if (!isBroadTopicQuestion(question)) return undefined;
  const genericTerms = new Set([
    "health", "health benefits", "clinical study", "observational study", "systematic review", "meta analysis",
    "humans", "adults", "participants"
  ]);
  const explicitSubject = broadTopicSubject(question);
  // When the AI planner is unavailable, use known English scholarly terms
  // from the deterministic vocabulary before the Korean display label. This
  // keeps broad questions such as healthy-aging foods searchable across
  // PubMed rather than degrading to a literal Korean query.
  const englishFallbackTerms = fallbackTerms.filter((term) => /[a-z]/i.test(term));
  const exposureTerms = [...englishFallbackTerms, explicitSubject, ...fallbackTerms]
    .filter((term): term is string => Boolean(term))
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !genericTerms.has(term.toLowerCase()))
    .slice(0, 4);
  if (exposureTerms.length === 0) return undefined;
  return {
    questionType: "other",
    exposure: exposureTerms[0]!,
    exposureTerms,
    comparatorTerms: [],
    outcomeTerms: [],
    populationTerms: [],
    timeHorizon: "unspecified",
    preferredStudyDesigns: ["systematic review", "meta analysis"],
    directEvidenceGroups: [exposureTerms],
    evidenceStrategy: "direct_only",
    contextualEvidenceTerms: []
  };
}

function buildSingleExposureFallbackIntent(question: string, fallbackTerms: string[]): ResearchIntent | undefined {
  if (!asksForSingleExposure(question)) return undefined;
  const exposureTerms = singleExposureAnchorTerms(fallbackTerms);
  if (exposureTerms.length === 0) return undefined;
  const outcomeTerms = fallbackTerms
    .filter((term) => !exposureTerms.includes(term))
    .filter(isLikelyOutcomeTerm)
    .slice(0, 5);
  const exposure = `${exposureTerms[0]} alone`;
  return {
    questionType: "causal",
    exposure,
    exposureTerms,
    comparatorTerms: [],
    outcomeTerms,
    populationTerms: [],
    timeHorizon: "unspecified",
    preferredStudyDesigns: ["systematic review", "meta analysis", "randomized controlled trial"],
    directEvidenceGroups: outcomeTerms.length > 0 ? [exposureTerms, outcomeTerms] : [exposureTerms],
    evidenceStrategy: "direct_only",
    contextualEvidenceTerms: [
      [exposureTerms[0], outcomeTerms[0]].filter(Boolean).join(" ")
    ].filter(Boolean)
  };
}

function isLikelyOutcomeTerm(value: string): boolean {
  return /(?:weight loss|body weight|body fat|fat loss|body composition|blood pressure|hypertension|glucose|insulin|cholesterol|lipid|sleep|anxiety|depression|memory|learning|pain|injury|risk|adverse|mortality|disease|muscle mass|lean mass)/i.test(value);
}

function finalizeSearchPlan(plan: SearchPlan, fallbackTerms: string[]): SearchPlan {
  if (!plan.intent) return plan;
  const intent = enrichOutcomeVocabulary(plan.intent);
  const intentTerms = [
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms,
    ...intent.populationTerms,
    ...intent.preferredStudyDesigns,
    ...(intent.contextualEvidenceTerms ?? []),
    ...(intent.directContextTerms ?? []),
    ...(intent.parentEvidenceTerms ?? [])
  ];
  return {
    ...plan,
    intent,
    queryTerms: mergeQueryTerms(intentTerms, fallbackTerms),
    // Every stage consumes the same model-generated intent. This is a shape
    // check, not a topic-specific replacement of the user's subject.
    searchQueries: buildIntentSearchQueries(intent)
  };
}

/**
 * Search planners and paper abstracts often use different names for the same
 * measured endpoint: a question can ask about hypertension while a trial
 * reports blood pressure, or ask about palpitations while a review reports
 * heart rate and ECG changes. Expand only established endpoint equivalents;
 * this never adds a new disease, exposure, or conclusion to the question.
 */
export function enrichOutcomeVocabulary(intent: ResearchIntent): ResearchIntent {
  if (intent.outcomeTerms.length === 0) return intent;
  const aliases = new Set<string>();
  const add = (value: string): void => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean) aliases.add(clean);
  };
  for (const outcome of intent.outcomeTerms) {
    const text = outcome.toLowerCase();
    if (/\b(?:hypertension|blood pressure)\b/.test(text)) {
      add("hypertension");
      add("blood pressure");
    }
    if (/\b(?:arrhythmia|cardiac rhythm|heart rhythm|electrocardiogram|ecg|qtc?|qt interval)\b/.test(text)) {
      add("arrhythmia");
      add("electrocardiogram");
      add("QT interval");
    }
    if (/\b(?:palpitations?|tachycardia|heart rate)\b/.test(text)) {
      add("palpitations");
      add("tachycardia");
      add("heart rate");
    }
    if (/\b(?:insomnia|sleep disturbance|sleep quality)\b/.test(text)) {
      add("insomnia");
      add("sleep disturbance");
    }
    if (/\b(?:anxiety|jitteriness|nervousness|restlessness)\b/.test(text)) {
      add("anxiety");
      add("jitteriness");
    }
    if (/\b(?:nausea|vomiting|diarrh(?:ea|oea)?)\b/.test(text)) {
      add("nausea");
      add("vomiting");
      add("diarrhea");
    }
  }
  if (aliases.size === 0) return intent;
  const originalOutcomes = new Set(intent.outcomeTerms.map((term) => normalizeIntentTerm(term)));
  const outcomeTerms = [...new Set([...intent.outcomeTerms, ...aliases])].slice(0, 18);
  const directEvidenceGroups = (intent.directEvidenceGroups ?? []).map((group) => {
    const isOutcomeGroup = group.some((term) => originalOutcomes.has(normalizeIntentTerm(term)));
    return isOutcomeGroup ? [...new Set([...group, ...aliases])] : group;
  });
  return {
    ...intent,
    outcomeTerms,
    directEvidenceGroups
  };
}

function normalizeIntentTerm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function asksForSingleExposure(question: string): boolean {
  return /(?:만으로|단독(?:으로)?|혼자(?:서)?|\balone\b|\bonly\b|\bsolely\b|\bby itself\b)/i.test(question);
}

function singleExposureAnchorTerms(terms: string[]): string[] {
  const generic = new Set([
    "exercise", "physical activity", "health", "clinical study", "systematic review", "meta-analysis",
    "weight loss", "body weight", "body fat", "body composition", "adults", "children", "participants"
  ]);
  return terms.filter((term) => {
    const normalized = term.toLowerCase().replace(/\s+/g, " ").trim();
    return normalized.length >= 4 && !generic.has(normalized);
  });
}

function mergeQueryTerms(fallbackTerms: string[], plannedTerms: string[]): string[] {
  const terms = new Set<string>();
  for (const term of [...fallbackTerms, ...plannedTerms]) {
    const normalized = term.trim();
    if (normalized) terms.add(normalized);
  }
  return [...terms].slice(0, 20);
}

function relevanceTermsForIntent(intent: ResearchIntent | undefined, fallbackTerms: string[]): string[] {
  if (!intent) return fallbackTerms;
  const terms = new Set<string>();
  for (const term of [
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms,
    ...(intent.contextualEvidenceTerms ?? []),
    ...(intent.evidenceStrategy === "direct_then_contextual" ? intent.directContextTerms ?? [] : []),
    ...(intent.evidenceStrategy === "direct_then_contextual" ? intent.parentEvidenceTerms ?? [] : [])
  ]) {
    const clean = term.trim();
    if (clean) terms.add(clean);
  }
  return terms.size > 0 ? [...terms] : fallbackTerms;
}

function mergeSearchQueries(primary: string[], fallback: string[], limit: number): string[] {
  const queries = new Set<string>();
  for (const query of [...primary, ...fallback]) {
    const clean = query.replace(/\s+/g, " ").trim();
    if (clean) queries.add(clean);
    if (queries.size >= limit) break;
  }
  return [...queries];
}

function buildCrossrefIntentQuery(intent: ResearchIntent | undefined): string | undefined {
  if (!intent) return undefined;
  const exposure = intent.exposureTerms.find((term) => !/\d/.test(term)) ?? intent.exposureTerms[0];
  const outcome = intent.outcomeTerms[0];
  const query = [exposure, outcome].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return query || undefined;
}

function buildContextualIntentQuery(intent: ResearchIntent | undefined): string | undefined {
  if (!intent) return undefined;
  const terms = intent.contextualEvidenceTerms?.map((term) => term.trim()).filter(Boolean) ?? [];
  return terms.length > 0 ? terms.join(" ") : undefined;
}

function buildTopicOverviewQuery(question: string, intent: ResearchIntent | undefined): string | undefined {
  if (!intent || (!isBroadTopicQuestion(question) && !isBroadTopicIntent(intent))) return undefined;
  const directEvidence = intent.directEvidenceGroups
    ?.map((group) => {
      const terms = group.map((term) => term.trim()).filter(Boolean);
      if (terms.length === 0) return "";
      return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
    })
    .filter(Boolean)
    .join(" AND ");
  if (directEvidence) return `${directEvidence} (systematic review OR meta-analysis OR umbrella review)`;
  const exposure = intent.exposureTerms.find((term) => !/\d/.test(term)) ?? intent.exposureTerms[0];
  return exposure ? `${exposure} (systematic review OR meta-analysis OR umbrella review)` : undefined;
}

function buildBroadTopicReviewQuery(intent: ResearchIntent | undefined): string | undefined {
  if (!intent || !isBroadTopicIntent(intent)) return undefined;
  const terms = intent.exposureTerms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 3);
  if (terms.length === 0) return undefined;
  // Cross-source scholarly indexes often treat a mixed Korean/English boolean
  // query as a literal phrase. Prefer the planner's English canonical term
  // when present; the Korean term remains in the direct-evidence contract.
  const canonical = terms.find((term) => /[a-z]/i.test(term)) ?? terms[0]!;
  return `"${canonical.replace(/"/g, "")}" AND review`;
}

function isBroadTopicIntent(intent: ResearchIntent): boolean {
  return intent.questionType === "other" && intent.outcomeTerms.length === 0;
}

function withReportableResults(evidence: EvidenceSearchResult): EvidenceSearchResult {
  return {
    ...evidence,
    papers: evidence.papers.filter((paper) => Boolean(paper.abstract?.trim()))
  };
}

function toLoosePlannerQuery(query: string): string {
  return query
    .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
    .replace(/[()"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectSecondaryRapidFocusedQuery(queries: string[], primaryQuery: string): string {
  const primaryIndex = queries.indexOf(primaryQuery);
  return queries.slice(primaryIndex + 1).find((query) => query !== primaryQuery) ??
    queries.find((query) => query !== primaryQuery) ??
    primaryQuery;
}

function shouldKeepFallbackCategory(
  question: string,
  fallbackCategory: Exclude<Category, "auto">,
  plannedCategory: Exclude<Category, "auto">
): boolean {
  if (fallbackCategory === plannedCategory) return false;
  if (fallbackCategory !== "childcare") return false;
  return /(아기|영아|영유아|개월|돌|분유|이유식|편식|눈.?마주|눈맞춤|시선|자폐|발달지연|발달s*(?:문제|이상|검사|선별))/.test(question);
}

function filterPapersByQuery(papers: Paper[], query: string): Paper[] {
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].filter((token) => !queryStopwords.has(token));
  if (tokens.length === 0) return papers;
  return papers.filter((paper) => {
    const haystack = `${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}

function uniqueGroundingPapers(papers: Paper[]): Paper[] {
  const seenIdentifiers = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: Paper[] = [];
  for (const paper of papers) {
    const identifier = paper.doi?.trim().toLowerCase()
      || `${paper.source}:${paper.sourceId}`.toLowerCase()
      || "";
    const titleKey = paper.title.replace(/\s+/g, " ").trim().toLowerCase();
    if ((!identifier && !titleKey) || (identifier && seenIdentifiers.has(identifier)) || (titleKey && seenTitles.has(titleKey))) continue;
    if (identifier) seenIdentifiers.add(identifier);
    if (titleKey) seenTitles.add(titleKey);
    unique.push(paper);
  }
  return unique;
}

function selectGroundingCandidates(
  papers: Paper[],
  intent: ResearchIntent | undefined,
  limit: number
): Paper[] {
  const evidenceTier = (paper: Paper): number => {
    switch (paper.evidenceLevel) {
      case "systematic_review": return 0;
      case "clinical_study": return 1;
      case "observational_study": return 2;
      case "official_guidance": return 3;
      case "unknown": return 4;
      case "preprint": return 5;
    }
  };
  const directnessTier = (paper: Paper): number => {
    const role = intent ? classifyPaperForIntent(paper, intent) : "direct";
    return role === "direct" ? 0 : role === "contextual" ? 1 : 2;
  };
  const outcomeTokens = new Set((intent?.outcomeTerms ?? [])
    .flatMap((term) => term.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])
    .filter((term) => !groundedOutcomeStopwords.has(term)));
  const resultPotential = (paper: Paper): number => {
    const title = paper.title.toLowerCase();
    const abstract = paper.abstract?.toLowerCase() ?? "";
    const text = `${title} ${abstract}`;
    const outcomeHits = [...outcomeTokens].filter((token) => text.includes(token)).length;
    let score = Math.min(30, outcomeHits * 6);
    if (/\bresults?\b/.test(abstract)) score += 12;
    if (/\b(?:increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|higher|lower|greater|less|associated with|did not differ|no significant)\b/i.test(abstract)) score += 16;
    if (/\b\d+(?:[.,]\d+)?\s*(?:%|mmhg|bpm|mg|g|kg|ml|l|ci|rr|or|hr)\b/i.test(abstract)) score += 20;
    if (/\b(?:prevalence|consumption patterns?|motivations?|self-reported|physical performance|behavio(?:u)?ral correlates?|consumer attitudes?|public awareness|survey|questionnaire)\b/i.test(title)) score -= 120;
    if (/\b(?:alcohol|ethanol|alcoholic)\b/i.test(title) && !/\b(?:alcohol|ethanol|alcoholic)\b/i.test((intent?.exposureTerms ?? []).join(" "))) score -= 120;
    return score;
  };
  return papers
    .filter((paper) => !intent || classifyPaperForIntent(paper, intent) !== "reject")
    .map((paper, index) => ({ paper, index, resultPotential: resultPotential(paper) }))
    .sort((left, right) => {
      // A contextual systematic review is usually a better grounding
      // candidate than an unclassified single report. Directness still breaks
      // ties within the same evidence tier.
      const leftScore = evidenceTier(left.paper) * 100 + directnessTier(left.paper) * 40 - left.resultPotential;
      const rightScore = evidenceTier(right.paper) * 100 + directnessTier(right.paper) * 40 - right.resultPotential;
      return leftScore - rightScore || left.index - right.index;
    })
    .slice(0, limit)
    .map(({ paper }) => paper);
}

function groundingPaperKey(paper: Paper): string {
  return `${paper.source}:${paper.sourceId}`;
}

function groundedRepresentativeCount(papers: Paper[], intent: ResearchIntent | undefined): number {
  void intent;
  return papers.filter((paper) =>
    paper.evidenceLevel === "systematic_review" ||
    paper.evidenceLevel === "clinical_study" ||
    paper.evidenceLevel === "observational_study" ||
    paper.evidenceLevel === "official_guidance"
  ).length;
}

export function rankGroundedPapers(papers: Paper[], intent: ResearchIntent | undefined): Paper[] {
  const outcomeTokens = [...new Set((intent?.outcomeTerms ?? [])
    .flatMap((term) => term.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])
    .filter((term) => !groundedOutcomeStopwords.has(term)))];

  const score = (paper: Paper): number => {
    const sourceSentence = paper.groundedSourceSentence?.toLowerCase() ?? "";
    const finding = paper.groundedFindingKo ?? "";
    const text = `${paper.title} ${sourceSentence}`.toLowerCase();
    const broadTopic = Boolean(intent && isBroadTopicIntent(intent));
    const evidenceScore = broadTopic
      ? paper.evidenceLevel === "systematic_review"
        ? 180
        : paper.evidenceLevel === "clinical_study"
          ? 100
          : paper.evidenceLevel === "observational_study"
            ? 70
            : paper.evidenceLevel === "official_guidance"
              ? 60
              : 0
      : paper.evidenceLevel === "systematic_review"
        ? 60
        : paper.evidenceLevel === "clinical_study"
          ? 48
          : paper.evidenceLevel === "observational_study"
            ? 32
            : paper.evidenceLevel === "official_guidance"
              ? 28
              : 0;
    const role = intent ? classifyPaperForIntent(paper, intent) : "direct";
    let value = evidenceScore + (broadTopic
      ? role === "direct" ? 20 : role === "contextual" ? 0 : -100
      : role === "direct" ? 55 : role === "contextual" ? 15 : -100);

    const outcomeHits = outcomeTokens.filter((token) => sourceSentence.includes(token)).length;
    value += Math.min(24, outcomeHits * 6);
    if (/\b\d+(?:[.,]\d+)?\s*(?:%|mmhg|bpm|mg|g|kg|ml|l|ci|rr|or|hr)\b/i.test(sourceSentence)) value += 28;
    if (/\b(?:increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|lower(?:ed|s)?|higher|greater|less|more frequent|less frequent|associated with|linked to|did not differ|no (?:significant )?(?:difference|association|effect)|not significant|most common adverse events?)\b/i.test(sourceSentence)) value += 16;
    if (/[가-힣]/.test(finding) && finding.length >= 24) value += 5;

    // These records can be relevant background, but they do not answer a
    // factual outcome question as strongly as a measured endpoint. Keep them
    // only when the search cannot find stronger evidence.
    if (/\b(?:prevalence|consumption patterns?|motivations?|associated factors?|attitudes?|behavio(?:u)?rs?|cross-sectional|self-reported|public awareness|survey|questionnaire)\b/i.test(text)) value -= 65;
    if (/\b(?:is common|has become|growing public health|have increased in (?:the )?(?:past|last)|has increased in (?:the )?(?:past|last))\b/i.test(sourceSentence)) value -= 75;
    if (/\b(?:examined|explored|assessed|investigated|characteri[sz]ed)\b/i.test(sourceSentence)) value -= 40;
    if (broadTopic && /\b(?:cell line|cell culture|cultured cells?|in vitro|simulated digestion|gastrointestinal model|laboratory[- ]?based|laboratory study|bench study|physicochemical|focused on p\s*h)\b/i.test(text)) value -= 140;
    return value;
  };

  return papers
    .map(normalizeEvidenceLevel)
    .map((paper, index) => ({ paper, index, score: score(paper) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ paper }) => paper);
}

const groundedOutcomeStopwords = new Set([
  "acute", "events", "event", "adverse", "serious", "general", "people", "population",
  "health", "effects", "effect", "change", "changes", "safety", "risk", "risks"
]);

const queryStopwords = new Set([
  "review",
  "clinical",
  "trial",
  "cohort",
  "study",
  "studies",
  "health",
  "nutrition",
  "diet",
  "child",
  "infant",
  "toddler",
  "pediatric",
  "development",
  "physical",
  "activity",
  "exercise",
  "psychology",
  "mental"
]);

function ensureKoreanCoverage(rankedPapers: Paper[], allPapers: Paper[], relevanceTerms: string[], selectedLimit: number): Paper[] {
  const selected = rankedPapers.slice(0, selectedLimit);
  if (selected.some((paper) => paper.source === "kci" || paper.source === "riss")) return selected;

  // Ranking has already applied the full research-intent contract. Do not
  // inject a Korean-language item merely because it shares one loose token;
  // that can turn a food comparison into an unrelated plant-protein paper.
  const koreanPaper = rankedPapers.find((paper) => isRelevantKoreanPaper(paper, relevanceTerms));
  if (!koreanPaper) return selected;

  const head = selected.slice(0, 4);
  const tail = selected.slice(4).filter((paper) => paper.sourceId !== koreanPaper.sourceId);
  return [...head, koreanPaper, ...tail].slice(0, selectedLimit);
}

function isRelevantKoreanPaper(paper: Paper, relevanceTerms: string[]): boolean {
  if (paper.source !== "kci" && paper.source !== "riss") return false;
  const haystack = `${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`.toLowerCase();
  // Korean-source augmentation follows the same intent terms as every other
  // source. Never substitute a handwritten topic rule for the planner's
  // target, comparison, and outcome concepts.
  const tokens = [...new Set(relevanceTerms
    .flatMap((term) => term.toLowerCase().split(/[^a-z0-9가-힣]+/))
    .filter((token) => token.length >= 3)
  )];
  if (tokens.length === 0) return false;
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches >= Math.min(2, tokens.length);
}

function matchesComplexKoreanIntent(haystack: string, relevanceTerms: string[]): boolean | undefined {
  const joined = relevanceTerms.join(" ").toLowerCase();
  if (/creatine|크레아틴/.test(joined)) {
    return /(creatine|크레아틴)/.test(haystack);
  }
  if (/intermittent fasting|time-restricted eating|간헐적 단식|시간제한 식사/.test(joined) && /weight|body weight|체중|감량|비만/.test(joined)) {
    return /(intermittent fasting|time[- ]restricted eating|간헐적|단식|시간제한)/.test(haystack) && /(weight|body weight|weight loss|obesity|체중|감량|비만)/.test(haystack);
  }
  if (/sleep deprivation|sleep duration|short sleep|수면/.test(joined) && /weight|body weight|obesity|체중|비만/.test(joined)) {
    return /(sleep|수면|잠)/.test(haystack) && /(weight|body weight|weight gain|obesity|bmi|체중|비만|살)/.test(haystack);
  }
  if (/vitamin d|cholecalciferol|비타민 d|비타민d/.test(joined) && /respiratory|common cold|infection|감기|호흡기/.test(joined)) {
    return /(vitamin d|cholecalciferol|비타민\s?d)/.test(haystack) && /(respiratory|cold|infection|감기|호흡기|상기도)/.test(haystack);
  }
  if (/coffee|커피/.test(joined) && /blood pressure|hypertension|혈압|고혈압/.test(joined)) {
    return /(coffee|커피)/.test(haystack) && /(blood pressure|hypertension|혈압|고혈압)/.test(haystack);
  }
  if (/sweetener|aspartame|sucralose|diet soda|sugar-sweetened|감미료|제로 음료|제로/.test(joined)) {
    return /(sweetener|aspartame|sucralose|acesulfame|stevia|erythritol|diet soda|sugar[- ]sweetened|감미료|아스파탐|수크랄로스|스테비아|제로)/.test(haystack);
  }
  if (/protein|whey|단백질/.test(joined) && /kidney|renal|신장|콩팥/.test(joined)) {
    return /(protein|whey|단백질|고단백)/.test(haystack) && /(kidney|renal|신장|콩팥)/.test(haystack);
  }
  if (/fasted|fasting|공복/.test(joined) && /cardio|aerobic|유산소/.test(joined)) {
    return /(fasted|fasting|공복)/.test(haystack) && /(cardio|aerobic|exercise|유산소|운동)/.test(haystack);
  }
  return undefined;
}

async function searchKoreanSources(
  koreanQueries: string[],
  originalQuestion: string,
  limit: number,
  search: (query: string) => Promise<Paper[]>
): Promise<Paper[]> {
  const queries = koreanQueries.length > 0 ? koreanQueries : [originalQuestion];
  const results = await Promise.allSettled(queries.slice(0, 8).map((query) => search(query)));
  const papers = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (papers.length > 0) return papers.slice(0, Math.max(limit, 10) * 2);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
  if (errors.length > 0) throw new Error(errors.join("; "));
  return [];
}

async function searchQueryVariants(
  queries: string[],
  totalLimit: number,
  search: (query: string, limit: number) => Promise<Paper[]>
): Promise<Paper[]> {
  const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
  if (uniqueQueries.length === 0) return [];
  const perQueryLimit = Math.max(3, Math.ceil(totalLimit / uniqueQueries.length));
  // Exact, parent-topic, review, and comparison-side queries are independent.
  // Run them concurrently so wider retrieval does not turn into four serial
  // round trips for every database.
  const results = await Promise.allSettled(uniqueQueries.map((query) => search(query, perQueryLimit)));
  const papers = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));

  if (papers.length > 0) return dedupePapers(papers).slice(0, Math.max(totalLimit, 10) * 2);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return [];
}

/**
 * Only pair an ingredient with a word the reader can recognise from their own
 * question. RxNorm also resolves an already-generic mention onto itself, and
 * "티르제파타이드 = tirzepatide" explains nothing.
 */
function nonEmpty(glossary: GlossaryEntry[]): GlossaryEntry[] | undefined {
  return glossary.length > 0 ? glossary : undefined;
}

function buildMedicationGlossary(question: string): GlossaryEntry[] {
  return resolveKoreanBrandAliases(question)
    .map((alias) => ({ term: alias.ingredient, askedAs: alias.mention }));
}

/**
 * A retrieval is worth reusing only when it actually succeeded. A run that
 * returned nothing, or in which most sources missed the 2.4s window, describes
 * a transient outage rather than the literature.
 */
function isCacheableHostEvidence(evidence: EvidenceSearchResult): boolean {
  const fulfilled = evidence.sourceTraces.filter((trace) => trace.status === "fulfilled").length;
  return evidence.papers.length >= 3 && fulfilled >= 2 && fulfilled > evidence.sourceErrors.length;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pubMedSearchTimeoutMs(baseTimeoutMs: number): number {
  // A PubMed search consists of an ID request followed by an article fetch.
  // Variant queries share a provider queue to obey NCBI's rate limit, so the
  // provider needs a longer budget than independent sources.
  return Math.max(baseTimeoutMs, 14_000);
}

function sourceSearchTimeoutMs(source: SourceError["source"], baseTimeoutMs: number): number {
  return source === "pubmed" ? pubMedSearchTimeoutMs(baseTimeoutMs) : baseTimeoutMs;
}

function withFetchTimeout(fetchFn: typeof fetch, timeoutMs: number, label: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const upstreamSignal = init?.signal;
    if (upstreamSignal?.aborted) controller.abort();
    upstreamSignal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      return await Promise.race([
        fetchFn(input, { ...init, signal: controller.signal }),
        new Promise<Response>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

function dedupePapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  const deduped: Paper[] = [];
  for (const paper of papers) {
    const key = `${paper.doi ?? ""}|${paper.sourceId}|${paper.title}`.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }
  return deduped;
}


/**
 * RxNorm indexes medicines, so asking it about an everyday food returns the
 * nearest pharmaceutical product instead of nothing: "coffee" resolves to
 * "coffee bean allergenic extract", a skin-test reagent. That answer then
 * replaced the exposure, and "커피 하루 몇잔까지 괜찮음" searched for allergen
 * extracts and cited nothing.
 *
 * An ingredient may stand in for what the user asked about only when it names
 * the same thing. A product class that merely contains the word -- an extract,
 * an antigen, a vaccine -- is a different substance.
 */
function isPlausibleIngredientFor(ingredient: string, question: string, intent: ResearchIntent): boolean {
  if (/\b(?:allergenic|allergen|antigen|vaccine|toxoid|immunoglobulin|diagnostic|reagent|test kit)\b/i.test(ingredient)) {
    return false;
  }
  // A verified Korean brand is authoritative regardless of shape.
  if (resolveKoreanBrandAliases(question).some((alias) => alias.ingredient.toLowerCase() === ingredient.toLowerCase())) {
    return true;
  }
  // Otherwise the resolved name must be the subject itself, not the subject
  // used as a modifier of some other product.
  const head = ingredient.toLowerCase().match(/[a-z][a-z0-9-]*/g)?.at(-1) ?? "";
  const asked = [intent.exposure, ...intent.exposureTerms].join(" ").toLowerCase();
  return ingredient.split(/\s+/).length === 1 || (head.length > 2 && asked.includes(head));
}

/**
 * The planner transliterates a Korean brand it does not recognise, and guesses
 * differently on every call: "위고비" came back as "Wigobi", "Wigo-bi" and once
 * correctly as "Wegovy (semaglutide)"; "마운자로" as "Maunzaro", "Maun-za-ro"
 * and "MyunJaro". Only the correct spelling retrieves anything, so the same
 * question answered with five papers or with none depending on the guess.
 * Settle the naming from the verified table before retrieval runs.
 */
function applyKoreanBrandPlan(question: string, plan: SearchPlan): SearchPlan {
  const intent = plan.intent;
  const brands = resolveKoreanBrandAliases(question);
  if (!intent || brands.length === 0) return plan;

  const [first, second] = brands;
  const exposureTerms = first ? koreanBrandSearchTerms(first.mention) : [];
  const comparatorTerms = second ? koreanBrandSearchTerms(second.mention) : [];
  if (exposureTerms.length === 0) return plan;

  const isComparison = comparatorTerms.length > 0;
  return {
    ...plan,
    intent: {
      ...intent,
      questionType: isComparison ? "comparison" : intent.questionType,
      exposure: exposureTerms[0]!,
      exposureTerms,
      ...(isComparison ? { comparator: comparatorTerms[0]!, comparatorTerms } : {}),
      // The direct-evidence contract is rebuilt from the settled names too;
      // leaving the planner's invented spellings there would reject every
      // paper that the corrected search just retrieved.
      directEvidenceGroups: isComparison
        ? [exposureTerms, comparatorTerms]
        : [exposureTerms, ...(intent.outcomeTerms.length > 0 ? [intent.outcomeTerms] : [])]
    }
  };
}

/** Never logs the question itself, only why the planner could not resolve it. */
function logPlannerFailure(error: unknown): void {
  console.error(`[planner] fell back to rule-based search: ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactExactQuestionEcho<T>(value: T, question: string): T {
  const exact = question.trim();
  if (!exact) return value;
  if (typeof value === "string") return value.split(exact).join("이 질문") as T;
  if (Array.isArray(value)) return value.map((item) => redactExactQuestionEcho(item, exact)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactExactQuestionEcho(item, exact)])
  ) as T;
}

function traceMessage(source: SourceError["source"] | undefined, category: Exclude<Category, "auto">): string | undefined {
  if (source === "semantic_scholar") {
    return `최신 연도부터 1년씩 내려가며 검색. category=${category}에 맞는 fieldsOfStudy 필터 적용.`;
  }
  return undefined;
}
