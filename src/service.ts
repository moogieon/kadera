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
    const answer = this.postProcessAnswer(input.question, evidence.category, evidence, await this.synthesizeAnswer(input.question, evidence, fallbackAnswer));
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
    const answer = this.postProcessAnswer(input.question, evidence.category, evidence, await this.synthesizeAnswer(input.question, evidence, fallbackAnswer));
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

  private postProcessAnswer(
    question: string,
    category: Exclude<Category, "auto">,
    evidence: EvidenceSearchResult,
    answer: ClaimAnswer
  ): ClaimAnswer {
    const proteinDoseContext = buildProteinDoseContext(question);
    const sweetenerContext = buildSweetenerDrinkContext(question);
    const populationContext = buildPopulationContext(question, category);
    const studyDigest = buildStudyDigest(evidence.papers);
    const conditionGuide = buildConditionGuide(category);
    let answerKo = answer.answer_ko;
    if (proteinDoseContext && !answerKo.includes("50kg")) {
      answerKo = `${proteinDoseContext}\n\n근거 기반 상세 해석:\n${answerKo}`;
    }
    if (sweetenerContext && !answerKo.includes("감미료별로 보면")) {
      answerKo = `${sweetenerContext}\n\n근거 기반 상세 해석:\n${answerKo}`;
    }
    if (populationContext && !answerKo.includes("대상자별로 보면")) {
      answerKo = `${answerKo}\n\n${populationContext}`;
    }
    if (studyDigest && (!answerKo.includes("대표 연구를 뜯어보면") || !answerKo.includes("무엇을 했나"))) {
      answerKo = `${answerKo}\n\n${studyDigest}`;
    }
    if (conditionGuide && !answerKo.includes("더 정확히 보려면")) {
      answerKo = `${answerKo}\n\n${conditionGuide}`;
    }
    if (answerKo === answer.answer_ko) return answer;
    return {
      ...answer,
      answer_ko: answerKo
    };
  }
}

function buildConditionGuide(category: Exclude<Category, "auto">): string {
  if (category === "childcare") {
    return "더 정확히 보려면: 아이의 정확한 월령, 조산/교정월령 여부, 성별, 최근 수면·식사·질병 변화, 걱정되는 행동이 언제/얼마나 자주 나오는지, 가능하면 짧은 관찰 기록을 함께 적으면 분석이 더 명확해집니다.";
  }
  if (category === "education") {
    return "더 정확히 보려면: 나이/학년, 현재 수준, 목표 과목, 공부 시간, 수면, 적용하려는 방법, 비교하고 싶은 결과 지표를 적으면 분석이 더 명확해집니다.";
  }
  if (category === "psychology") {
    return "더 정확히 보려면: 나이, 성별, 증상 기간, 수면, 약 복용, 생활 기능 저하 여부, 위험 신호 여부를 적으면 분석이 더 명확해집니다. 자해나 극단적 선택 생각이 있으면 검색보다 즉시 주변 도움과 전문기관 연결이 우선입니다.";
  }
  if (category === "exercise") {
    return "더 정확히 보려면: 나이, 성별, 키/체중, 운동 경력, 주당 운동 횟수, 목표, 통증/부상 여부, 기저질환을 적으면 분석이 더 명확해집니다.";
  }
  if (category === "nutrition") {
    return "더 정확히 보려면: 나이, 성별, 키/체중, 임신·수유 여부, 운동량, 하루 섭취량, 제품 라벨, 당뇨·신장질환·고혈압 같은 기저질환, 복용약을 적으면 분석이 더 명확해집니다.";
  }
  return "더 정확히 보려면: 나이, 성별, 키/체중, 임신 여부, 기저질환, 복용약, 증상 기간, 실제 섭취량이나 노출량을 적으면 분석이 더 명확해집니다.";
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
    ? " 단백질 질문에서는 같은 100g도 55kg 여성에게는 1.82g/kg/day, 75kg 남성에게는 1.33g/kg/day라 해석이 달라집니다."
    : "";
  const sweetenerSpecific = /(제로|무설탕|탄산|콜라|사이다|감미료|아스파탐|수크랄로스|스테비아|에리스리톨|zero|diet soda|sweetener)/i.test(question)
    ? " 제로음료 질문에서는 성인보다 소아/임신부에서 카페인, 단맛 습관, 페닐알라닌 표시까지 같이 봐야 합니다."
    : "";

  return [
    `대상자별로 보면: 건강한 성인 남성/여성은 대체로 같은 근거 틀을 쓰되 체중, 체지방, 활동량 때문에 같은 양의 의미가 달라집니다.${proteinSpecific}${sweetenerSpecific}`,
    "성인 남성: 평균 체중과 근육량이 큰 편이라 같은 섭취량도 g/kg 기준으로 낮게 잡히는 경우가 많습니다. 운동량이 많으면 권장 범위가 올라갈 수 있습니다.",
    "성인 여성: 체중이 낮으면 같은 g 또는 같은 캔 수라도 체중 대비 노출량이 높습니다. 임신 가능성, 철분/칼슘, 카페인, 수유 여부를 같이 봐야 합니다.",
    "임신/수유: 체중조절, 보충제, 감미료, 카페인, 약물성 성분은 일반 성인 연구를 그대로 적용하지 말고 산부인과/의료진 기준을 우선합니다.",
    "소아/청소년: 성인 체중감량·대사 연구를 그대로 적용하지 않습니다. 성장, 수면, 식습관 형성, 카페인 노출을 먼저 봅니다.",
    "노인: 근감소, 신장 기능 저하, 복용약, 탈수 위험 때문에 같은 식단/보충제라도 부작용 쪽을 더 보수적으로 봅니다.",
    "기저질환자: 당뇨, 만성콩팥병, 간질환, 고혈압, 심혈관질환, 섭식장애 병력이 있으면 건강한 성인 연구의 결론을 그대로 적용하면 안 됩니다."
  ].join(" ");
}

