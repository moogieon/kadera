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

export type ClaimDirection = "benefit" | "harm" | "association" | "unclear";

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
  abstract_excerpt?: string;
}

export interface Paper extends Citation {
  abstract?: string;
  publicationTypes: string[];
  citationCount?: number;
  /** Korean finding extracted only from a validated result sentence in this paper's abstract. */
  groundedFindingKo?: string;
  /** The same finding compressed to one scannable clause for the at-a-glance table. */
  groundedHeadlineKo?: string;
  /** Internal provenance for groundedFindingKo. Never rendered verbatim. */
  groundedSourceSentence?: string;
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

/** A technical term used in the answer, paired with the everyday word the user asked with. */
export interface GlossaryEntry {
  /** The scholarly term the papers and the answer use, e.g. "tirzepatide". */
  term: string;
  /** The term the user actually wrote, e.g. "마운자로". */
  askedAs: string;
}

export interface EvidenceSearchResult {
  category: Exclude<Category, "auto">;
  queryTerms: string[];
  researchIntent?: ResearchIntent;
  /** Whether comparison citations directly compare both options or describe each option separately. */
  comparisonEvidenceScope?: "direct" | "parallel";
  /** Whether the papers answer the exact condition or the closest broader scholarly question. */
  evidenceDirectness?: "direct" | "contextual";
  claimDirection?: ClaimDirection;
  searchPlannedBy?: "host" | "gemini" | "openai" | "fallback";
  /** Abstract-bearing papers found before representative evidence is selected. */
  retrievedPaperCount?: number;
  /** Canonical topic labels supplied by the host for the fast MCP evidence package. */
  hostTopicTerms?: string[];
  /** Broader, explicitly labelled parent exposures supplied by the host for fast MCP context evidence. */
  hostParentTerms?: string[];
  /** Outcome labels supplied by the host for the fast MCP evidence package. */
  hostOutcomeTerms?: string[];
  /** Whether this retrieval was served from the host evidence cache. Kakao Tools requires an average tool latency of 100ms. */
  evidenceCacheHit?: boolean;
  /** Brand-to-ingredient pairs resolved while planning, so the answer can explain its own vocabulary. */
  glossary?: GlossaryEntry[];
  papers: Paper[];
  sourceErrors: SourceError[];
  sourceTraces: SourceTrace[];
}

export interface ResearchIntent {
  questionType: "comparison" | "causal" | "association" | "dosage" | "safety" | "diagnostic" | "other";
  exposure: string;
  exposureTerms: string[];
  comparator?: string;
  comparatorTerms: string[];
  outcomeTerms: string[];
  populationTerms: string[];
  timeHorizon: "acute" | "short_term" | "long_term" | "mixed" | "unspecified";
  preferredStudyDesigns: string[];
  /** Model-generated concept groups that every direct paper must satisfy. */
  directEvidenceGroups?: string[][];
  /**
   * Some named foods or consumer products have little direct human outcome
   * research. In that case the planner may request a transparent evidence
   * ladder: exact-item characterization first, then broader parent evidence.
   */
  evidenceStrategy?: "direct_only" | "direct_then_contextual";
  /** Closest scholarly questions that preserve the topic while relaxing a narrow user condition. */
  contextualEvidenceTerms?: string[];
  directContextTerms?: string[];
  parentEvidenceTerms?: string[];
}

export interface ClaimAnswer {
  answer_ko: string;
  summary_ko?: string;
  synthesis_mode?: "model" | "grounded_template";
  research_story?: ResearchStory;
  evidence_basis_ko?: string;
  evidence_status?: "rapid" | "verified";
  claim_id?: string;
  detail?: EvidenceDetails;
  verdict: Verdict;
  evidence_level: EvidenceLevel;
  citations: Citation[];
  evidence_interpretation?: EvidenceInterpretation[];
  practical_checks?: PracticalCheck[];
  limitations: string[];
  safety_note: string;
  /** Technical terms used above, paired with the words the user asked with. */
  glossary?: GlossaryEntry[];
  cached: boolean;
  /** Internal rendering guard for questions that ask about one intervention alone. */
  single_exposure_question?: boolean;
  category: Exclude<Category, "auto">;
  query_terms: string[];
}

export type ResearchPattern =
  | "evidence_shift"
  | "ongoing_debate"
  | "context_explains_difference"
  | "mostly_consistent"
  | "insufficient";

export interface ResearchStory {
  pattern: ResearchPattern;
  opening_ko: string;
  timeline_ko: string;
  resolution_ko: string;
}

export interface EvidenceDetails {
  short_term_ko: string;
  long_term_ko: string;
  risk_ko: string;
  applicability_ko: string;
  limitations_ko: string;
  key_studies: KeyStudyDetail[];
}

export interface KeyStudyDetail {
  citationIndex: number;
  title: string;
  year?: number;
  design_ko: string;
  population_ko: string;
  exposure_ko: string;
  result_ko: string;
  /** One-clause version of result_ko for the at-a-glance table. */
  headline_ko?: string;
  time_horizon: "short_term" | "long_term" | "mixed" | "unknown";
  limitation_ko: string;
  url: string;
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
