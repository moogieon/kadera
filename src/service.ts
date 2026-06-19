import type { Config } from "./config.js";
import { ClaimCache } from "./cache.js";
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
import { GeminiRagClient, type SearchPlan } from "./clients/gemini.js";
import { composeAnswer } from "./answer.js";
import { rankPapers } from "./evidence.js";
import { screenSafety, standardSafetyNote } from "./safety.js";
import { buildQueryTerms, buildSearchQuery, classifyCategory, normalizeQuestion } from "./text.js";
import type { Category, ClaimAnswer, DataSourceStatus, EvidenceSearchResult, Paper, PopularClaim, SourceError, SourceTrace } from "./types.js";

export interface CheckClaimInput {
  question: string;
  category?: Category;
  audience?: string;
  limit?: number;
  skipCache?: boolean;
}

export interface FindEvidenceInput {
  question: string;
  category?: Category;
  limit?: number;
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
  private readonly gemini: GeminiRagClient;

  constructor(private readonly config: Config, fetchFn: typeof fetch = fetch) {
    this.cache = new ClaimCache(config.databasePath);
    this.pubMed = new PubMedClient(config, fetchFn);
    this.semanticScholar = new SemanticScholarClient(config, fetchFn);
    this.openAlex = new OpenAlexClient(config, fetchFn);
    this.europePmc = new EuropePmcClient(fetchFn);
    this.crossref = new CrossrefClient(config, fetchFn);
    this.eric = new EricClient(fetchFn);
    this.arxiv = new ArxivClient(fetchFn);
    this.myHealthfinder = new MyHealthfinderClient(fetchFn);
    this.core = new CoreClient(config, fetchFn);
    this.biorxiv = new PreprintClient("biorxiv", fetchFn);
    this.medrxiv = new PreprintClient("medrxiv", fetchFn);
    this.whoGho = new WhoGhoClient(fetchFn);
    this.cdc = new CdcClient(fetchFn);
    this.kci = new KciClient(config, fetchFn);
    this.riss = new RissClient(config, fetchFn);
    this.osfPreprints = new OsfPreprintsClient(fetchFn);
    this.gemini = new GeminiRagClient(config, fetchFn);
  }

  async checkClaim(input: CheckClaimInput): Promise<ClaimAnswer> {
    const normalizedQuestion = normalizeQuestion(input.question);
    const safety = screenSafety(input.question);
    const category = classifyCategory(input.question, input.category ?? "auto");

    if (safety.redirect) {
      return {
        answer_ko: safety.answer ?? "전문가 상담이 필요한 질문입니다.",
        verdict: "safety_redirect",
        evidence_level: "unknown",
        citations: [],
        limitations: ["응급, 처방, 진단 영역은 연구 검색 답변보다 전문가 상담이 우선입니다."],
        safety_note: standardSafetyNote,
        cached: false,
        category,
        query_terms: []
      };
    }

    const cached = input.skipCache ? undefined : this.cache.get(normalizedQuestion);
    if (cached) return cached;

    const evidence = await this.findEvidence({
      question: input.question,
      category,
      limit: input.limit
    });
    const fallbackAnswer = composeAnswer(input.question, evidence, false);
    const answer = this.postProcessAnswer(input.question, await this.synthesizeAnswer(input.question, evidence, fallbackAnswer));
    if (!input.skipCache) this.cache.save(normalizedQuestion, answer);
    return answer;
  }

  async findEvidence(input: FindEvidenceInput): Promise<EvidenceSearchResult> {
    const fallbackCategory = classifyCategory(input.question, input.category ?? "auto");
    const fallbackQueryTerms = buildQueryTerms(input.question, fallbackCategory);
    const searchPlan = await this.planSearch(input.question, fallbackCategory, fallbackQueryTerms);
    const category = searchPlan.category;
    const queryTerms = searchPlan.queryTerms;
    const query = buildSearchQuery(queryTerms, category);
    const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
    const sourceLimit = Math.max(limit, Math.min(25, limit * 5));
    const selectedLimit = Math.max(limit * 2, 10);
    const sourceErrors: SourceError[] = [];
    const sourceTraces: SourceTrace[] = [];
    const papers: Paper[] = [];

    const jobs = this.searchJobs(category, query, input.question, sourceLimit);
    const results = await Promise.allSettled(jobs.map((job) => job.run()));

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

    return {
      category,
      queryTerms,
      papers: rankPapers(papers, queryTerms).slice(0, selectedLimit),
      sourceErrors,
      sourceTraces
    };
  }

  async checkClaimWithTrace(input: CheckClaimInput): Promise<{ evidence: EvidenceSearchResult; answer: ClaimAnswer }> {
    const safety = screenSafety(input.question);
    const category = classifyCategory(input.question, input.category ?? "auto");

    if (safety.redirect) {
      const evidence: EvidenceSearchResult = {
        category,
        queryTerms: [],
        papers: [],
        sourceErrors: [],
        sourceTraces: []
      };
      return {
        evidence,
        answer: {
          answer_ko: safety.answer ?? "전문가 상담이 필요한 질문입니다.",
          verdict: "safety_redirect",
          evidence_level: "unknown",
          citations: [],
          limitations: ["응급, 처방, 진단 영역은 연구 검색 답변보다 전문가 상담이 우선입니다."],
          safety_note: standardSafetyNote,
          cached: false,
          category,
          query_terms: []
        }
      };
    }

    const evidence = await this.findEvidence(input);
    const fallbackAnswer = composeAnswer(input.question, evidence, false);
    const answer = this.postProcessAnswer(input.question, await this.synthesizeAnswer(input.question, evidence, fallbackAnswer));
    return { evidence, answer };
  }