function buildStudyDigest(papers: Paper[]): string | undefined {
  const usable = papers.filter((paper) => paper.title && (paper.abstract || paper.publicationTypes.length > 0)).slice(0, 3);
  if (usable.length === 0) return undefined;

  return [
    "대표 연구를 뜯어보면:",
    ...usable.map((paper, index) => {
      const citationIndex = index + 1;
      const design = studyDesignLabel(paper);
      const attribution = studyAttribution(paper);
      const what = inferWhatWasDone(paper);
      const result = inferResultSentence(paper);
      const limit = inferStudyLimit(paper);
      return `[${citationIndex}] ${attribution} "${paper.title}" - 연구 형태: ${design}. 무엇을 했나: ${what} 결과: ${result} 적용 한계: ${limit}`;
    })
  ].join("\n");
}

function studyAttribution(paper: Paper): string {
  const year = paper.year ? `${paper.year}년 ` : "";
  const team = researchTeamLabel(paper);
  const venue = paper.venue ? `${paper.venue}에 실린 ` : "";
  const institution = paper.institutions?.[0] ? ` 기관/소속: ${paper.institutions.slice(0, 2).join(", ")}.` : "";
  const publisher = !paper.venue && paper.publisher ? ` 발행/제공: ${paper.publisher}.` : "";
  const database = ` 출처 DB: ${sourceLabel(paper.source)}.`;
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
  const abstract = cleanAbstract(paper.abstract);
  if (!abstract) return "초록이 없어 제목과 서지정보 기준으로만 판단했습니다.";
  const first = splitSentences(abstract)[0];
  return first ? trimSentence(first, 220) : "초록의 연구 목적/방법 문장을 기준으로 판단했습니다.";
}

function inferResultSentence(paper: Paper): string {
  const abstract = cleanAbstract(paper.abstract);
  if (!abstract) return "초록 결과가 없어 효과 크기나 방향은 원문 확인이 필요합니다.";
  const sentences = splitSentences(abstract);
  const result = sentences.find((sentence) =>
    /(result|found|showed|associated|increased|decreased|reduced|improved|effect|significant|no significant|risk|outcome|conclusion|결과|증가|감소|개선|연관|유의)/i.test(sentence)
  );
  return trimSentence(result ?? sentences[Math.min(1, sentences.length - 1)] ?? abstract, 260);
}

