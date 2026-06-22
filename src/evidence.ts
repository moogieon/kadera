import type { EvidenceLevel, Paper } from "./types.js";

export function inferEvidenceLevel(publicationTypes: string[], source: Paper["source"]): EvidenceLevel {
  const joined = publicationTypes.join(" ").toLowerCase();
  if (/(systematic review|meta-analysis|meta analysis|review)/.test(joined)) return "systematic_review";
  if (/(randomized|clinical trial|controlled trial|intervention)/.test(joined)) return "clinical_study";
  if (/(cohort|case-control|cross-sectional|observational)/.test(joined)) return "observational_study";
  if (source === "semantic_scholar" && /(preprint|arxiv|medrxiv|biorxiv)/.test(joined)) return "preprint";
  return "unknown";
}

export function strongestEvidenceLevel(papers: Paper[]): EvidenceLevel {
  const order: EvidenceLevel[] = [
    "systematic_review",
    "clinical_study",
    "observational_study",
    "official_guidance",
    "preprint",
    "unknown"
  ];
  for (const level of order) {
    if (papers.some((paper) => paper.evidenceLevel === level)) return level;
  }
  return "unknown";
}

export function rankPapers(papers: Paper[], queryTerms: string[] = []): Paper[] {
  const seenDoi = new Set<string>();
  const seenTitle = new Set<string>();
  const deduped: Paper[] = [];
  for (const paper of papers) {
    const doiKey = paper.doi?.toLowerCase().trim();
    const titleKey = normalizeTitle(paper.title);
    if ((doiKey && seenDoi.has(doiKey)) || seenTitle.has(titleKey)) continue;
    if (doiKey) seenDoi.add(doiKey);
    seenTitle.add(titleKey);
    deduped.push(paper);
  }

  const highValueTokens = extractHighValueTokens(queryTerms);
  const humanOnly = deduped.filter((paper) => !isAnimalOnlyPaper(paper));
  if (highValueTokens.length === 0) {
    return humanOnly.sort((a, b) => scorePaper(b, highValueTokens) - scorePaper(a, highValueTokens));
  }

  const strong = humanOnly.filter((paper) => relevanceTokenHits(paper, highValueTokens) >= 2);
  const weak = humanOnly.filter((paper) => relevanceTokenHits(paper, highValueTokens) === 1);
  return [
    ...strong.sort((a, b) => scorePaper(b, highValueTokens) - scorePaper(a, highValueTokens)),
    ...weak.sort((a, b) => scorePaper(b, highValueTokens) - scorePaper(a, highValueTokens))
  ];
}

function scorePaper(paper: Paper, highValueTokens: string[]): number {
  const evidenceScore: Record<EvidenceLevel, number> = {
    systematic_review: 100,
    clinical_study: 80,
    observational_study: 60,
    official_guidance: 70,
    preprint: 30,
    unknown: 20
  };
  const yearScore = paper.year ? Math.max(0, Math.min(20, paper.year - 2005)) : 0;
  const citationScore = paper.citationCount ? Math.min(15, Math.log10(paper.citationCount + 1) * 5) : 0;
  const abstractScore = paper.abstract ? 5 : 0;
  const relevanceScore = relevanceTokenHits(paper, highValueTokens) * 45;
  return evidenceScore[paper.evidenceLevel] + yearScore + citationScore + abstractScore + relevanceScore;
}

function relevanceTokenHits(paper: Paper, highValueTokens: string[]): number {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `.toLowerCase();
  return highValueTokens.filter((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(haystack)).length;
}

function isAnimalOnlyPaper(paper: Paper): boolean {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `.toLowerCase();
  if (!/(nonhuman|non-human|macaque|primate|mouse|mice|rat|zebrafish|animal model)/.test(haystack)) return false;
  return !/(human infants|children|child|toddler|pediatric|participant|patient|caregiver)/.test(haystack);
}

function extractHighValueTokens(queryTerms: string[]): string[] {
  const tokens = new Set<string>();
  for (const term of queryTerms) {
    for (const token of term.toLowerCase().split(/[^a-z0-9]+/)) {
      if (rankingStopwords.has(token)) continue;
      if (token.length >= 4 || highValueTokenAllowlist.has(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const highValueTokenAllowlist = new Set([
  "fasted",
  "cardio",
  "weight",
  "fasting",
  "intermittent",
  "stretching",
  "injury",
  "protein",
  "powder",
  "whey",
  "supplement",
  "supplementation",
  "muscle",
  "hypertrophy",
  "lean",
  "mass",
  "resistance",
  "training",
  "dose",
  "grams",
  "kilogram",
  "safety",
  "carbohydrate",
  "meat",
  "iron",
  "picky",
  "screen",
  "eye",
  "contact",
  "gaze",
  "joint",
  "attention",
  "social",
  "communication",
  "regression",
  "milestone",
  "autism",
  "spectrum",
  "disorder",
  "infant",
  "infants",
  "toddler",
  "toddlers",
  "signs",
  "delay",
  "development",
  "developmental",
  "screening",
  "bilingualism",
  "language",
  "sleep",
  "anxiety",
  "depression",
  "vitamin",
  "omega",
  "calcium",
  "kidney",
  "renal",
  "sweetener",
  "sweeteners",
  "aspartame",
  "sucralose",
  "stevia",
  "erythritol",
  "acesulfame",
  "beverage",
  "beverages",
  "soda",
  "cola",
  "diet",
  "sugar",
  "glucose",
  "insulin",
  "glycemic",
  "microbiome",
  "microbiota",
  "metabolic",
  "diabetes"
]);

const rankingStopwords = new Set([
  "review",
  "meta",
  "analysis",
  "systematic",
  "clinical",
  "trial",
  "cohort",
  "study",
  "studies",
  "health",
  "nutrition",
  "diet",
  "child",
  "children",
  "adult",
  "adults",
  "effect",
  "effects",
  "impact",
  "association",
  "associated"
]);