  popularClaims(category: string | undefined, limit = 20): PopularClaim[] {
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
        enabled: true,
        requiresKey: false,
        keyEnv: "SEMANTIC_SCHOLAR_API_KEY",
        url: "https://api.semanticscholar.org/api-docs/graph",
        note: "키 없이 가능하지만 live smoke에서 429가 발생했으므로 배포 전 키 권장."
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
    return {
      llm: {
        provider: "gemini",
        enabled: this.gemini.enabled,
        model: this.config.geminiModel,
        fallback: "rule_based_evidence_synthesis"
      },
      cache: {
        databasePath: this.config.databasePath
      }
    };
  }

  close(): void {
    this.cache.close();
  }

  private searchJobs(category: Exclude<Category, "auto">, query: string, originalQuestion: string, limit: number): Array<{ source: SourceError["source"]; run: () => Promise<Paper[]> }> {
    const jobs: Array<{ source: SourceError["source"]; run: () => Promise<Paper[]> }> = [
      { source: "semantic_scholar", run: () => this.semanticScholar.search(query, limit, category) },
      { source: "openalex", run: () => this.openAlex.search(query, limit) },
      { source: "crossref", run: () => this.crossref.search(query, limit) }
    ];

    if (["health", "childcare", "nutrition", "exercise", "psychology"].includes(category)) {
      jobs.unshift(
        { source: "pubmed", run: () => this.pubMed.search(query, limit) },
        { source: "europe_pmc", run: () => this.europePmc.search(query, limit) },
        { source: "cochrane_crossref", run: () => this.crossref.search(query, limit, true) }
      );
    }
    if (category === "education") {
      jobs.unshift({ source: "eric", run: () => this.eric.search(query, limit) });
    }
    if (["health", "nutrition", "childcare"].includes(category)) {
      jobs.push({ source: "myhealthfinder", run: () => this.myHealthfinder.search(query, Math.min(limit, 3)) });
      jobs.push({ source: "who_gho", run: () => this.whoGho.search(query, Math.min(limit, 3)) });
      jobs.push({ source: "cdc", run: () => this.cdc.search(query, Math.min(limit, 3)) });
    }
    if (this.core.enabled) {
      jobs.push({ source: "core", run: () => this.core.search(query, limit) });
    }
    if (["education", "psychology", "exercise", "nutrition"].includes(category)) {
      jobs.push({ source: "arxiv", run: () => this.arxiv.search(query, Math.min(limit, 3)) });
    }
    if (category === "psychology") {
      jobs.push({ source: "psyarxiv", run: () => this.osfPreprints.searchPsyArxiv(query, Math.min(limit, 3)) });
    }
    if (category === "health") {
      jobs.push(
        { source: "biorxiv", run: () => this.biorxiv.recent(Math.min(limit, 3)) },
        { source: "medrxiv", run: () => this.medrxiv.recent(Math.min(limit, 3)) }
      );
    }
    if (this.kci.enabled) {
      jobs.push({ source: "kci", run: () => this.kci.search(originalQuestion, limit) });
    }
    if (this.riss.enabled) {
      jobs.push({ source: "riss", run: () => this.riss.search(originalQuestion, limit) });
    }

    return jobs;
  }

  private async synthesizeAnswer(question: string, evidence: EvidenceSearchResult, fallbackAnswer: ClaimAnswer): Promise<ClaimAnswer> {
    if (!this.gemini.enabled) return fallbackAnswer;
    try {
      return await this.gemini.synthesizeClaim(question, evidence, fallbackAnswer);
    } catch (error) {
      return {
        ...fallbackAnswer,
        limitations: [
          ...fallbackAnswer.limitations,
          `AI 합성 단계가 실패해 규칙 기반 근거 해석으로 답변했습니다: ${errorMessage(error)}`
        ]
      };
    }
  }

  private async planSearch(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackQueryTerms: string[]
  ): Promise<SearchPlan> {
    if (!this.gemini.enabled) {
      return { category: fallbackCategory, queryTerms: fallbackQueryTerms, reason_ko: "Gemini key 없음. 규칙 기반 검색어 사용." };
    }
    try {
      const plan = await this.gemini.planSearch(question, fallbackCategory, fallbackQueryTerms);
      return {
        ...plan,
        category: shouldKeepFallbackCategory(question, fallbackCategory, plan.category) ? fallbackCategory : plan.category,
        queryTerms: mergeQueryTerms(fallbackQueryTerms, plan.queryTerms)
      };
    } catch {
      return { category: fallbackCategory, queryTerms: fallbackQueryTerms, reason_ko: "Gemini 검색 계획 실패. 규칙 기반 검색어 사용." };
    }
  }

