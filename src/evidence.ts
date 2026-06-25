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

  const humanOnly = deduped.filter((paper) => !isAnimalOnlyPaper(paper));
  const anchorGroups = extractAnchorGroups(queryTerms);
  const groupAnchored =
    anchorGroups.length > 0
      ? humanOnly.filter((paper) => anchorGroups.every((group) => group.some((phrase) => phraseMatches(paper, phrase))))
      : [];
  const anchorPhrases = extractAnchorPhrases(queryTerms);
  const anchored = anchorPhrases.length > 0 ? humanOnly.filter((paper) => anchorPhrases.some((phrase) => phraseMatches(paper, phrase))) : [];
  const rankingPool = groupAnchored.length > 0 ? groupAnchored : anchored.length >= 3 ? anchored : humanOnly;
  const highValueTokens = extractHighValueTokens(queryTerms);
  if (highValueTokens.length === 0) {
    return rankingPool.sort(
      (a, b) => scorePaper(b, highValueTokens, anchorGroups, anchorPhrases) - scorePaper(a, highValueTokens, anchorGroups, anchorPhrases)
    );
  }

  const strong = rankingPool.filter((paper) => relevanceTokenHits(paper, highValueTokens) >= 2);
  const weak = rankingPool.filter((paper) => relevanceTokenHits(paper, highValueTokens) === 1);
  return [
    ...strong.sort(
      (a, b) => scorePaper(b, highValueTokens, anchorGroups, anchorPhrases) - scorePaper(a, highValueTokens, anchorGroups, anchorPhrases)
    ),
    ...weak.sort(
      (a, b) => scorePaper(b, highValueTokens, anchorGroups, anchorPhrases) - scorePaper(a, highValueTokens, anchorGroups, anchorPhrases)
    )
  ];
}

function scorePaper(paper: Paper, highValueTokens: string[], anchorGroups: string[][] = [], anchorPhrases: string[] = []): number {
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
  const relevanceScore = Math.min(6, relevanceTokenHits(paper, highValueTokens)) * 25;
  const titleAnchorScore = titleAnchorBonus(paper, anchorGroups, anchorPhrases);
  const directionPenalty = contraryDirectionPenalty(paper, highValueTokens);
  return evidenceScore[paper.evidenceLevel] + yearScore + citationScore + abstractScore + relevanceScore + titleAnchorScore - directionPenalty;
}

function relevanceTokenHits(paper: Paper, highValueTokens: string[]): number {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `.toLowerCase();
  return highValueTokens.filter((token) => tokenMatches(haystack, token)).length;
}

function phraseMatches(paper: Paper, phrase: string): boolean {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ");
  const normalizedPhrase = phrase.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
  return haystack.includes(` ${normalizedPhrase} `);
}

function titleAnchorBonus(paper: Paper, anchorGroups: string[][], anchorPhrases: string[]): number {
  const title = normalizePhraseText(paper.title);
  if (anchorGroups.length > 0 && anchorGroups.every((group) => group.some((phrase) => textMatchesPhrase(title, phrase)))) return 140;
  if (anchorPhrases.some((phrase) => textMatchesPhrase(title, phrase))) return 50;
  return 0;
}

function contraryDirectionPenalty(paper: Paper, highValueTokens: string[]): number {
  const title = paper.title.toLowerCase();
  const asksHighProtein = highValueTokens.includes("protein") && (highValueTokens.includes("high") || highValueTokens.includes("powder") || highValueTokens.includes("whey"));
  if (asksHighProtein && /\blow[- ]protein\b/.test(title)) return 120;
  return 0;
}

function normalizePhraseText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

function textMatchesPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = phrase.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
  return normalizedText.includes(` ${normalizedPhrase} `);
}

function isAnimalOnlyPaper(paper: Paper): boolean {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `.toLowerCase();
  if (!/\b(nonhuman|non-human|macaque|primate|mouse|mice|rat|rats|zebrafish|animal model)\b/.test(haystack)) return false;
  return !/(human infants|children|child|toddler|pediatric|participant|patient|caregiver)/.test(haystack);
}