function inferStudyLimit(paper: Paper): string {
  switch (paper.evidenceLevel) {
    case "systematic_review":
      return "여러 연구를 모은 근거라 방향성 판단에는 강하지만, 포함된 연구들의 대상자/기간/측정법 차이를 같이 봐야 합니다.";
    case "clinical_study":
      return "개입 효과를 보기 좋지만 표본, 기간, 비교군 조건이 내 상황과 맞는지 확인해야 합니다.";
    case "observational_study":
      return "장기 현실 데이터를 볼 수 있지만 원인-결과를 단정하기 어렵습니다.";
    case "preprint":
      return "정식 동료심사 전 자료라 신뢰도를 한 단계 낮춰 봐야 합니다.";
    case "official_guidance":
      return "개별 논문 하나보다 보수적 권고에 가깝지만 개인 진단을 대신하지는 않습니다.";
    default:
      return "제목/초록 중심 근거라 원문에서 대상자와 결과 수치를 확인해야 합니다.";
  }
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

function buildSweetenerDrinkContext(question: string): string | undefined {
  if (!/(제로|무설탕|탄산|콜라|사이다|감미료|아스파탐|수크랄로스|스테비아|에리스리톨|zero|diet soda|sweetener|aspartame|sucralose)/i.test(question)) {
    return undefined;
  }

  return [
    "판정: 제로 탄산이 일반 설탕 탄산보다 '무조건 더 나쁘다'는 주장은 근거가 약합니다. 당류와 칼로리를 줄이는 목적이면 설탕 탄산보다 유리할 수 있습니다. 다만 '제로니까 물처럼 마음껏 마셔도 완벽하게 안전하다'도 과장입니다.",
    "누가 맞나: 설탕 탄산을 매일 많이 마시는 사람에게 제로로 바꾸는 것은 당류/칼로리 감소 측면에서 이득이 있습니다. 하지만 체중조절이나 대사질환 예방을 제로음료에 기대하는 것은 약합니다. WHO는 2023년 비당류 감미료를 장기 체중조절 수단으로 쓰지 말라고 권고했습니다.",
    "연구가 실제로 한 일: 체계적 문헌고찰/가이드라인은 무작위시험과 관찰연구를 모아 체중, 당뇨, 심혈관질환, 사망률 같은 결과를 봅니다. 무작위시험은 단기 체중/칼로리 변화에는 도움이 될 수 있지만 기간이 짧은 경우가 많고, 관찰연구는 장기 위험 신호를 보지만 '제로를 마셔서 병이 생겼다'를 바로 증명하지는 못합니다. 장내미생물/혈당 연구는 일부 감미료가 사람마다 다른 포도당 반응을 만들 수 있음을 보지만, 표본이 작거나 기전 연구인 경우가 많습니다.",
    "감미료별로 보면: 아스파탐은 코카콜라 제로, 다이어트 콜라, 펩시맥스/펩시 제로 같은 콜라류에 흔히 쓰이며, IARC는 2023년 '인체 발암 가능성 2B'로 분류했지만 JECFA는 일일섭취허용량 40mg/kg/day를 유지했습니다. 아세설팜칼륨/Ace-K는 아스파탐과 섞여 코카콜라 제로, 펩시맥스류에 흔합니다. 수크랄로스는 일부 제로 음료, 에너지드링크, 단백질음료에 들어가며 장내미생물/대사 영향 논쟁이 있습니다. 에리스리톨은 탄산콜라보다 제로 디저트/단백질바/무설탕 간식에 더 흔하고, 심혈관 위험 신호 연구가 있어 과량 섭취는 조심해서 봅니다. 스테비아는 일부 제로/저당 음료에 쓰이고 보통 다른 감미료와 블렌딩됩니다.",
    "성분/제품 라벨에서 볼 것: 제품명보다 원재료명을 봐야 합니다. '아스파탐', '아세설팜칼륨', '수크랄로스', '스테비올배당체/스테비아', '에리스리톨', '알룰로스'를 확인하세요. 브랜드 배합은 국가와 리뉴얼 시점에 따라 바뀌므로 코카콜라 제로/펩시 제로/칠성사이다 제로/스프라이트 제로 같은 이름만 보고 판단하면 틀릴 수 있습니다.",
    "내가 확인할 것: 하루 몇 캔인지, 설탕 탄산을 대체한 것인지 아니면 물 대신 추가로 마시는 것인지, 카페인까지 같이 늘었는지, 복부팽만/설사/단맛 갈망이 생기는지, 당뇨나 혈당 측정 이슈가 있는지를 봐야 합니다."
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
