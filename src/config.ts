export interface Config {
  port: number;
  databasePath: string;
  pubmedEmail?: string;
  pubmedApiKey?: string;
  semanticScholarApiKey?: string;
  coreApiKey?: string;
  contactEmail?: string;
  kciApiKey?: string;
  rissApiKey?: string;
  geminiApiKey?: string;
  geminiModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  /** Small model used only to turn a Korean MCP question into search terms. */
  openaiFastPlannerModel?: string;
  fetchTimeoutMs: number;
  geminiFetchTimeoutMs: number;
  openaiFetchTimeoutMs: number;
  rapidSearchTimeoutMs: number;
  strictLatencyMode: boolean;
  allowSkipCache: boolean;
  exposePopularClaims: boolean;
  exposeDiagnosticApis: boolean;
  exposeDiagnosticTools: boolean;
  maxQuestionLength: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  /** Shared MCP tool-call budget. Kakao Tools proxies all users through a few addresses, so this is an overload guard, not a per-user quota. */
  mcpRateLimitMaxRequests: number;
  /** Kakao Tools requires an average tool latency of 100ms. Set to 0 to force a live search on every MCP call. */
  hostEvidenceCacheTtlMs: number;
  /** A retrieval plan is a pure function of the question, but the planner is not deterministic. Set to 0 to re-plan every call. */
  searchPlanCacheTtlMs: number;
  mcpAllowedHosts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/kadera-malgo.sqlite",
    pubmedEmail: emptyToUndefined(env.PUBMED_EMAIL),
    pubmedApiKey: emptyToUndefined(env.PUBMED_API_KEY),
    semanticScholarApiKey: emptyToUndefined(env.SEMANTIC_SCHOLAR_API_KEY),
    coreApiKey: emptyToUndefined(env.CORE_API_KEY),
    contactEmail: emptyToUndefined(env.CONTACT_EMAIL ?? env.PUBMED_EMAIL),
    kciApiKey: emptyToUndefined(env.KCI_API_KEY),
    rissApiKey: emptyToUndefined(env.RISS_API_KEY),
    geminiApiKey: emptyToUndefined(env.GEMINI_API_KEY),
    geminiModel: emptyToUndefined(env.GEMINI_MODEL) ?? "gemini-2.5-flash-lite",
    openaiApiKey: emptyToUndefined(env.OPENAI_API_KEY),
    openaiModel: emptyToUndefined(env.OPENAI_MODEL) ?? "gpt-5-mini",
    openaiFastPlannerModel: emptyToUndefined(env.OPENAI_FAST_PLANNER_MODEL) ?? "gpt-5-nano",
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS ?? 8000),
    geminiFetchTimeoutMs: Number(env.GEMINI_FETCH_TIMEOUT_MS ?? 30000),
    openaiFetchTimeoutMs: Number(env.OPENAI_FETCH_TIMEOUT_MS ?? 90000),
    rapidSearchTimeoutMs: Number(env.RAPID_SEARCH_TIMEOUT_MS ?? 8000),
    strictLatencyMode: env.STRICT_LATENCY_MODE === "true",
    allowSkipCache: env.ALLOW_SKIP_CACHE === "true",
    exposePopularClaims: env.EXPOSE_POPULAR_CLAIMS === "true",
    exposeDiagnosticApis: env.EXPOSE_DIAGNOSTIC_APIS === "true",
    exposeDiagnosticTools: env.EXPOSE_DIAGNOSTIC_TOOLS === "true",
    maxQuestionLength: Number(env.MAX_QUESTION_LENGTH ?? 350),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMaxRequests: Number(env.RATE_LIMIT_MAX_REQUESTS ?? 8),
    mcpRateLimitMaxRequests: Number(env.MCP_RATE_LIMIT_MAX_REQUESTS ?? 600),
    hostEvidenceCacheTtlMs: Number(env.HOST_EVIDENCE_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000),
    searchPlanCacheTtlMs: Number(env.SEARCH_PLAN_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    mcpAllowedHosts: parseList(env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (!value || value.trim() === "") return undefined;
  return value.trim();
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
