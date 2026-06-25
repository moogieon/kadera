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
  fetchTimeoutMs: number;
  geminiFetchTimeoutMs: number;
  allowSkipCache: boolean;
  exposePopularClaims: boolean;
  maxQuestionLength: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
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
    geminiModel: emptyToUndefined(env.GEMINI_MODEL) ?? "gemini-3.1-flash-lite",
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS ?? 8000),
    geminiFetchTimeoutMs: Number(env.GEMINI_FETCH_TIMEOUT_MS ?? 30000),
    allowSkipCache: env.ALLOW_SKIP_CACHE === "true",
    exposePopularClaims: env.EXPOSE_POPULAR_CLAIMS === "true",
    maxQuestionLength: Number(env.MAX_QUESTION_LENGTH ?? 500),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMaxRequests: Number(env.RATE_LIMIT_MAX_REQUESTS ?? 30)
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (!value || value.trim() === "") return undefined;
  return value.trim();
}
