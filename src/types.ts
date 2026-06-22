export const categories = [
  "auto",
  "health",
  "childcare",
  "education",
  "exercise",
  "nutrition",
  "psychology"
] as const;

export type Category = (typeof categories)[number];

export type Verdict =
  | "supported"
  | "mixed"
  | "not_supported"
  | "insufficient_evidence"
  | "safety_redirect";

export type EvidenceLevel =
  | "systematic_review"
  | "clinical_study"
  | "observational_study"
  | "preprint"
  | "official_guidance"
  | "unknown";

export type SourceName =
  | "pubmed"
  | "semantic_scholar"
  | "openalex"
  | "europe_pmc"
  | "core"
  | "cochrane_crossref"
  | "who_gho"
  | "cdc"
  | "myhealthfinder"
  | "arxiv"
  | "biorxiv"
  | "medrxiv"
  | "crossref"
  | "eric"
  | "psyarxiv"
  | "kci"
  | "riss";

export type CacheStatus = "temporary" | "promoted";

export interface Citation {
  source: SourceName;
  sourceId: string;
  title: string;
  authors: string[];
  venue?: string;
  publisher?: string;
  institutions?: string[];
  year?: number;
  doi?: string;
  url: string;
  evidenceLevel: EvidenceLevel;
}

export interface Paper extends Citation {
  abstract?: string;
  publicationTypes: string[];
  citationCount?: number;
  raw: unknown;
}

export interface SourceError {
  source: SourceName;
  message: string;
}

export interface SourceTrace {
  source: SourceName;
  status: "fulfilled" | "rejected";
  paperCount: number;
  message?: string;
}

export interface DataSourceStatus {
  source: SourceName;
  priority: 1 | 2 | 3 | "category" | "korea";
  implemented: boolean;
  enabled: boolean;
  requiresKey: boolean;
  keyEnv?: string;
  url: string;
  note: string;
}

export interface EvidenceSearchResult {
  category: Exclude<Category, "auto">;
  queryTerms: string[];
  papers: Paper[];
  sourceErrors: SourceError[];
  sourceTraces: SourceTrace[];
}

export interface ClaimAnswer {
  answer_ko: string;
  verdict: Verdict;
  evidence_level: EvidenceLevel;
  citations: Citation[];
  evidence_interpretation?: EvidenceInterpretation[];
  practical_checks?: PracticalCheck[];
  limitations: string[];
  safety_note: string;
  cached: boolean;
  category: Exclude<Category, "auto">;
  query_terms: string[];
}

export interface PracticalCheck {
  label: string;
  what_to_try_ko: string;
  what_to_watch_ko: string;
  why_it_matters_ko: string;
  urgency: "routine_observation" | "discuss_with_professional" | "seek_prompt_evaluation";
}

export type EvidenceStance = "supports" | "opposes" | "mixed" | "unclear";

export interface EvidenceInterpretation {
  citationIndex: number;
  source: SourceName;
  title: string;
  stance: EvidenceStance;
  reason_ko: string;
  evidenceLevel: EvidenceLevel;
}

export interface PopularClaim {
  normalized_topic: string;
  category: string;
  count: number;
  last_checked_at: string;
}