  private postProcessAnswer(question: string, answer: ClaimAnswer): ClaimAnswer {
    const proteinDoseContext = buildProteinDoseContext(question);
    if (!proteinDoseContext || answer.answer_ko.includes("50kg")) return answer;
    return {
      ...answer,
      answer_ko: `${proteinDoseContext}\n\n근거 기반 상세 해석:\n${answer.answer_ko}`
    };
  }
}

function buildProteinDoseContext(question: string): string | undefined {
  if (!/(단백질|프로틴|파우더|보충제|whey|protein)/i.test(question)) return undefined;
  const amount = question.match(/(\d{2,3})\s*(?:g|그램)?/i)?.[1];
  if (!amount) return undefined;
  const grams = Number(amount);
  if (!Number.isFinite(grams) || grams <= 0) return undefined;

  const examples = [50, 55, 60, 70, 75, 80, 90].map((kg) => `${kg}kg=${(grams / kg).toFixed(2)}g/kg/day`);
  const female55 = grams / 55;
  const male75 = grams / 75;
  const male75Target = Math.round(75 * 1.6);
  return [
    `판정: 하루 총 단백질이 ${grams}g이라는 뜻이면, 70-80kg 건강한 성인이 근력운동을 하는 상황에서는 "너무 많이 먹어서 위험하다" 쪽보다 "흔한 근성장 범위 안"에 가깝습니다. 반대로 50-55kg이거나 운동을 거의 안 하면 높은 편이고, 추가 이득은 작아질 수 있습니다.`,
    `누가 맞나: "단백질은 몸무게 x 일정량을 먹어야 근성장에 유리하다"는 주장은 대체로 근거가 있습니다. "파우더라서 신장에 무조건 나쁘다"는 주장은 건강한 성인 기준으로는 과장입니다. "신장질환, 단백뇨, eGFR 저하, 당뇨, 고혈압이 있으면 조심해야 한다"는 주장은 맞습니다. "단백질 파우더가 탈모를 일으킨다"는 주장은 이 검색 근거만으로는 단정할 근거가 약합니다.`,
    `숫자로 보면 ${grams}g은 ${examples.join(", ")}입니다.`,
    `성인 예시: 55kg 성인 여성 기준 ${grams}g은 ${female55.toFixed(2)}g/kg/day라서 1.4-2.0g/kg/day 범위 안의 높은 쪽입니다. 75kg 성인 남성 기준 ${grams}g은 ${male75.toFixed(2)}g/kg/day이고, 1.6g/kg/day 기준 목표량은 약 ${male75Target}g/day입니다.`,
    "논문/연구가 실제로 말하는 것: 단백질 보충은 저항운동을 같이 할 때 제지방량과 근력 증가에 도움이 되는 방향의 근거가 많습니다. 다만 약 1.6g/kg/day 이후에는 추가 근육 증가 이득이 작아지는 메타분석 결과가 반복되므로, 많이 먹을수록 계속 더 커진다는 뜻은 아닙니다.",
    "신장 해석: 건강한 성인 운동자에게 단기간 고단백 섭취가 곧바로 신장을 망가뜨린다고 단정하기는 어렵습니다. 하지만 만성콩팥병, 단백뇨, eGFR 저하, 당뇨, 고혈압이 있으면 건강한 운동자 연구를 그대로 적용하면 안 됩니다.",
    "틀리기 쉬운 포인트: 파우더 100g은 실제 단백질 100g이 아닐 수 있습니다. 제품 라벨의 단백질 g, 닭가슴살/계란/우유 등 식사 단백질, 하루 총량을 합쳐서 계산해야 합니다.",
    "내가 확인할 것: 체중, 주당 저항운동 횟수, 하루 총 단백질 g, 제품 1스쿱의 실제 단백질 g, eGFR/크레아티닌/단백뇨 여부를 보면 이 논쟁은 훨씬 명확해집니다."
  ].join(" ");
}

function mergeQueryTerms(fallbackTerms: string[], plannedTerms: string[]): string[] {
  const terms = new Set<string>();
  for (const term of [...fallbackTerms, ...plannedTerms]) {
    const normalized = term.trim();
    if (normalized) terms.add(normalized);
  }
  return [...terms].slice(0, 20);
}

function shouldKeepFallbackCategory(
  question: string,
  fallbackCategory: Exclude<Category, "auto">,
  plannedCategory: Exclude<Category, "auto">
): boolean {
  if (fallbackCategory === plannedCategory) return false;
  if (fallbackCategory !== "childcare") return false;
  return /(아이|아기|영아|유아|개월|눈.?마주|눈맞춤|시선|자폐|발달)/.test(question);
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function traceMessage(source: SourceError["source"] | undefined, category: Exclude<Category, "auto">): string | undefined {
  if (source === "semantic_scholar") {
    return `최신 연도부터 1년씩 내려가며 검색. category=${category}에 맞는 fieldsOfStudy 필터 적용.`;
  }
  return undefined;
}