function extractHighValueTokens(queryTerms: string[]): string[] {
  const tokens = new Set<string>();
  for (const term of queryTerms) {
    for (const token of term.toLowerCase().split(/[^a-z0-9가-힣]+/)) {
      if (rankingStopwords.has(token)) continue;
      if (containsKorean(token) || token.length >= 4 || highValueTokenAllowlist.has(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

function extractAnchorPhrases(queryTerms: string[]): string[] {
  const joined = ` ${queryTerms.join(" ").toLowerCase()} `.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  const anchors: string[] = [];
  for (const [pattern, phrases] of anchorPhraseMap) {
    if (!pattern.test(joined)) continue;
    anchors.push(...phrases);
  }
  return [...new Set(anchors)];
}

function extractAnchorGroups(queryTerms: string[]): string[][] {
  const joined = ` ${queryTerms.join(" ").toLowerCase()} `.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  const groups: string[][] = [];
  const hasCreatine = /\bcreatine\b/.test(joined);
  if (hasCreatine) {
    groups.push(["creatine"]);
  }
  if (/\bintermittent fasting\b|\btime restricted eating\b|\balternate day fasting\b/.test(joined) && /\bweight\b|\bobesity\b|\bbody weight\b/.test(joined)) {
    groups.push(
      ["intermittent fasting", "time restricted eating", "time-restricted eating", "alternate day fasting", "alternate-day fasting"],
      ["weight", "body weight", "weight loss", "weight gain", "obesity", "overweight", "adiposity", "bmi"]
    );
  }
  if (/\bshort sleep\b|\bsleep duration\b|\bsleep deprivation\b|\bsleep restriction\b/.test(joined) && /\bweight\b|\bobesity\b|\bbody weight\b/.test(joined)) {
    groups.push(
      ["short sleep", "sleep duration", "sleep deprivation", "sleep restriction", "sleep quality"],
      ["weight", "body weight", "weight loss", "weight gain", "obesity", "overweight", "adiposity", "bmi"]
    );
  }
  if (/\bvitamin d\b|\bcholecalciferol\b|\bhydroxyvitamin d\b/.test(joined) && /\brespiratory\b|\bcold\b|\binfection\b/.test(joined)) {
    groups.push(
      ["vitamin d", "cholecalciferol", "hydroxyvitamin d", "25 hydroxyvitamin d", "25-hydroxyvitamin d"],
      ["respiratory", "respiratory tract", "common cold", "cold", "infection", "infections"]
    );
  }
  if (/\bcoffee\b/.test(joined) && /\bblood pressure\b|\bhypertension\b/.test(joined)) {
    groups.push(["coffee"], ["blood pressure", "hypertension"]);
  }
  if (/\bsweetener\b|\bsweeteners\b|\baspartame\b|\bsucralose\b|\bdiet soda\b|\bnon sugar\b|\blow calorie sweeteners\b|\bartificial sweeteners\b/.test(joined)) {
    groups.push([
      "sweetener",
      "sweeteners",
      "non sugar sweeteners",
      "nonnutritive sweeteners",
      "low calorie sweeteners",
      "artificial sweeteners",
      "aspartame",
      "sucralose",
      "acesulfame",
      "stevia",
      "erythritol",
      "diet soda"
    ]);
  }
  if (!hasCreatine && /\bprotein\b|\bwhey\b/.test(joined) && /\bkidney\b|\brenal\b/.test(joined)) {
    groups.push(["protein", "whey", "high protein", "protein supplement", "protein supplementation"], ["kidney", "renal"]);
  }
  if (/\bfasted\b|\bfasting\b/.test(joined) && /\bcardio\b|\baerobic\b|\bexercise\b/.test(joined)) {
    groups.push(["fasted", "fasting"], ["cardio", "aerobic", "exercise"], ["weight", "weight loss", "fat oxidation", "body fat", "fat", "metabolism"]);
  }
  if (/\bmaternal caffeine\b|\bcaffeine pregnancy\b|\bpregnancy caffeine\b|\bcoffee pregnancy\b/.test(joined)) {
    groups.push(["caffeine", "coffee"], ["pregnancy", "pregnant", "maternal"]);
  }
  if (/\bearly foreign language\b|\bsecond language exposure\b|\bbilingualism\b/.test(joined) && /\bchild\b|\bchildren\b|\bpreschool\b|\bearly childhood\b/.test(joined)) {
    groups.push(["second language", "foreign language", "bilingualism", "bilingual"], ["child", "children", "preschool", "early childhood"]);
  }
  if (/\belectronic cigarettes\b|\be cigarettes\b|\bvaping\b/.test(joined)) {
    groups.push(["electronic cigarette", "electronic cigarettes", "e cigarette", "e cigarettes", "vaping", "vape"]);
  }
  if (/\bprobiotic\b|\bprobiotics\b/.test(joined) && /\bconstipation\b|\bbowel\b|\bgut\b|\bintestinal\b/.test(joined)) {
    groups.push(["probiotic", "probiotics", "bifidobacterium", "lactobacillus"], ["constipation", "bowel", "intestinal", "gut", "transit"]);
  }
  return groups;
}

function tokenMatches(haystack: string, token: string): boolean {
  if (containsKorean(token)) return haystack.includes(token);
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(haystack);
}

function containsKorean(value: string): boolean {
  return /[가-힣]/.test(value);
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

const anchorPhraseMap: Array<[RegExp, string[]]> = [
  [/\bcreatine\b/, ["creatine"]],
  [/\bintermittent fasting\b|\btime restricted eating\b|\balternate day fasting\b/, ["intermittent fasting", "time restricted eating", "time-restricted eating", "alternate day fasting", "alternate-day fasting"]],
  [/\bvitamin d\b|\bcholecalciferol\b|\bhydroxyvitamin d\b/, ["vitamin d", "cholecalciferol", "hydroxyvitamin d", "25 hydroxyvitamin d", "25-hydroxyvitamin d"]],
  [/\bcoffee\b/, ["coffee"]],
  [/\bshort sleep\b|\bsleep duration\b|\bsleep deprivation\b|\bsleep restriction\b/, ["short sleep", "sleep duration", "sleep deprivation", "sleep restriction"]],
  [/\bomega 3\b|\bomega-3\b/, ["omega 3", "omega-3"]],
  [/\bsweetener\b|\bsweeteners\b|\bdiet soda\b|\baspartame\b|\bsucralose\b/, ["sweetener", "sweeteners", "diet soda", "aspartame", "sucralose"]],
  [/\bprotein\b|\bwhey\b/, ["protein", "whey"]],
  [/\bprobiotic\b|\bprobiotics\b|\bbifidobacterium\b|\blactobacillus\b/, ["probiotic", "probiotics", "bifidobacterium", "lactobacillus"]],
  [/\bscreen time\b|\bscreen based\b/, ["screen time", "screen-based", "screen based"]],
  [/\beye contact\b|\bjoint attention\b/, ["eye contact", "joint attention"]]
];

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
  "associated",
  "vitamin",
  "발달",
  "영유아",
  "유아",
  "소아",
  "아동",
  "섭취",
  "기능",
  "운동",
  "연구"
]);
