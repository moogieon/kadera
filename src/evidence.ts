import type { EvidenceLevel, Paper, ResearchIntent } from "./types.js";

/**
 * One contract for every stage that decides whether a paper may appear in an
 * answer. Retrieval, the model selector, and the answer renderer used to
 * have similar-but-different checks, which let adjacent papers re-enter later
 * in the pipeline.
 */
export type PaperIntentRole = "direct" | "contextual" | "reject";

export function inferEvidenceLevel(publicationTypes: string[], source: Paper["source"]): EvidenceLevel {
  const joined = publicationTypes.join(" ").toLowerCase();
  if (/(preprint|arxiv|medrxiv|biorxiv)/.test(joined)) return "preprint";
  if (/(systematic review|meta-analysis|meta analysis|umbrella review)/.test(joined)) return "systematic_review";
  if (/(randomized|clinical trial|controlled trial|intervention)/.test(joined)) return "clinical_study";
  if (/(cohort|case-control|cross-sectional|observational)/.test(joined)) return "observational_study";
  void source;
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

/**
 * Gates that are individually reasonable can jointly discard every candidate,
 * and the user is then told no research exists. Measured live: "리피토 평생
 * 먹어야 해?" was typed as a safety question, so the safety-outcome gate threw
 * away all twenty atorvastatin papers even though several answered the actual
 * question about long-term use.
 *
 * A question type is a guess by a language model, and a guess must not be able
 * to empty the evidence base. When a discretionary gate leaves nothing, drop
 * that gate and keep what the structural gates allow. The structural ones --
 * is this consumer health evidence, is this about the right thing, is this
 * about the right people -- always stand.
 */
function withRelaxedGateIfEmptied(candidates: Paper[], eligible: Paper[], intent?: ResearchIntent): Paper[] {
  if (eligible.length > 0 || !intent || candidates.length === 0) return eligible;
  const relaxable = new Set(["safety-outcome", "different-outcome", "broad-no-health-outcome"]);
  const recovered = candidates.filter((paper) => {
    const verdict = classifyPaperForIntentVerdict(paper, intent);
    return verdict.role !== "reject" || relaxable.has(verdict.gate);
  }).filter((paper) => isConsumerHealthEvidenceCandidate(paper, intent));
  return recovered;
}

export function rankPapers(papers: Paper[], queryTerms: string[] = [], intent?: ResearchIntent): Paper[] {
  const seenDoi = new Set<string>();
  const seenTitle = new Set<string>();
  const deduped: Paper[] = [];
  for (const paper of papers) {
    const normalizedPaper = normalizeEvidenceLevel(paper);
    const doiKey = normalizedPaper.doi?.toLowerCase().trim();
    const titleKey = normalizeTitle(normalizedPaper.title);
    if ((doiKey && seenDoi.has(doiKey)) || seenTitle.has(titleKey)) continue;
    if (doiKey) seenDoi.add(doiKey);
    seenTitle.add(titleKey);
    deduped.push(normalizedPaper);
  }

  // Keep the evidence base human-focused. Whether a paper matches the user's
  // topic is decided from the model's research intent below, not a catalogue
  // of named foods, drinks, or drugs.
  const eligiblePapers = withRelaxedGateIfEmptied(deduped, deduped.filter((paper) =>
    isConsumerHealthEvidenceCandidate(paper, intent) &&
    // Ranking, retry selection, and grounding must use the same semantic
    // contract. Previously a retry paper could be rejected here but later
    // re-enter through the grounding pool as a vague contextual match.
    (!intent || classifyPaperForIntent(paper, intent) !== "reject")
  ), intent);
  const directEvidenceGroups = intent?.directEvidenceGroups ?? [];
  if (intent?.questionType === "comparison") {
    const direct = eligiblePapers.filter((paper) => matchesDirectIntent(paper, intent));
    if (direct.length > 0) {
      const directTerms = directEvidenceGroups.flat();
      const rankedDirect = direct.sort((left, right) =>
        directComparisonScore(right, directTerms, directEvidenceGroups) -
        directComparisonScore(left, directTerms, directEvidenceGroups)
      );
      // A genuine head-to-head result should lead, but it is not the whole
      // evidence base. Keep separately evaluated papers on the same outcome
      // after it, so the answer can show why one older or narrow experiment
      // does not settle every practical use case.
      const parallel = eligiblePapers.filter((paper) =>
        !direct.includes(paper) && matchesParallelComparisonIntent(paper, intent)
      );
      return uniquePapers([
        ...rankedDirect,
        ...rankParallelComparisonPapers(parallel, intent, directTerms)
      ]);
    }

    // A side-by-side answer can still explain each option's evidence, but it
    // must not be presented as a head-to-head result.
    const parallel = eligiblePapers.filter((paper) => matchesParallelComparisonIntent(paper, intent));
    if (parallel.length > 0) {
      const comparisonTerms = [...intent.exposureTerms, ...intent.comparatorTerms, ...intent.outcomeTerms];
      return rankParallelComparisonPapers(parallel, intent, comparisonTerms);
    }
    // Do not fill a comparison answer with a merely adjacent topic. Without
    // a head-to-head result or a paper tied to either named side and the
    // requested outcome, the honest result is no eligible evidence.
    return [];
  }
  // Topic-wide questions have their own direct-versus-parent ranking. Do this
  // before the generic contextual ladder; otherwise a planner's
  // `direct_then_contextual` strategy lets a broad adjacent paper outrank an
  // exact-item result.
  if (intent && isBroadTopicIntent(intent)) {
    return rankBroadTopicPapers(eligiblePapers, queryTerms, intent);
  }
  if (intent?.evidenceStrategy === "direct_then_contextual") {
    return rankEvidenceLadderPapers(
      eligiblePapers.filter((paper) => classifyPaperForIntent(paper, intent) !== "reject"),
      queryTerms,
      intent
    );
  }
  if (directEvidenceGroups.length >= 2) {
    const directOnly = intent
      ? eligiblePapers.filter((paper) => matchesDirectIntent(paper, intent))
      : eligiblePapers.filter((paper) => paperMatchesEvidenceGroups(paper, directEvidenceGroups));
    if (directOnly.length === 0) {
      return intent ? rankContextualPapers(eligiblePapers, intent) : [];
    }
    const directTerms = directEvidenceGroups.flat();
    return directOnly.sort((left, right) =>
      scorePaper(right, directTerms, directEvidenceGroups, directTerms) -
      scorePaper(left, directTerms, directEvidenceGroups, directTerms)
    );
  }
  const intentAnchorGroups = extractIntentAnchorGroups(intent);
  const anchorGroups = intentAnchorGroups;
  const titleGroupAnchored =
    intentAnchorGroups.length >= 2
    ? eligiblePapers.filter((paper) => intentAnchorGroups.every((group) => conceptGroupMatchesTitle(paper, group)))
      : [];
  const groupAnchored =
    anchorGroups.length > 0
      ? eligiblePapers.filter((paper) => anchorGroups.every((group) => conceptGroupMatches(paper, group)))
      : [];
  if (intentAnchorGroups.length >= 2 && groupAnchored.length === 0) return [];
  const anchorPhrases = intentAnchorGroups.flat();
  const anchored = anchorPhrases.length > 0 ? eligiblePapers.filter((paper) => anchorPhrases.some((phrase) => phraseMatches(paper, phrase))) : [];
  const rankingPool = groupAnchored.length > 0
    ? groupAnchored
    : titleGroupAnchored.length > 0
      ? titleGroupAnchored
      : anchored.length >= 3
        ? anchored
        : eligiblePapers;
  const highValueTokens = extractHighValueTokens(queryTerms);
  if (highValueTokens.length === 0) {
    return [];
  }

  const strong = rankingPool.filter((paper) => relevanceTokenHits(paper, highValueTokens) >= 2);
  const weak = anchorPhrases.length > 0 ? rankingPool.filter((paper) => relevanceTokenHits(paper, highValueTokens) === 1) : [];
  const ranked = [
    ...strong.sort(
      (a, b) => scorePaper(b, highValueTokens, anchorGroups, anchorPhrases) - scorePaper(a, highValueTokens, anchorGroups, anchorPhrases)
    ),
    ...weak.sort(
      (a, b) => scorePaper(b, highValueTokens, anchorGroups, anchorPhrases) - scorePaper(a, highValueTokens, anchorGroups, anchorPhrases)
    )
  ];
  return preferDirectClassifiedEvidence(ranked, intent);
}

function directComparisonScore(paper: Paper, terms: string[], groups: string[][]): number {
  // A direct randomized trial is the clearest answer to a user asking which
  // named option works better. Reviews and real-world cohorts still remain as
  // supporting context, but must not displace that head-to-head result.
  const text = `${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`.toLowerCase();
  const randomizedHeadToHead = paper.evidenceLevel === "clinical_study" &&
    /\b(?:randomi[sz]ed|randomi[sz]ation|phase\s*(?:ii|2|iii|3)|controlled trial)\b/.test(text) &&
    hasExplicitComparison(paper);
  return scorePaper(paper, terms, groups, terms) + (randomizedHeadToHead ? 180 : 0);
}

export function evidenceDirectness(
  papers: Paper[],
  intent: ResearchIntent | undefined
): "direct" | "contextual" | undefined {
  if (!intent || papers.length === 0) return undefined;
  if (papers.some((paper) => classifyPaperForIntent(paper, intent) === "direct")) return "direct";
  return papers.some((paper) => classifyPaperForIntent(paper, intent) === "contextual") ? "contextual" : undefined;
}

export function comparisonEvidenceScope(
  papers: Paper[],
  intent: ResearchIntent | undefined
): "direct" | "parallel" | undefined {
  if (intent?.questionType !== "comparison" || papers.length === 0) return undefined;
  if (papers.some((paper) => matchesDirectIntent(paper, intent))) return "direct";
  return papers.some((paper) => matchesParallelComparisonIntent(paper, intent)) ? "parallel" : undefined;
}

function paperMatchesEvidenceGroups(paper: Paper, groups: string[][]): boolean {
  return groups.every((group) => matchesAnyConcept(paper, group, 2));
}

function rankEvidenceLadderPapers(papers: Paper[], queryTerms: string[], intent: ResearchIntent): Paper[] {
  const reportsRequestedOutcome = (paper: Paper) =>
    intent.outcomeTerms.length === 0 || hasMeasuredOutcomeSignal(paper, intent.outcomeTerms);
  // A relaxed condition may broaden a dose, setting, or parent category, but
  // it may not discard the subject altogether. Otherwise a paper sharing only
  // "weight" or "risk" can leak into a completely different question.
  const preservesPlannedTopic = (paper: Paper) =>
    canonicalExposureTermsMatch(paper, directExposureTerms(intent)) ||
    matchesPlannedBridge(paper, intent.directContextTerms ?? []) ||
    matchesPlannedBridge(paper, intent.contextualEvidenceTerms ?? []) ||
    matchesPlannedBridge(paper, intent.parentEvidenceTerms ?? []);
  const direct = papers.filter((paper) =>
    paper.evidenceLevel !== "unknown" &&
    matchesDirectIntent(paper, intent) &&
    reportsRequestedOutcome(paper)
  );
  const directContext = papers.filter((paper) =>
    paper.evidenceLevel !== "unknown" &&
    preservesPlannedTopic(paper) &&
    matchesAnyConcept(paper, intent.directContextTerms ?? [], 3) &&
    reportsRequestedOutcome(paper)
  );
  const parentEvidence = papers.filter((paper) =>
    paper.evidenceLevel !== "unknown" &&
    preservesPlannedTopic(paper) &&
    matchesAnyConcept(paper, intent.parentEvidenceTerms ?? [], 2) &&
    reportsRequestedOutcome(paper)
  );
  const closestContextual = papers.filter((paper) =>
    preservesPlannedTopic(paper) && matchesContextualIntent(paper, intent)
  );
  const highValueTokens = extractHighValueTokens(queryTerms);
  // Exact-item evidence leads, but it must not erase high-quality parent
  // evidence. Sausage health questions, for example, need the exact-item
  // literature and processed-meat outcome reviews. The UI later exposes only
  // representative papers; this list is the wider basis for the conclusion.
  return uniquePapers([...direct, ...directContext, ...parentEvidence, ...closestContextual]).sort((left, right) =>
    evidenceLadderScore(right, intent, highValueTokens) - evidenceLadderScore(left, intent, highValueTokens)
  );
}

function matchesPlannedBridge(paper: Paper, phrases: string[]): boolean {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} `.toLowerCase();
  return phrases.some((phrase) => {
    const normalized = normalizePhraseText(phrase).trim();
    if (!normalized) return false;
    if (haystack.includes(` ${normalized} `)) return true;
    const tokens = normalized
      .split(" ")
      .filter((token) => token.length >= 3)
      .filter((token) => !rankingStopwords.has(token) && !intentConceptStopwords.has(token));
    if (tokens.length === 0) return false;
    const specificityTokens = bridgeSpecificityTokens(tokens);
    // A bridge made only of generic study-domain words (for example
    // "dietary fat intake cardiovascular risk") is not an entity/topic
    // anchor. It would let an egg or dairy paper fill a slot in an answer
    // about an unrelated cooking fat. Require at least one real topic
    // modifier supplied by the retrieval plan.
    if (specificityTokens.length === 0) return false;
    if (!specificityTokens.some((token) => tokenMatches(haystack, token))) {
      return false;
    }
    const requiredHits = tokens.length === 1 ? 1 : Math.max(2, Math.ceil(tokens.length * 0.75));
    return tokens.filter((token) => tokenMatches(haystack, token)).length >= requiredHits;
  });
}

function matchesPlannedBridgeTitle(paper: Paper, phrases: string[]): boolean {
  const title = ` ${normalizePhraseText(paper.title)} `;
  const bridgeStopwords = new Set([
    "and", "or", "the", "with", "for", "from", "health", "outcome", "outcomes",
    "effect", "effects", "risk", "risks", "disease", "diseases", "cancer", "mortality",
    "cardiovascular", "metabolic", "clinical", "body", "weight", "blood", "pressure"
  ]);
  return phrases.some((phrase) => {
    const normalized = normalizePhraseText(phrase).trim();
    if (!normalized) return false;
    if (title.includes(` ${normalized} `)) return true;
    const tokens = normalized
      .split(" ")
      .filter((token) => token.length >= 3)
      .filter((token) => !rankingStopwords.has(token) && !intentConceptStopwords.has(token) && !bridgeStopwords.has(token));
    if (tokens.length === 0) return false;
    // A result-only title (for example, colorectal cancer epidemiology) must
    // not match a planned parent topic such as processed-meat cancer. A
    // bridge may also contain generic outcome words such as cardiovascular,
    // fat, or intake; require one of its distinctive topic modifiers too so
    // an omega-3 review cannot stand in for a saturated-fat review.
    const specificityTokens = bridgeSpecificityTokens(tokens);
    if (specificityTokens.length === 0) return false;
    if (!specificityTokens.some((token) => tokenMatches(title, token))) return false;
    if (!tokens.some((token) => tokenMatches(title, token))) return false;
    const requiredHits = tokens.length === 1 ? 1 : Math.min(2, tokens.length);
    return tokens.filter((token) => tokenMatches(title, token)).length >= requiredHits;
  });
}

function bridgeSpecificityTokens(tokens: string[]): string[] {
  // These words describe a study's general domain or endpoint. They must not
  // by themselves make a planned parent bridge look like a topic match.
  const genericBridgeTokens = new Set([
    "diet", "dietary", "nutrition", "nutritional", "food", "foods",
    "fat", "fats", "fatty", "acid", "acids", "oil", "oils",
    "intake", "consumption", "exposure", "replacement", "reduction",
    "pattern", "patterns", "quality", "overall", "total", "macronutrient", "macronutrients",
    "health", "outcome", "outcomes", "risk", "risks", "disease", "diseases",
    "cardiovascular", "cardiometabolic", "metabolic", "clinical", "human", "humans",
    "adult", "adults", "trial", "trials", "review", "systematic", "meta", "analysis"
  ]);
  return tokens.filter((token) => !genericBridgeTokens.has(token));
}

function rankBroadTopicPapers(papers: Paper[], queryTerms: string[], intent: ResearchIntent): Paper[] {
  const broadEligible = papers.filter((paper) => classifyPaperForIntent(paper, intent) !== "reject");
  const direct = broadEligible.filter((paper) => classifyPaperForIntent(paper, intent) === "direct");
  const contextual = broadEligible.filter((paper) => classifyPaperForIntent(paper, intent) === "contextual");
  const highValueTokens = extractHighValueTokens(queryTerms);
  const score = (paper: Paper) => {
    // A topic-wide question needs an evidence hierarchy before exact-keyword
    // recency. Otherwise an exact-title laboratory pH paper or a narrow
    // subgroup survey can outrank a human systematic review that uses the
    // field's standard scholarly alias. Exactness remains visible through
    // directness, but it cannot outweigh study design and population scope.
    const designPriority = paper.evidenceLevel === "systematic_review"
      ? 700
      : paper.evidenceLevel === "clinical_study"
        ? 360
        : paper.evidenceLevel === "observational_study"
          ? 240
          : paper.evidenceLevel === "official_guidance"
            ? 140
            : 0;
    const directness = classifyPaperForIntent(paper, intent) === "direct" ? 120 : 0;
    const laboratoryPenalty = isLaboratoryOutcomePaper(paper) ? 700 : 0;
    const narrowPopulationPenalty = isNarrowTopicStudy(paper) ? 180 : 0;
    return broadTopicContextScore(paper, intent, highValueTokens) +
      designPriority + directness - laboratoryPenalty - narrowPopulationPenalty;
  };
  // Overview questions should use the exact topic first, but they may include
  // a transparent parent-topic bridge when the plan explicitly requested one.
  return uniquePapers([...direct, ...contextual]).sort((left, right) => score(right) - score(left));
}

function isLaboratoryOutcomePaper(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:cell line|cell culture|cultured cells?|in vitro|simulated digestion|gastrointestinal model|tiny-tim|ileal cannulated|gilts?|swine|pigs?|laboratory[- ]?based|laboratory study|bench study|physicochemical|focused on p\s*h)\b/.test(text);
}

function broadTopicContextScore(paper: Paper, intent: ResearchIntent, highValueTokens: string[]): number {
  const title = normalizePhraseText(paper.title);
  const abstract = normalizePhraseText(paper.abstract ?? "");
  const exactTopicMention = intent.exposureTerms.some((term) => {
    const phrase = normalizePhraseText(term);
    return phrase.trim() && abstract.includes(phrase);
  });
  const semanticMatch = Math.max(0, ...(intent.contextualEvidenceTerms ?? []).map((term) => {
    const tokens = normalizePhraseText(term).trim().split(" ").filter((token) => token.length >= 4);
    return tokens.filter((token) => title.includes(` ${token} `)).length;
  }));
  return broadTopicPaperScore(paper, highValueTokens) + semanticMatch * 200 + (exactTopicMention ? 500 : 0);
}

function namesExposureInText(paper: Paper, exposureTerms: string[]): boolean {
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return exposureTerms.some((term) => {
    const phrase = normalizePhraseText(term).trim();
    return phrase.length > 0 && text.includes(` ${phrase} `);
  });
}

function isTopicLevelReview(paper: Paper): boolean {
  return !/\b(?:bibliometric|scientometric|mapping analysis|citation analysis)\b/i.test(paper.title) &&
    /\b(?:systematic review|meta[ -]?analysis|umbrella review|state[- ]of[- ]the[- ]art review|narrative review|review)\b/i
    .test(`${paper.title} ${paper.publicationTypes.join(" ")}`);
}

function isPreclinicalFocusedReview(paper: Paper): boolean {
  return /\b(?:molecular modeling|in silico|animal model|mouse|mice|rat|rats|cell line|in vitro|in vivo)\b/i
    .test(paper.title);
}

function broadTopicPaperScore(paper: Paper, highValueTokens: string[]): number {
  const title = paper.title.toLowerCase();
  let scopeScore = 0;
  if (/(?:health outcomes|health effects|health impact|beneficial effects|cardiometabolic)/.test(title)) scopeScore += 80;
  if (/(?:systematic review|umbrella review)/.test(title)) scopeScore += 30;
  if (isNarrowTopicStudy(paper)) scopeScore -= 80;
  return scorePaper(paper, highValueTokens) + scopeScore;
}

function isNarrowTopicStudy(paper: Paper): boolean {
  // A broad question should not be led by a review restricted to an
  // unrequested subgroup. This is a scope rule, not a subject lookup table.
  return /\b(?:patients? with|people with|individuals with|older adults?|children|adolescents?|pregnan\w*)\b/i.test(paper.title);
}

function rankContextualPapers(papers: Paper[], intent: ResearchIntent): Paper[] {
  const contextual = papers.filter((paper) => matchesContextualIntent(paper, intent));
  if (contextual.length === 0) return [];
  const terms = intent.contextualEvidenceTerms ?? [];
  return contextual.sort((left, right) => scorePaper(right, terms, [], terms) - scorePaper(left, terms, [], terms));
}

/**
 * "위고비와 마운자로 차이" names both options and no endpoint, because the
 * reader does not yet know which endpoints matter. Requiring an outcome match
 * then rejects a head-to-head systematic review of exactly those two drugs:
 * the same question returned five papers or none depending on whether the
 * planner happened to volunteer outcome terms that call. Naming both options
 * is the comparison, and any reported result answers it.
 */
export function isOutcomeOpenComparison(intent: ResearchIntent): boolean {
  return intent.questionType === "comparison" && intent.outcomeTerms.length === 0;
}

export function matchesDirectIntent(paper: Paper, intent: ResearchIntent): boolean {
  const directTerms = directExposureTerms(intent);
  if (isBroadTopicIntent(intent)) {
    // A broad overview may use parent evidence as transparent context, but a
    // paper is direct only when its title makes the asked subject a real
    // study topic. Mentioning it once in an ultra-processed-food background
    // paragraph is not enough.
    return directExposureMatchesTitleForIntent(paper, intent, directTerms);
  }
  const groups = (intent.directEvidenceGroups ?? [])
    .map((group) => isExposureConceptGroup(group, intent)
      ? group.filter((term) => directTerms.includes(term))
      : group)
    .filter((group) => group.length > 0);
  const strictConditionMatch = intent.questionType === "comparison" ||
    intent.questionType === "dosage" ||
    intent.timeHorizon !== "unspecified";
  const groupsMatched = groups.length < 2 || groups.every((group) =>
    strictConditionMatch
      ? matchesDirectConcept(paper, group)
      : matchesAnyConcept(paper, group, 2) || matchesDirectConcept(paper, group)
  );
  if (!groupsMatched) return false;
  if (groups.length >= 2) {
    // A broad intervention review can mention the requested subtype in its
    // abstract while reporting only a combined-program result. For a
    // multi-concept question, the paper must make the requested exposure a
    // title-level subject before we can use it as direct evidence.
    const foodProteinAssay = isDirectFoodProteinQualityAssay(paper, intent);
    const exposureInTitle = directExposureMatchesTitleForIntent(paper, intent, directTerms);
    // Planners sometimes keep the canonical item in `exposure` while their
    // synonym list only contains narrower forms. A title may then name the
    // canonical item and the abstract the measured subtype. Accept that
    // combination, but still require both a title anchor and a full exposure
    // phrase in the abstract so an incidental background mention cannot pass.
    const titleAnchor = hasExposureTitleAnchor(paper, directTerms);
    const exposureInAbstract = directExposureMatchesTitleForIntent(
      { ...paper, title: paper.abstract ?? "", abstract: undefined },
      intent,
      directTerms
    );
    if (!exposureInTitle && !(titleAnchor && exposureInAbstract) && !foodProteinAssay) return false;
    if (asksForSingleExposure(intent) && titleCentersAnotherIntervention(paper, directTerms)) return false;
    if (intent.questionType !== "comparison") return true;
    // A study that compares any two groups is not automatically a comparison
    // of the two options the user named. Both options and the requested outcome
    // must be present before calling it head-to-head evidence.
    return matchesNamedOption(paper, directTerms) &&
      matchesNamedOption(paper, intent.comparatorTerms) &&
      (isOutcomeOpenComparison(intent) ||
        matchesAnyConcept(paper, intent.outcomeTerms, 2) ||
        matchesDirectConcept(paper, intent.outcomeTerms)) &&
      hasNamedHeadToHeadComparison(paper, intent);
  }
  // For a one-concept question, an incidental mention in the abstract is not
  // enough to make a paper direct evidence. Requiring the named topic in the
  // title prevents a broad review from being mistaken for an exact-item
  // study; planned parent evidence can still enter through the contextual
  // route below.
  const exposureMatched = intent.evidenceStrategy === "direct_then_contextual"
    ? directExposureMatchesTitleForIntent(paper, intent, directTerms)
    : namedExposureMatches(paper, directTerms);
  const comparatorMatched = intent.questionType !== "comparison" || intent.comparatorTerms.length === 0 ||
    matchesAnyConcept(paper, intent.comparatorTerms, 2);
  const outcomeMatched = isOutcomeOpenComparison(intent) ||
    matchesAnyConcept(paper, intent.outcomeTerms, 3) || matchesDirectConcept(paper, intent.outcomeTerms);
  const comparisonMatched = intent.questionType !== "comparison" || hasNamedHeadToHeadComparison(paper, intent);
  return exposureMatched && comparatorMatched && outcomeMatched && comparisonMatched;
}

function hasExposureTitleAnchor(paper: Paper, phrases: string[]): boolean {
  const title = normalizePhraseText(paper.title);
  const ignored = new Set([
    "high", "low", "intake", "consumption", "consuming", "dietary", "daily", "regular", "habitual",
    "food", "foods", "beverage", "beverages", "drink", "drinks", "exposure", "use", "of", "and", "the"
  ]);
  return phrases.some((phrase) => phrase
    .split(/[^a-z0-9가-힣]+/)
    .filter((token) => token.length >= 4 && !ignored.has(token))
    .some((token) => tokenMatches(title, token))
  );
}

function directExposureTerms(intent: ResearchIntent): string[] {
  const base = normalizePhraseText(intent.exposure.replace(/\([^)]*\)/g, ""));
  const genericCanonicalTokens = new Set([
    "item", "product", "food", "substance", "agent", "treatment", "intervention", "supplement"
  ]);
  const baseTokens = base
    .split(" ")
    .filter((token) => token.length >= 3 &&
      !genericCanonicalTokens.has(token) &&
      !directConceptQualifierStopwords.has(token));
  const bridges = (intent.contextualEvidenceTerms ?? []).map((term) => normalizePhraseText(term));
  const direct = intent.exposureTerms.filter((term) => {
    const normalized = normalizePhraseText(term);
    const isNamedAsBridge = bridges.some((bridge) =>
      bridge !== normalized && bridge.includes(normalized)
    );
    const sharesCanonicalName = baseTokens.length > 0 &&
      baseTokens.every((token) => normalized.includes(` ${token} `));
    // A broader category occasionally appears in the model's synonym list as
    // well as in a contextual query. Keep it contextual unless it still names
    // the canonical item itself. This is driven by the plan's own structure,
    // not a catalogue of foods, drugs, or brands.
    return !isNamedAsBridge || sharesCanonicalName;
  });
  return direct.length > 0 ? direct : intent.exposureTerms;
}

function isExposureConceptGroup(group: string[], intent: ResearchIntent): boolean {
  const normalizedGroup = new Set(group.map((term) => normalizePhraseText(term)));
  return intent.exposureTerms.some((term) => normalizedGroup.has(normalizePhraseText(term)));
}

function asksForSingleExposure(intent: ResearchIntent): boolean {
  return /(?:\balone\b|\bonly\b|\bsolely\b|\bby itself\b)/i.test(`${intent.exposure} ${intent.exposureTerms.join(" ")}`);
}

function titleCentersAnotherIntervention(paper: Paper, exposureTerms: string[]): boolean {
  const title = normalizePhraseText(paper.title);
  const resistanceQuestion = exposureTerms.some((term) => /(?:resistance|strength|weight)\s+training|resistance exercise/i.test(term));
  if (!resistanceQuestion) return false;
  return /\b(?:incretin|glp[- ]?1|pharmacotherap|medication|drug therap|protein|creatine|supplement|diet(?:ing|ary)?|caloric restriction|dietary restriction|combined)\b/i.test(title);
}

function directExposureMatchesTitle(paper: Paper, phrases: string[]): boolean {
  const title = normalizePhraseText(paper.title);
  const genericTokens = new Set([
    "weight", "training", "exercise", "physical", "activity",
    "high", "low", "intake", "consumption", "consuming", "dietary",
    "daily", "regular", "habitual", "exposure", "use"
  ]);
  return phrases.some((phrase) => {
    if (textMatchesPhrase(title, phrase)) return true;
    const distinctiveTokens = phrase
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      // Short words such as "fat", "oil", and "tea" can be the part that
      // distinguishes the requested consumer item. Dropping every token
      // below four characters made "pork fat" match a paper about pork in
      // general. Only stopwords are safe to discard here.
      .filter((token) => token.length >= 3 && !genericTokens.has(token));
    return distinctiveTokens.length > 0 && distinctiveTokens.every((token) => tokenMatches(title, token));
  });
}

function directExposureMatchesTitleForIntent(
  paper: Paper,
  intent: ResearchIntent,
  phrases: string[]
): boolean {
  if (!directExposureMatchesTitle(paper, phrases)) return false;
  const canonical = normalizePhraseText(intent.exposure.replace(/\([^)]*\)/g, "")).trim();
  if (!canonical) return true;
  const title = normalizePhraseText(paper.title);
  if (textMatchesPhrase(title, canonical)) return true;
  const canonicalTokens = canonical
    .split(" ")
    .filter((token) => token.length >= 4 && !directCanonicalStopwords.has(token));
  const canonicalShortTokens = canonical
    .split(" ")
    .filter((token) => token.length === 3 && !directCanonicalStopwords.has(token));
  // Keep the original flexible canonical match for long natural-language
  // labels such as "high intake of added sugars". For a named item that has
  // a short but material noun ("pork fat", "tea oil"), that noun must also
  // occur. Otherwise a paper about pork or tea in general is a false match.
  const hasRequiredShortCanonicalToken = canonicalShortTokens.length === 0 ||
    canonicalShortTokens.every((token) => tokenMatches(title, token));
  if (hasRequiredShortCanonicalToken && canonicalTokens.some((token) => tokenMatches(title, token))) return true;
  // A canonical label can include a parenthetical clarification, while a
  // paper title uses a valid exact alias (for example the single word
  // "lard"). directExposureMatchesTitle verifies every meaningful token of
  // the alias, so a partial phrase such as "pork" is not enough.
  if (phrases.some((phrase) => directExposureMatchesTitle(paper, [phrase]))) return true;
  // The planner can use a valid scholarly alias (for example a scientific
  // name), but an alias must be tied back to the asked entity inside the same
  // paper. A bare wider category is not enough: it can include a different
  // food, drink, medicine, or intervention with its own evidence base.
  const abstract = normalizePhraseText(paper.abstract ?? "");
  return textMatchesPhrase(abstract, canonical);
}

const directCanonicalStopwords = new Set([
  "with", "from", "into", "over", "under", "about", "effect", "effects", "health", "outcome", "outcomes",
  "intake", "consumption", "exposure", "product", "products", "food", "foods", "drink", "drinks", "beverage", "beverages"
]);

function isBroadTopicIntent(intent: ResearchIntent): boolean {
  // `other` plus no requested endpoint is the contract for a topic-wide
  // question. The planner may reasonably label its time horizon as mixed
  // because the literature spans acute and long-term studies; that metadata
  // must not bypass the broad-topic relevance and health-outcome gates.
  return intent.questionType === "other" && intent.outcomeTerms.length === 0;
}

export function matchesParallelComparisonIntent(paper: Paper, intent: ResearchIntent): boolean {
  if (intent.questionType !== "comparison") return false;
  // A comparison-side paper must make one of the named options its actual
  // topic. Mentioning pork or chicken once in an introduction to insect
  // protein is not side evidence for a pork-versus-chicken question.
  const titlePaper = { ...paper, abstract: undefined };
  const foodProteinIntent = isFoodProteinQualityIntent(intent);
  const exposureMatched = foodProteinIntent
    ? matchesFoodProteinOptionEvidence(paper, intent.exposure, intent.exposureTerms)
    : matchesComparisonOption(titlePaper, intent.exposure, intent.exposureTerms);
  const comparatorMatched = foodProteinIntent
    ? matchesFoodProteinOptionEvidence(paper, intent.comparator, intent.comparatorTerms)
    : matchesComparisonOption(titlePaper, intent.comparator, intent.comparatorTerms);
  const outcomeMatched = foodProteinIntent
    ? matchesFoodProteinQualityOutcome(paper)
    : isOutcomeOpenComparison(intent) || matchesAnyConcept(paper, intent.outcomeTerms, 2);
  if (!(exposureMatched || comparatorMatched) || !outcomeMatched) return false;
  if (foodProteinIntent && !isFoodProteinConsumerStudy(paper, intent)) return false;
  if (!foodProteinIntent && !isOutcomeOpenComparison(intent) &&
    !hasMeasuredOutcomeSignal(paper, intent.outcomeTerms)) return false;
  return !foodProteinIntent || hasFoodProteinStudyFinding(paper, intent);
}

function hasMeasuredOutcomeSignal(paper: Paper, outcomeTerms: string[]): boolean {
  const specificOutcomeTerms = outcomeTerms.filter((term) =>
    !/^(?:health|health outcomes?|adverse health outcomes?|clinical outcomes?|disease outcomes?)$/i.test(term.trim())
  );
  if (specificOutcomeTerms.length === 0) {
    // A planner can legitimately request a broad health question. In that
    // case it is safer to require an explicit health result than to demand
    // the literal phrase "health outcomes", which abstracts rarely use.
    return /\b(?:results?|conclusion|found|observed|associated|significant(?:ly)?|improved?|reduced?|decreased?|increased?|lower|higher|changed)\b/i.test(paper.abstract ?? "") &&
      /\b(?:risk|mortality|disease|cancer|cardiovascular|blood pressure|cholesterol|glucose|insulin|weight|adverse)\b/i.test(`${paper.title} ${paper.abstract ?? ""}`);
  }
  const titlePaper = { ...paper, abstract: undefined };
  if (matchesAnyConcept(titlePaper, specificOutcomeTerms, 2)) return true;

  const sentences = (paper.abstract ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    // Excluding "height and weight were measured" was tried here and reverted:
    // dropping the word "measured" from the result verbs cost 계란 its whole
    // evidence base (4 papers to 0) while letting an unrelated karate-athlete
    // study into 일찍 자면 키. The measurement-versus-finding distinction is
    // real, but this sentence filter is too blunt to draw it.
    const sentencePaper = { ...paper, title: "", abstract: sentence };
    return matchesAnyConcept(sentencePaper, specificOutcomeTerms, 2) &&
      /\b(?:result(?:s|ed)?|conclusion|found|observed|measured|determined|evaluated|significant(?:ly)?|higher|lower|increased|decreased|greater|less|improved?|reduced?|modulat(?:ed|ion)|associated)\b/i.test(sentence);
  });
}

export function matchesContextualIntent(paper: Paper, intent: ResearchIntent): boolean {
  // The planner keeps exact-item context and broader parent evidence in
  // separate fields, but both are contextual rather than direct proof. Match
  // either only when the title makes that planned bridge the study topic.
  const terms = [...new Set([
    ...(intent.contextualEvidenceTerms ?? []),
    ...(intent.directContextTerms ?? []),
    ...(intent.parentEvidenceTerms ?? [])
  ])];
  if (terms.length === 0) return false;
  // A safety answer can use narrowly labelled context only when the paper
  // still studies the exact requested exposure. A component or broad class
  // may explain a mechanism, but it cannot replace an energy drink, a named
  // medicine, or another specific product in a user-facing safety claim.
  if (isSafetyIntent(intent) && !hasCanonicalExposureMention(paper, intent)) return false;
  // A contextual paper may relax a dose, subgroup, or comparison, but it must
  // still name the thing the user asked about. Matching only broad words such
  // as "processed", "health", or "exercise" pulls in product-development
  // papers that cannot answer the question.
  const titlePaper = { ...paper, abstract: undefined };
  if (intent.questionType === "comparison") {
    const namesTopicInTitle = matchesComparisonOption(titlePaper, intent.exposure, intent.exposureTerms) ||
      matchesComparisonOption(titlePaper, intent.comparator, intent.comparatorTerms);
    if (!namesTopicInTitle) return false;
  }
  // A bridge is valid only when it is the paper's topic, not a word in the
  // introduction. A diet review that briefly mentions processed meat cannot
  // stand in for a processed-meat outcome review.
  // The title and abstract match must come from the same planned bridge.
  // Checking the two arrays independently allowed a paper to match the
  // title on one broad parent term and its abstract on another, creating
  // accidental cross-topic matches such as an egg review in a cooking-fat
  // answer.
  const matchesOneBridge = terms.some((term) =>
    matchesPlannedBridgeTitle(paper, [term]) &&
    matchesAnyConcept(paper, [term], 2)
  );
  if (!matchesOneBridge) return false;
  // Contextual evidence may relax the dose, the subgroup or the comparison,
  // but not the endpoint: it still has to measure what was asked about. The
  // check used to apply only to the direct_then_contextual strategy, so under
  // every other plan a paper qualified on the exposure alone, and "일찍 자면
  // 키가 클까?" was answered with sleep studies of energy intake, inflammatory
  // markers and overweight, none of which measured height.
  return intent.outcomeTerms.length === 0 || hasMeasuredOutcomeSignal(paper, intent.outcomeTerms);
}

function hasCanonicalExposureMention(paper: Paper, intent: ResearchIntent): boolean {
  const canonical = normalizePhraseText(intent.exposure.replace(/\([^)]*\)/g, "")).trim();
  if (!canonical) return false;
  return textMatchesPhrase(normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`), canonical);
}

/**
 * Reject records whose primary subject is making, storing, feeding, or
 * characterising a product rather than the health effect of consuming it.
 * This is intentionally topic-agnostic: it protects every food, oil,
 * supplement, and consumer ingredient without a dictionary of named items.
 */
export function isConsumerHealthEvidenceCandidate(
  paper: Paper,
  intent?: ResearchIntent
): boolean {
  // Nutrition-quality assays are a narrow exception. A user comparing food
  // protein quality may need a direct digestibility/composition measurement,
  // even when it is not a human-outcome experiment. The renderer labels that
  // evidence accordingly instead of presenting it as a clinical effect.
  const foodProteinAssay = isFoodProteinMetricAssay(paper, intent);
  return !isPreprintPaper(paper) &&
    !isLowTrustScholarlySource(paper) &&
    !isStudyProtocolPaper(paper) &&
    !isClearlyNonHealthPaper(paper) &&
    !isMaterialOrEngineeringPaper(paper) &&
    (!isAnimalOnlyPaper(paper) || foodProteinAssay) &&
    !isFoodProcessingOrPreservationPaper(paper) &&
    !isDietaryExposureCharacterizationPaper(paper) &&
    (!isFoodSupplyOrCompositionPaper(paper) || foodProteinAssay);
}

/**
 * Provider metadata is inconsistent for manuscript servers. A title such as
 * "systematic review" must never promote a Research Square or arXiv record
 * into a peer-reviewed evidence tier simply because it contains review words.
 */
export function isPreprintPaper(paper: Paper): boolean {
  const text = [
    paper.source,
    paper.title,
    paper.venue ?? "",
    paper.publisher ?? "",
    paper.url,
    paper.doi ?? "",
    ...paper.publicationTypes
  ].join(" ").toLowerCase();
  return paper.evidenceLevel === "preprint" ||
    /\b(?:preprint|arxiv|biorxiv|medrxiv|research square|researchsquare)\b/.test(text) ||
    /(?:doi\.org\/)?10\.21203\/rs\./.test(text);
}

/**
 * Which gate decided a paper's role. Retained because the pipeline discards
 * most candidates silently: a question could retrieve ninety papers and cite
 * none, with no way to tell whether the filter was right. Every rejection now
 * names the rule that made it.
 */
export interface PaperIntentVerdict {
  role: PaperIntentRole;
  gate: string;
}

export function classifyPaperForIntent(paper: Paper, intent: ResearchIntent | undefined): PaperIntentRole {
  return classifyPaperForIntentVerdict(paper, intent).role;
}

export function classifyPaperForIntentVerdict(paper: Paper, intent: ResearchIntent | undefined): PaperIntentVerdict {
  const reject = (gate: string): PaperIntentVerdict => ({ role: "reject", gate });
  const accept = (role: PaperIntentRole, gate: string): PaperIntentVerdict => ({ role, gate });
  if (!intent) return accept("direct", "no-intent");
  if (!isConsumerHealthEvidenceCandidate(paper, intent)) return reject("consumer-health");
  if (hasEntityMethodNameCollision(paper, intent.exposureTerms)) return reject("name-collision");
  if (isExposureAssessmentPaper(paper)) return reject("exposure-assessment");
  if (hasDifferentPrimaryOutcome(paper, intent)) return reject("different-outcome");
  if (titleCentersCombinedIntervention(paper, intent)) return reject("combined-intervention");
  if (titleCentersUnrequestedCoExposure(paper, intent)) return reject("co-exposure");
  if (hasContradictoryExposureModifier(paper, intent)) return reject("contradictory-modifier");
  if (titleHasUnrequestedSpecialCondition(paper, intent)) return reject("special-condition");
  if (titleTargetsUnrequestedPopulation(paper, intent)) return reject("unrequested-population");
  // A safety question is not answered by an efficacy paper that happens to
  // mention the same medication. The paper must actually report a safety
  // endpoint or the concrete symptom requested by the user.
  if (isSafetyIntent(intent) && !reportsSafetyOutcome(paper, intent)) return reject("safety-outcome");

  // A comparison answer may use a genuine head-to-head study or one study for
  // each named side on the same outcome axis. It must not fall through to a
  // generic contextual match: that was how a pork-versus-chicken request
  // could surface sausage formulation and cooking-method papers after a
  // targeted retry. This applies to every A-versus-B question, not a list of
  // known comparison topics.
  if (intent.questionType === "comparison") {
    if (isFoodProteinQualityIntent(intent) && !isFoodProteinConsumerStudy(paper, intent)) return reject("food-protein-consumer");
    if (matchesDirectIntent(paper, intent)) return accept("direct", "comparison-direct");
    return matchesParallelComparisonIntent(paper, intent)
      ? accept("contextual", "comparison-parallel")
      : reject("comparison-no-match");
  }

  if (isBroadTopicIntent(intent)) {
    if (isPreclinicalFocusedReview(paper)) return reject("preclinical-review");
    if (titleUsesExposureAsResearchVehicle(paper)) return reject("research-vehicle");
    // "X가 실제로 좋나/나쁘나" is still a health-outcome question even
    // when the user did not name a single endpoint. An exact title match for
    // seasonal emissions, composition, extraction yield, or manufacturing is
    // not evidence of a benefit or harm in people. Require a measured health
    // or biological outcome before a broad-topic paper can occupy a result
    // slot; the exact topic remains a retrieval anchor, not the answer by
    // itself.
    if (!hasBroadHealthOutcomeSignal(paper)) return reject("broad-no-health-outcome");
    if (matchesDirectIntent(paper, intent)) return accept("direct", "broad-direct");
    return matchesContextualIntent(paper, intent)
      ? accept("contextual", "broad-contextual")
      : reject("broad-no-match");
  }

  if (matchesDirectIntent(paper, intent)) return accept("direct", "direct");
  if (intent.evidenceStrategy === "direct_then_contextual") {
    const directContextTerms = intent.directContextTerms ?? [];
    const parentEvidenceTerms = intent.parentEvidenceTerms ?? [];
    const directContext = directContextTerms.length > 0 &&
      matchesPlannedBridgeTitle(paper, directContextTerms) &&
      matchesAnyConcept(paper, directContextTerms, 3) &&
      (intent.outcomeTerms.length === 0 || hasMeasuredOutcomeSignal(paper, intent.outcomeTerms));
    const parentEvidence = parentEvidenceTerms.length > 0 &&
      matchesPlannedBridgeTitle(paper, parentEvidenceTerms) &&
      matchesAnyConcept(paper, parentEvidenceTerms, 2) &&
      (intent.outcomeTerms.length === 0 || hasMeasuredOutcomeSignal(paper, intent.outcomeTerms));
    if (directContext || parentEvidence || matchesContextualIntent(paper, intent)) return accept("contextual", "ladder-contextual");
  }
  return matchesContextualIntent(paper, intent)
    ? accept("contextual", "contextual")
    : reject("no-match");
}

function hasContradictoryExposureModifier(paper: Paper, intent: ResearchIntent): boolean {
  // Preserve a requested modifier when the scholarly literature distinguishes
  // sibling exposures. This is not a subject lookup: it prevents a no-/zero-
  // sugar item from inheriting results for a sugar-sweetened item merely
  // because both are beverages. A paper that explicitly studies both remains
  // eligible as a comparison.
  // Publisher metadata uses several Unicode dash characters (not only
  // ASCII `-`). Normalize them before checking mutually exclusive modifiers
  // so "sugar‐sweetened" cannot slip through a zero-sugar request merely
  // because the title came from a different index.
  const normalizeModifierText = (value: string): string => value
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const requested = normalizeModifierText(`${intent.exposure} ${intent.exposureTerms.join(" ")}`);
  const title = normalizeModifierText(paper.title);
  const asksLowOrNoSugar = /\b(?:zero[- ]?(?:sugar|calorie)|sugar[- ]?free|diet(?:\s+(?:soda|soft\s+drink|beverage))?|low[- ]?(?:calorie|energy)|no[- ]?(?:calorie|sugar)|non[- ]?(?:caloric|nutritive)|artificially\s+sweetened)\b/i.test(requested);
  const titleNamesSugarSweetened = /\b(?:sugar[- ]sweetened|sugar sweetened|added\s+sugar|\bssbs?\b)\b/i.test(title);
  const titleNamesLowOrNoSugar = /\b(?:zero[- ]?(?:sugar|calorie)|sugar[- ]?free|diet(?:\s+(?:soda|soft\s+drink|beverage))?|low[- ]?(?:calorie|energy)|no[- ]?(?:calorie|sugar)|non[- ]?(?:caloric|nutritive)|artificially\s+sweetened)\b/i.test(title);
  return asksLowOrNoSugar && titleNamesSugarSweetened && !titleNamesLowOrNoSugar;
}

function titleUsesExposureAsResearchVehicle(paper: Paper): boolean {
  // A food, drink, or substance can appear in a trial only as a solvent,
  // vehicle, bowel-preparation aid, or other procedural component. Such a
  // paper measures the procedure, not the consumer health effect of the
  // named exposure, so it cannot answer a broad "is X good/bad" question.
  const title = paper.title.toLowerCase();
  return /\b(?:as\s+(?:a|an|the)\s+(?:solvent|vehicle|excipient|contrast(?:\s+agent)?|preparation)|for\s+(?:colonoscopy|bowel\s+preparation|endoscopy|imaging))\b/i.test(title);
}

function hasBroadHealthOutcomeSignal(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  const reportsResult = /\b(?:results?|conclusions?|found|observed|measured|significant(?:ly)?|increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|improv(?:ed|e|es)|worsen(?:ed|s)?|associated with|linked to|did not (?:differ|alter|affect|change)|no (?:significant )?(?:difference|association|effect))\b/i.test(text);
  const healthEndpoint = /\b(?:risk|mortality|disease|cancer|cardiovascular|blood pressure|heart rate|arrhythmia|cholesterol|glucose|insulin|weight|body fat|adverse|toxicity|pain|symptom|sleep|insomnia|stress|anxiety|depression|mood|cognitive|memory|cortisol|immune|immun|natural killer|nk(?:\s|-)?cells?|inflammation|cytokine|allerg(?:y|ic)|respiratory|lung|tiffeneau|\bige\b)\b/i.test(text);
  return reportsResult && healthEndpoint;
}

function titleHasUnrequestedSpecialCondition(paper: Paper, intent: ResearchIntent): boolean {
  const title = paper.title.toLowerCase();
  const conditions = title.match(/\b(?:abnormalit(?:y|ies)|defect(?:s)?|mutation(?:s)?|patholog(?:y|ies)|infection(?:s)?|viral|virus|bacterial|bacteri(?:um|a)|parasite|parasitic|post[- ]?operative|post[- ]?surg(?:ery|ical))\b/g);
  if (!conditions?.length) return false;
  const requested = [
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms,
    ...intent.populationTerms
  ].join(" ").toLowerCase();
  return conditions.some((condition) => !requested.includes(condition.replace(/(?:ies|y|s)$/, "")));
}

/**
 * The planner already states who the question is about -- for "아이 키 크려면
 * 우유 많이 먹어야 해?" it returned children, school-aged children,
 * prepubertal children, adolescents -- and nothing read that field. A
 * very-low-birth-weight fortifier trial and a haemodialysis cohort were
 * therefore cited as evidence for an ordinary child and an ordinary adult.
 *
 * A result measured in an intensive-care, preterm, dialysis or transplant
 * population does not transfer to someone who did not ask about one, so a
 * title built around such a group is only admissible when the question named
 * it.
 */
function titleTargetsUnrequestedPopulation(paper: Paper, intent: ResearchIntent): boolean {
  const title = paper.title.toLowerCase();
  const groups: Array<[RegExp, RegExp]> = [
    [/\b(?:preterm|premature|very low birth ?weight|extremely low birth ?weight|vlbw|elbw|low birth ?weight)\b/, /preterm|premature|birth ?weight|vlbw|elbw|neonat/i],
    [/\b(?:neonat(?:e|es|al)|newborns?)\b/, /neonat|newborn|infant|영아|신생아/i],
    [/\b(?:h(?:a)?emodialysis|dialysis|end[- ]stage renal|esrd|kidney failure)\b/, /dialysis|renal|kidney|신장|투석/i],
    [/\b(?:critically ill|intensive care|icu|mechanically ventilated|sepsis|septic)\b/, /critical|intensive care|icu|sepsis|중환자/i],
    [/\b(?:transplant(?:ation|ed)?|post[- ]transplant)\b/, /transplant|이식/i],
    [/\b(?:palliative|hospice|terminally ill|end[- ]of[- ]life)\b/, /palliative|hospice|terminal|완화|호스피스/i],
    [/\b(?:chemotherapy|radiotherapy|oncology patients?|cancer patients?|tumou?r patients?)\b/, /chemotherap|radiotherap|cancer|oncolog|tumou?r|암/i],
    [/\b(?:pregnan(?:t|cy)|gestational|lactating|breastfeeding mothers?)\b/, /pregnan|gestation|lactat|breastfeed|임신|수유/i],
    // Reported live: "일찍 자면 키가 클까?" was answered with a foot-warming
    // trial in older adults. A result measured in one age band does not carry
    // to another, in either direction.
    [/\b(?:older adults?|elderly|geriatric|nursing home|aged \d{2}\s*(?:years )?(?:and )?(?:over|older))\b/, /older|elderly|geriatric|aging|고령|노인|성인/i],
    [/\b(?:children|child|paediatric|pediatric|adolescents?|schoolchildren|toddlers?)\b/, /child|p(?:a)?ediatric|adolescen|infant|youth|아동|소아|청소년|아기|아이/i]
  ];
  const requested = [
    ...intent.populationTerms,
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms,
    intent.exposure
  ].join(" ");
  return groups.some(([inTitle, asked]) => inTitle.test(title) && !asked.test(requested));
}

function titleCentersCombinedIntervention(paper: Paper, intent: ResearchIntent): boolean {
  if (intent.questionType === "comparison") return false;
  const title = paper.title.toLowerCase();
  const exposureMentioned = intent.exposureTerms.some((term) => {
    const phrase = normalizePhraseText(term).trim();
    return phrase.length > 0 && normalizePhraseText(title).includes(` ${phrase} `);
  });
  if (!exposureMentioned) return false;
  // A study of "X plus Y" cannot establish X's independent effect. Keep it
  // out unless the user explicitly asked about a combined intervention.
  const combinedWithAnotherIntervention = /\b(?:exercise|training|therapy|treatment|supplement(?:ation)?|medication|drug|hypoxia|dietary restriction|caloric restriction)\b[^.]{0,40}\b(?:and|with|plus)\b|\b(?:and|with|plus)\b[^.]{0,40}\b(?:exercise|training|therapy|treatment|supplement(?:ation)?|medication|drug|hypoxia|dietary restriction|caloric restriction)\b/i.test(title);
  const requestedCombination = intent.exposureTerms.some((term) => /\b(?:and|with|plus)\b/i.test(term));
  return combinedWithAnotherIntervention && !requestedCombination;
}

/**
 * A study about an unrequested co-exposure cannot establish the effect of the
 * item the user named. This catches combinations such as a drink plus alcohol
 * or a treatment plus an illicit substance without maintaining a catalogue of
 * individual consumer products. The modifier remains eligible when the user
 * explicitly included it in the research intent.
 */
function titleCentersUnrequestedCoExposure(paper: Paper, intent: ResearchIntent): boolean {
  const title = paper.title.toLowerCase();
  const requested = [
    intent.exposure,
    ...intent.exposureTerms,
    intent.comparator ?? "",
    ...intent.comparatorTerms,
    ...intent.outcomeTerms
  ].join(" ").toLowerCase();
  const modifiers: Array<{ pattern: RegExp; requestedPattern: RegExp }> = [
    { pattern: /\b(?:alcohol|ethanol|alcoholic(?:\s+beverage)?s?)\b/i, requestedPattern: /\b(?:alcohol|ethanol|alcoholic(?:\s+beverage)?s?)\b/i },
    { pattern: /\b(?:tobacco|nicotine|smok(?:ing|er|ers)?)\b/i, requestedPattern: /\b(?:tobacco|nicotine|smok(?:ing|er|ers)?)\b/i },
    { pattern: /\b(?:cocaine|cannabis|marijuana|amphetamine|opioid|illicit drugs?)\b/i, requestedPattern: /\b(?:cocaine|cannabis|marijuana|amphetamine|opioid|illicit drugs?)\b/i }
  ];
  return modifiers.some(({ pattern, requestedPattern }) => {
    if (!pattern.test(title) || requestedPattern.test(requested)) return false;
    return /\b(?:with|and|combined|combination|mix(?:ed|ing)?|co[- ]?consumption|associated)\b/i.test(title) ||
      /\b(?:caffeinated|stimulant)[ -]?(?:alcoholic|alcohol)\b/i.test(title);
  });
}

function isStudyProtocolPaper(paper: Paper): boolean {
  const text = `${paper.title} ${paper.publicationTypes.join(" ")}`.toLowerCase();
  return /\b(?:study protocol|protocol for (?:a )?(?:systematic review|meta[ -]?analysis)|systematic review(?: and meta[ -]?analysis)? protocol)\b/.test(text);
}

function isSweetenedBeverageBroadIntent(intent: ResearchIntent): boolean {
  return isBroadTopicIntent(intent) && /\b(?:artificially sweetened beverages?|low[- ]?(?:and )?no[- ]?calorie sweetened beverages?|non[- ]?nutritive sweetened beverages?|diet soda)\b/i.test(
    [intent.exposure, ...intent.exposureTerms].join(" ")
  );
}

function namesSweetenedBeverageExposure(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`;
  return /\b(?:artificially sweetened beverages?|asbs?|low[- ]?(?:and )?no[- ]?calorie sweetened beverages?|low[- ]?energy sweetened beverages?|non[- ]?nutritive sweetened beverages?|diet (?:soda|soft drinks?|beverages?)|zero[- ]?calorie (?:soft drinks?|beverages?)|non[- ]?sugar sweeteners?)\b/i.test(text);
}

function isFoodDietBroadIntent(intent: ResearchIntent): boolean {
  return isBroadTopicIntent(intent) && /\b(?:diet|dietary|nutrition|nutritional|food|foods)\b/i.test(
    [intent.exposure, ...intent.exposureTerms].join(" ")
  );
}

function matchesFoodDietTopic(paper: Paper, intent: ResearchIntent): boolean {
  const title = normalizePhraseText(paper.title);
  if (!/\b(?:diet|dietary|nutrition|nutritional|food|foods)\b/i.test(paper.title)) return false;
  const asksAboutAging = /\b(?:aging|ageing|longevity|healthspan|age-related)\b/i.test(
    [intent.exposure, ...intent.exposureTerms, ...(intent.contextualEvidenceTerms ?? [])].join(" ")
  );
  if (asksAboutAging && !/\b(?:aging|ageing|longevity|healthspan|age-related|frailty|sarcopenia|older adults?)\b/i.test(`${paper.title} ${paper.abstract ?? ""}`)) {
    return false;
  }
  const genericTokens = new Set([
    "diet", "dietary", "nutrition", "nutritional", "food", "foods",
    "healthy", "health", "effects", "effect", "outcomes", "outcome",
    "intervention", "interventions", "pattern", "patterns", "related", "general"
  ]);
  const toAnchors = (terms: string[]) => terms
    .flatMap((term) => normalizePhraseText(term).trim().split(" "))
    .filter((token) => token.length >= 4 && !genericTokens.has(token));
  const primaryAnchors = toAnchors(intent.exposureTerms);
  if (primaryAnchors.some((token) => title.includes(` ${token} `))) return true;
  return (intent.contextualEvidenceTerms ?? []).some((bridge) => {
    const bridgeAnchors = toAnchors([bridge]);
    return bridgeAnchors.length > 0 &&
      bridgeAnchors.filter((token) => title.includes(` ${token} `)).length >= Math.min(2, bridgeAnchors.length);
  });
}

function isLowTrustScholarlySource(paper: Paper): boolean {
  const source = `${paper.title} ${paper.venue ?? ""} ${paper.publisher ?? ""}`.toLowerCase();
  // Debate resolutions and pro/con position pieces can be useful background,
  // but are not primary or synthesis evidence to use as a representative
  // paper. This is a publication-form rule, independent of subject matter.
  const title = paper.title.toLowerCase();
  return /\b(?:undergraduate|student)\b[^.]{0,80}\bresearch journal\b/.test(source) ||
    /^\s*(?:resolved|debate|pro\s*(?:\/|and)\s*con)\s*:/i.test(title);
}

function matchesPrimaryBroadContext(paper: Paper, intent: ResearchIntent): boolean {
  const genericTokens = new Set([
    "health", "human", "effects", "effect", "benefits", "benefit", "outcomes", "outcome",
    "study", "studies", "review", "clinical", "adults", "people", "exposure", "environmental", "nature"
  ]);
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return (intent.contextualEvidenceTerms ?? []).some((bridge) => {
    const bridgeTokens = normalizePhraseText(bridge)
      .trim()
      .split(" ")
      .filter((token) => token.length >= 4 && !genericTokens.has(token));
    if (bridgeTokens.length === 0) return false;
    const requiredHits = Math.min(2, bridgeTokens.length);
    return bridgeTokens.filter((token) => tokenMatches(text, token)).length >= requiredHits;
  });
}

/**
 * A one-word exposure can coincide with an author or statistical method
 * mentioned in an abstract (for example, a food name inside "random-effects
 * model"). That is not evidence about the exposure. Reject the method-name
 * context before broad-topic ranking so it cannot be promoted by a keyword
 * match alone.
 */
function hasEntityMethodNameCollision(paper: Paper, exposureTerms: string[]): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return exposureTerms.some((term) => {
    const normalized = term.trim().toLowerCase();
    if (!/^[a-z][a-z-]{2,}$/i.test(normalized)) return false;
    const escaped = escapeRegExp(normalized);
    return new RegExp(
      `\\b(?:dersimonian(?:\s+and)?\s+)?${escaped}\\b\\s+(?:random|fixed|mixed|bayesian)\\s+effects?\\s+(?:model|analysis)|\\b${escaped}\\s+random[- ]effects?\\s+(?:model|analysis)`,
      "i"
    ).test(text);
  });
}

function isMaterialOrEngineeringPaper(paper: Paper): boolean {
  // These papers can be highly relevant to making or delivering a substance,
  // but they do not establish a health effect in people. Keep the rule tied to
  // a title-level primary subject so an abstract's incidental use of
  // "formulation" does not hide a clinical paper.
  const title = paper.title;
  if (/\b(?:composite|controlled[- ]release|encapsulat(?:ion|ed)|formulation|packaging|coating|fabrication|synthesis|material(?:s)?|engineering|biodiesel|biofuel|combustion|transesterification|extraction)\b/i.test(title)) {
    return true;
  }
  // A paper about making, storing, or tasting a consumer product does not
  // establish the product's effect on people. This excludes the same failure
  // mode for every food, cosmetic, and supplement rather than naming any one
  // item. Human trials remain eligible even if their title mentions a food.
  const text = `${title} ${paper.abstract ?? ""}`;
  const foodProductTitle = /\b(?:food|meat|sausage|burger|meatball|beverage|drink|dairy|cheese|yog(?:h)?urt|snack|bakery|margarine|butter|spread|edible oil|cooking oil|animal fat|rendered fat|fats?|oils?)\b/i.test(title);
  const productionOperation = /\b(?:develop(?:ment|ed|ing)?|formulat(?:ion|ed|ing)?|manufactur(?:e|ing)|optimis(?:e|ed|ing|ation)|quality|sensory|shelf[- ]?life|storage|technological|bioprotective)\b/i.test(text);
  const productionFocus = /(?:\b(?:product development|manufactur(?:e|ing)|food quality|sensory evaluation|shelf[- ]?life|storage stability|technological|bioprotective)\b|(?:제조|품질|개발|저장성|관능|보존))/i.test(text) ||
    (foodProductTitle && productionOperation);
  const foodScienceMarkers = title.match(/\b(?:preservative|physicochemical|antimicrobial|antioxidant)\b/gi) ?? [];
  const productDevelopment = productionFocus || foodScienceMarkers.length >= 2;
  const humanOutcomeStudy = /\b(?:participants?|patients?|adults?|children|cohort|randomi[sz]ed|clinical trial|epidemiolog(?:y|ical)|incidence|mortality)\b/i.test(text);
  const explicitHealthFocus = /\b(?:health effects?|health impact|health benefits?|human health|clinical effects?)\b/i.test(title);
  return productDevelopment && !humanOutcomeStudy && !explicitHealthFocus;
}

function isFoodSupplyOrCompositionPaper(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  // Food and agricultural indexes routinely return studies about producing a
  // food, changing an animal's feed, or measuring a product's composition.
  // Those records are useful to a manufacturer but cannot answer whether a
  // person benefits or is harmed by eating the item.
  const supplyOrProductionFocus = /\b(?:life[- ]?cycle(?: assessment)?|supply chains?|sustainability|environmental impact|carbon footprint|animal welfare|livestock production|farm(?:ed|ing)?|slaughter(?:house)?|carcass traits?|meat quality|feed(?:ing|stuff)?|dietary inclusion|feed[- ]?to[- ]?gain|growth performance|animal production|pet food)\b/.test(text);
  const compositionFocus = /\b(?:fatty acid composition|nutritional composition|proximate composition|chemical composition|lipid profile|source of (?:omega|n[- ]?3|n[- ]?6)|enrich(?:ed|ment) (?:with|of) (?:omega|n[- ]?3|n[- ]?6)|fortif(?:ied|ication)|nutrient content|meat composition)\b/.test(text);
  if (!supplyOrProductionFocus && !compositionFocus) return false;

  // A real human outcome study can mention an exposure's composition while
  // reporting LDL, blood pressure, disease incidence, etc. Do not reject it
  // merely because that context appears in the abstract.
  const humanOutcomeStudy = /\b(?:human(?:s)?|participant(?:s)?|subject(?:s)?|adult(?:s)?|child(?:ren)?|patient(?:s)?|volunteer(?:s)?|men|women|cohort|case[- ]?control|randomi[sz]ed|clinical trial|epidemiolog(?:y|ical)|prospective|incidence|mortality)\b/.test(text) &&
    /\b(?:ldl|cholesterol|blood pressure|glucose|insulin|body weight|cardiovascular|disease|mortality|adverse|symptom|risk)\b/.test(text);
  const healthReview = isTopicLevelReview(paper) &&
    /\b(?:health|disease|mortality|cardiovascular|cholesterol|glucose|blood pressure|weight|adverse)\b/.test(text);
  return !humanOutcomeStudy && !healthReview;
}

function isDietaryExposureCharacterizationPaper(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  // Measuring a diet score, metabolite signature, questionnaire, or food
  // frequency pattern can be useful for future research, but it does not
  // establish whether the asked food or nutrient helps or harms people. Keep
  // studies that make a clinical endpoint their actual title-level question.
  const characterisation = /\b(?:identif(?:y|ying|ication)|characteri[sz](?:e|ing|ation)|profil(?:e|ing)|validat(?:e|ion)|assess(?:ment|ing))\b.{0,100}\b(?:biomarkers?|metabolom(?:ics|e)|metabolites?|dietary patterns?|diet quality|food frequency|dietary assessment)\b|\b(?:biomarkers?|metabolom(?:ics|e)|metabolites?)\b.{0,100}\b(?:dietary patterns?|diet quality|food frequency)\b/.test(title);
  if (!characterisation) return false;
  const clinicalEndpointInTitle = /\b(?:cardiovascular|coronary|stroke|mortality|cancer|diabetes|hypertension|blood pressure|cholesterol|glucose|insulin|body weight|adverse|symptom|disease risk)\b/.test(title);
  return !clinicalEndpointInTitle;
}

function isFoodProcessingOrPreservationPaper(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  // Food ingredients are frequently the material being stored, fermented, or
  // tested for spoilage. Those studies can contain p-values and even the word
  // "health" in their discussion, but do not measure the consumer health
  // effect of eating the ingredient.
  const processingFocus = /\b(?:rancidification|rancidity|oxidative stability|peroxide value|acid value|shelf[- ]?life|storage stability|food preservation|preserv(?:ation|ative)|spoilage|food packaging|coated? films?|film coating|starter culture|metagenomic analysis|microbiological quality|sensory evaluation)\b/.test(text);
  if (!processingFocus) return false;
  const humanStudy = /\b(?:human(?:s)?|participant(?:s)?|subject(?:s)?|adult(?:s)?|child(?:ren)?|patient(?:s)?|volunteer(?:s)?|cohort|randomi[sz]ed|clinical trial|epidemiolog(?:y|ical))\b/.test(text);
  const healthReview = isTopicLevelReview(paper) && /\b(?:health|disease|mortality|cardiovascular|cholesterol|glucose|blood pressure|weight|adverse)\b/.test(text);
  return !humanStudy && !healthReview && /\b(?:food|meat|fat|oil|lard|sausage|beverage|drink|dairy|cheese|yog(?:h)?urt|snack|bakery|ferment(?:ed|ation)?)\b/.test(title);
}

function isExposureAssessmentPaper(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`.toLowerCase();
  // Exposure and chemical-risk assessments can be useful for regulators, but
  // they do not answer a consumer's health-outcome question. Their calculated
  // intake, BMDL, or margin-of-exposure values must not occupy a slot ahead of
  // a cohort, trial, or review that actually measures disease or symptoms.
  const assessmentFocus = /\b(?:dietary intake and risk assessment|exposure assessment|risk assessment of|estimated daily intake|margin of exposure|\bmoe\b|\bbmdl\d*\b|occurrence and risk assessment|contaminant occurrence)\b/.test(title);
  if (!assessmentFocus) return false;
  const outcomeDesign = /\b(?:systematic review|meta[ -]?analysis|umbrella review|randomi[sz]ed|clinical trial|cohort|case-control|prospective|incidence|mortality)\b/.test(text);
  return !outcomeDesign;
}

function isClearlyNonHealthPaper(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const mathematicalTopic = /\b(?:brownian|branching process|stochastic|random walk|markov chain|probability theory|graph theory|differential equation|algebraic)\b/.test(title);
  if (!mathematicalTopic) return false;
  const healthContext = /\b(?:health|human|patient|clinical|disease|nutrition|dietary|food intake|exercise|drug|treatment)\b/.test(
    `${paper.title} ${paper.abstract ?? ""}`.toLowerCase()
  );
  return !healthContext;
}

function hasDifferentPrimaryOutcome(paper: Paper, intent: ResearchIntent): boolean {
  const titlePaper = { ...paper, abstract: undefined };
  const titleNamesRequestedOutcome = intent.outcomeTerms.length === 0 ||
    matchesDirectConcept(titlePaper, intent.outcomeTerms) ||
    matchesAnyConcept(titlePaper, intent.outcomeTerms, 2);
  // An endpoint named in the title is the paper's primary question. Do not
  // accept it just because its abstract mentions the user's outcome as a
  // covariate or background risk factor (for example, liver-cancer research
  // in a diabetes search).
  // Body-size endpoints were missing from this list, so a question about
  // growing taller kept being answered by weight research: "Does Bedtime
  // Really Matter? Examining How Sleep Timing Relates to Sleep Duration and
  // Overweight Status" was cited for "일찍 자면 키가 클까?". They only count as
  // competing when the reader did not ask about them, which the check below
  // already establishes.
  const otherEndpoint = /\b(?:cancer|tumou?r|mortality|cardiovascular|coronary|stroke|hypertension|blood pressure|liver disease|kidney disease|depression|anxiety|cognitive|sleep|fertility|alopecia|hair loss|pancreatitis|retinopathy|gallbladder|fracture|bone density|overweight|obesity|obese|adiposity|body mass|bmi|body fat|weight gain|weight loss|waist circumference)\b/i.exec(paper.title);
  // The list above names endpoints that compete with the user's. It must not
  // fire on the thing the user is asking about: "일찍 자면 키가 클까?" made
  // every paper with "sleep" in the title look like a study of a different
  // question, and "Sleep and weight-height development" was discarded.
  // Only the endpoint the reader asked for is exempt. Exempting the exposure
  // too let a paper whose outcome is the exposure through: "일찍 자면 키가
  // 클까?" cited "Nutritional Modulation of Sleep Latency, Duration, and
  // Efficiency", a study of what changes sleep rather than what sleep changes.
  const namesOwnSubject = otherEndpoint !== null &&
    intent.outcomeTerms.join(" ").toLowerCase().includes(otherEndpoint[0].toLowerCase());
  if (otherEndpoint && !namesOwnSubject && !titleNamesRequestedOutcome) return true;
  const asksAboutWeight = intent.outcomeTerms.some((term) => /(?:weight|obesity|bmi|fat loss|body composition)/i.test(term));
  if (!asksAboutWeight) return false;
  // A paper can mention weight loss as a covariate while actually studying a
  // drug adverse event. It cannot support a weight-loss efficacy conclusion.
  return /\b(?:alopecia|hair loss|ketoacidosis|pancreatitis|retinopathy|gallbladder)\b/i.test(paper.title);
}

function isSafetyIntent(intent: ResearchIntent): boolean {
  return intent.questionType === "safety" || intent.outcomeTerms.some((term) =>
    /(?:adverse|side effect|safety|tolerability|toxicity|harm|risk|contraindication|interaction)/i.test(term)
  );
}

function reportsSafetyOutcome(paper: Paper, intent: ResearchIntent): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  if (/\b(?:adverse events?|side effects?|adverse reactions?|serious adverse|drug safety|safety profile|tolerability|toxicity|contraindicat(?:ion|ed)|drug interaction|increased risk|higher risk|excess risk|worsen(?:ed|ing)?|deteriorat(?:ed|ion)?)\b/.test(text)) {
    return true;
  }
  // When the user names a concrete harm (for example pancreatitis), accept a
  // paper only if that endpoint is measured and reported, not when it merely
  // appears as a background condition.
  return matchesAnyConcept(paper, intent.outcomeTerms, 2) &&
    /\b(?:results?|conclusion|found|observed|measured|evaluated|significant(?:ly)?|higher|lower|increased|decreased|greater|less|associated)\b/.test(text);
}

function rankParallelComparisonPapers(
  papers: Paper[],
  intent: ResearchIntent,
  terms: string[]
): Paper[] {
  const foodProteinIntent = isFoodProteinQualityIntent(intent);
  const matchesExposureEvidence = (paper: Paper): boolean => foodProteinIntent
    ? matchesFoodProteinOptionEvidence(paper, intent.exposure, intent.exposureTerms)
    : matchesComparisonOption({ ...paper, abstract: undefined }, intent.exposure, intent.exposureTerms);
  const matchesComparatorEvidence = (paper: Paper): boolean => foodProteinIntent
    ? matchesFoodProteinOptionEvidence(paper, intent.comparator, intent.comparatorTerms)
    : matchesComparisonOption({ ...paper, abstract: undefined }, intent.comparator, intent.comparatorTerms);
  const score = (paper: Paper) => {
    const namesBoth = matchesExposureEvidence(paper) && matchesComparatorEvidence(paper);
    const titleNamesBoth = namesBoth && namedOptionsMatchTitle(paper, intent.exposureTerms, intent.comparatorTerms);
    const titleNamesExposure = matchesExposureEvidence(paper);
    const titleNamesComparator = matchesComparatorEvidence(paper);
    const titleNamesOutcome = matchesAnyConcept({ ...paper, abstract: undefined }, intent.outcomeTerms, 2);
    const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
    const narrativePenalty = /\b(?:narrative review|perspective|commentary|editorial|study protocol)\b/.test(text) ? 70 : 0;
    // When no head-to-head paper exists, a paper needs to be useful for one
    // side of the user's comparison. An option-specific title tied to the
    // requested outcome is more informative than a broad review that merely
    // lists both options among many examples.
    const optionSpecificity = (titleNamesExposure || titleNamesComparator ? 70 : 0) +
      (titleNamesOutcome ? 80 : 0) +
      ((titleNamesExposure || titleNamesComparator) && titleNamesOutcome ? 120 : 0);
    // For a comparison, a study that actually includes both named options is
    // more useful than a newer paper about one option in an unusual product
    // matrix. It still follows a true head-to-head study, if there is one.
    return scorePaper(paper, terms, [], terms) + optionSpecificity +
      (namesBoth ? 120 : 0) + (titleNamesBoth ? 60 : 0) - narrativePenalty;
  };
  const byExposure = papers
    .filter(matchesExposureEvidence)
    .sort((left, right) => score(right) - score(left));
  const byComparator = papers
    .filter(matchesComparatorEvidence)
    .sort((left, right) => score(right) - score(left));
  const sideBySide = [
    byExposure[0],
    byComparator[0],
    byExposure[1],
    byComparator[1],
    byExposure[2],
    byComparator[2]
  ].filter((paper): paper is Paper => Boolean(paper));
  return uniquePapers([
    ...sideBySide,
    ...papers.sort((left, right) => score(right) - score(left))
  ]);
}

function matchesComparisonOption(paper: Paper, canonical: string | undefined, terms: string[]): boolean {
  if (canonical && matchesNamedOption(paper, [canonical])) return true;
  return terms
    .filter((term) => !isBroadComparisonAlias(term))
    .some((term) => matchesNamedOption(paper, [term]));
}

function isBroadComparisonAlias(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return /^(?:foods?|food products?|dairy(?: products?)?|fermented dairy|fermented milk products?|dietary supplements?|supplements?|health products?|consumer products?|physical activity|exercise|therapy|treatment|medication|intervention)$/i.test(normalized);
}

function namedOptionsMatchTitle(paper: Paper, exposureTerms: string[], comparatorTerms: string[]): boolean {
  const titlePaper = { ...paper, abstract: undefined };
  return matchesNamedOption(titlePaper, exposureTerms) && matchesNamedOption(titlePaper, comparatorTerms);
}

function hasExplicitComparison(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:compar(?:e|ed|ing|ison)|versus|vs\.?|relative to|compared with|compared to|between.{0,80}(?:and|versus))\b|\b(?:replace(?:d|ment|ing)?|substitut(?:e|ed|ion|ing))\b.{0,50}\b(?:with|instead of|by)\b/i.test(text);
}

function hasNamedHeadToHeadComparison(paper: Paper, intent: ResearchIntent): boolean {
  if (!matchesNamedOption(paper, intent.exposureTerms) || !matchesNamedOption(paper, intent.comparatorTerms)) {
    return false;
  }

  const titlePaper = { ...paper, abstract: undefined };
  const titleNamesBoth = matchesNamedOption(titlePaper, intent.exposureTerms) &&
    matchesNamedOption(titlePaper, intent.comparatorTerms);
  // A comparison mentioned in an abstract's background is not a head-to-head
  // result. Requiring both named options in the title prevents broad reviews
  // from becoming a fabricated direct comparison of the user's two choices.
  if (!titleNamesBoth) return false;

  // Food-quality studies sometimes report a table-like list of values rather
  // than writing "A versus B". Retain those only when both named foods have a
  // measured protein-quality value; cooking studies that merely include both
  // foods remain parallel/contextual evidence.
  if (isFoodProteinQualityIntent(intent) && hasNamedFoodMetricComparison(paper, intent)) {
    return true;
  }

  const title = normalizePhraseText(paper.title);
  if (titleNamesBoth && hasComparisonSignal(paper.title)) return true;

  const sentences = `${paper.title}. ${paper.abstract ?? ""}`
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    const normalized = normalizePhraseText(sentence);
    return optionMatchesText(normalized, intent.exposureTerms) &&
      optionMatchesText(normalized, intent.comparatorTerms) &&
      hasComparisonSignal(sentence);
  });
}

function optionMatchesText(normalizedText: string, concepts: string[]): boolean {
  return concepts.some((concept) => {
    const normalizedConcept = normalizePhraseText(concept).trim();
    if (!normalizedConcept) return false;
    const tokens = normalizedConcept.split(" ").filter(Boolean);
    return tokens.length === 1
      ? tokenMatches(normalizedText, tokens[0]!)
      : normalizedText.includes(` ${normalizedConcept} `);
  });
}

function hasComparisonSignal(value: string): boolean {
  return /\b(?:versus|vs\.?|compared\s+(?:with|to)|comparison\s+of|comparative|difference(?:s)?\s+between|higher\s+than|lower\s+than|greater\s+than|less\s+than|superior\s+to|inferior\s+to|outperformed|replac(?:e|ed|ing|ement).{0,50}\bwith|substitut(?:e|ed|ing|ion).{0,50}\bwith)\b/i.test(value);
}

function hasNamedFoodMetricComparison(paper: Paper, intent: ResearchIntent): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`;
  if (!hasFoodProteinQualitySignal(text.toLowerCase())) return false;
  return optionHasNearbyNumericValue(text, intent.exposureTerms) &&
    optionHasNearbyNumericValue(text, intent.comparatorTerms);
}

function optionHasNearbyNumericValue(text: string, concepts: string[]): boolean {
  return concepts.some((concept) => {
    const tokens = concept
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter(Boolean);
    if (tokens.length === 0) return false;
    const expression = tokens.map(escapeRegExp).join("\\s+");
    return new RegExp(`\\b${expression}\\b(?:\\s+[a-z-]+){0,10}\\s*(?:\\(|:|=)?\\s*\\d+(?:\\.\\d+)?`, "i").test(text);
  });
}

function isCookingFatIntent(intent: ResearchIntent): boolean {
  return /\b(?:fat|oil)\b/i.test([intent.exposure, ...intent.exposureTerms].join(" "));
}

function hasDietaryFatReplacementSignal(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:replac(?:e|ed|ing|ement)|substitut(?:e|ed|ing|ion)|reduc(?:e|ed|ing|tion)|modif(?:y|ied|ying|ication))\b.{0,80}\b(?:dietary\s+)?(?:saturated|unsaturated|polyunsaturated|monounsaturated|trans)?\s*fat\b|\b(?:saturated|unsaturated|polyunsaturated|monounsaturated|trans)\s+fat\b.{0,80}\b(?:replac|substitut|reduc|modif)/i.test(text);
}

function matchesCookingFatCharacterization(paper: Paper, intent: ResearchIntent): boolean {
  if (!namedExposureMatchesTitle(paper, intent.exposureTerms)) return false;
  return /\b(?:composition|fatty acid|lipid profile|oxidation|oxidative|biomarker|dose)\b/i.test(`${paper.title} ${paper.abstract ?? ""}`);
}

function matchesCookingFatParentEvidence(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  return /\b(?:fat|lipid)\b/.test(title) &&
    /\b(?:cardiovascular|cholesterol|cardiometabolic|metabolic)\b/.test(title) &&
    hasDietaryFatReplacementSignal(paper);
}

function evidenceLadderScore(
  paper: Paper,
  intent: ResearchIntent,
  highValueTokens: string[]
): number {
  const layerScore = matchesDirectIntent(paper, intent)
    ? 160
    : matchesAnyConcept(paper, intent.directContextTerms ?? [], 3)
      ? 130
      : matchesContextualIntent(paper, intent)
        ? 90
        : 30;
  const bridgeIndex = (intent.contextualEvidenceTerms ?? []).findIndex((term) =>
    matchesPlannedBridgeTitle(paper, [term])
  );
  // The model orders bridges from the closest parent topic to broader
  // context. Keep that priority so a generic diet paper cannot displace the
  // planned parent-topic review just because it is newer.
  const bridgePreference = bridgeIndex < 0 ? 0 : Math.max(0, 80 - bridgeIndex * 20);
  return layerScore + bridgePreference + scorePaper(paper, highValueTokens);
}

function namedExposureMatches(paper: Paper, exposureTerms: string[]): boolean {
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return exposureTerms.some((term) => {
    const tokens = term.split(/[^a-z0-9가-힣]+/i).filter(Boolean);
    return tokens.length >= 2 && textMatchesPhrase(text, term);
  });
}

function namedExposureMatchesTitle(paper: Paper, exposureTerms: string[]): boolean {
  const text = normalizePhraseText(paper.title);
  return exposureTerms.some((term) => {
    const tokens = term.split(/[^a-z0-9가-힣]+/i).filter(Boolean);
    return tokens.length >= 2 && textMatchesPhrase(text, term);
  });
}

function matchesAnyConcept(paper: Paper, concepts: string[], minimumTokenHits = 2): boolean {
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return concepts.some((concept) => {
    if (textMatchesPhrase(text, concept)) return true;
    const tokens = concept
      .split(/[^a-z0-9가-힣]+/i)
      .filter((token) => token.length >= 4 && !rankingStopwords.has(token) && !intentConceptStopwords.has(token));
    const requiredHits = Math.min(minimumTokenHits, tokens.length);
    return requiredHits > 0 && tokens.filter((token) => tokenMatches(text, token)).length >= requiredHits;
  });
}

function matchesNamedOption(paper: Paper, concepts: string[]): boolean {
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return concepts.some((concept) => {
    if (textMatchesPhrase(text, concept)) return true;
    const rawTokens = concept
      .split(/[^a-z0-9가-힣]+/i)
      .filter(Boolean);
    const tokens = rawTokens
      .filter((token) => token.length >= 4 && !rankingStopwords.has(token) && !intentConceptStopwords.has(token));
    if (tokens.length === 0) return false;
    return rawTokens.length === 1 ? tokenMatches(text, tokens[0]!) : textMatchesPhrase(text, concept);
  });
}

function matchesDirectConcept(paper: Paper, concepts: string[]): boolean {
  const text = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""}`);
  return concepts.some((concept) => {
    if (textMatchesPhrase(text, concept)) return true;
    if (isWeightChangeConcept(concept) && /\b(?:weight loss|weight reduction|weight change|change in weight|percent change in weight|weight (?:was|were)? (?:lower|reduced|decreased))\b/.test(text)) {
      return true;
    }
    const rawTokens = concept
      .split(/[^a-z0-9가-힣]+/i)
      .filter(Boolean);
    const tokens = rawTokens
      .filter((token) => token.length >= 4 &&
        !rankingStopwords.has(token) &&
        !intentConceptStopwords.has(token) &&
        !directConceptQualifierStopwords.has(token));
    if (tokens.length === 0) return false;
    return tokens.length === 1
      ? tokenMatches(text, tokens[0]!)
      : tokens.every((token) => tokenMatches(text, token));
  });
}

function isWeightChangeConcept(concept: string): boolean {
  return /(?:weight\s*(?:loss|reduction)|body\s*weight\s*reduction)/i.test(concept);
}

function uniquePapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = `${paper.source}:${paper.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Providers do not classify publication types consistently. Normalize the
 * tier once and reuse it after grounding as well, so a review returned by a
 * retry cannot silently become an unclassified "research document" later in
 * the pipeline.
 */
export function normalizeEvidenceLevel(paper: Paper): Paper {
  if (isPreprintPaper(paper)) {
    return paper.evidenceLevel === "preprint" ? paper : { ...paper, evidenceLevel: "preprint" };
  }
  // Metadata providers occasionally label an umbrella/systematic review as a
  // clinical article. The title is explicit enough to promote that evidence
  // tier, while a title never demotes a stronger provider classification.
  const titleInferred = inferEvidenceLevel([paper.title], paper.source);
  if (titleInferred === "systematic_review" && paper.evidenceLevel !== "systematic_review") {
    return { ...paper, evidenceLevel: "systematic_review" };
  }
  if (paper.evidenceLevel !== "unknown") return paper;
  const inferred = inferEvidenceLevel(
    [...paper.publicationTypes, paper.title],
    paper.source
  );
  if (inferred !== "unknown") return { ...paper, evidenceLevel: inferred };

  const abstract = paper.abstract?.toLowerCase() ?? "";
  if (/\b(?:randomi[sz]ed|controlled (?:clinical )?trial|crossover trial|placebo-controlled|intervention study)\b/.test(abstract)) {
    return { ...paper, evidenceLevel: "clinical_study" };
  }
  if (/\b(?:prospective cohort|retrospective cohort|case-control|cross-sectional|observational study)\b/.test(abstract)) {
    return { ...paper, evidenceLevel: "observational_study" };
  }
  return paper;
}

function preferDirectClassifiedEvidence(papers: Paper[], intent: ResearchIntent | undefined): Paper[] {
  if (!intent || papers.length === 0) return papers;
  const directTerms = directExposureTerms(intent);
  if (intent.evidenceStrategy === "direct_then_contextual") {
    return papers.filter((paper) => {
      return Boolean(
        canonicalExposureTermsMatch(paper, directTerms) ||
        matchesAnyConcept(paper, intent.directContextTerms ?? []) ||
        matchesAnyConcept(paper, intent.parentEvidenceTerms ?? [])
      );
    });
  }
  const classified = papers.filter((paper) => paper.evidenceLevel !== "unknown");
  const directClassified = directTerms.length > 0
    ? classified.filter((paper) => canonicalExposureTermsMatch(paper, directTerms))
    : classified;

  if (directClassified.length === 0) {
    const direct = directTerms.length > 0
      ? papers.filter((paper) => canonicalExposureTermsMatch(paper, directTerms))
      : papers;
    return direct;
  }

  const preferred = directClassified;
  const seen = new Set<string>();
  return preferred.filter((paper) => {
    const key = `${paper.source}:${paper.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalExposureTermsMatch(paper: Paper, exposureTerms: string[]): boolean {
  return exposureTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .some((term) => canonicalExposureMatches(paper, term));
}

function canonicalExposureMatches(paper: Paper, exposure: string): boolean {
  const tokens = [...new Set(
    exposure
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter(Boolean)
      .filter((token) => !exposureQualifierStopwords.has(token))
  )];
  if (tokens.length === 0) return false;
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} `.toLowerCase();
  const requiredHits = Math.min(2, tokens.length);
  return tokens.filter((token) => tokenMatches(haystack, token)).length >= requiredHits;
}

function extractIntentAnchorGroups(intent: ResearchIntent | undefined): string[][] {
  if (!intent) return [];
  const exposureTokens = conceptTokens(intent.exposureTerms);
  const distinctComparatorTerms = intent.questionType === "comparison"
    ? intent.comparatorTerms.filter((term) =>
        [...conceptTokens([term])].some((token) => !exposureTokens.has(token) && !genericComparatorTokens.has(token))
      )
    : [];
  return [intent.exposureTerms, distinctComparatorTerms, intent.outcomeTerms]
    .map((terms) => terms.map((term) => term.trim().toLowerCase()).filter(isUsefulIntentConcept))
    .filter((group) => group.length > 0);
}

function conceptTokens(terms: string[]): Set<string> {
  return new Set(
    terms.flatMap((term) =>
      term
        .toLowerCase()
        .split(/[^a-z0-9가-힣]+/)
        .filter(Boolean)
        .filter((token) => !intentConceptStopwords.has(token))
    )
  );
}

function isUsefulIntentConcept(term: string): boolean {
  const tokens = term.split(/[^a-z0-9가-힣]+/).filter(Boolean).filter((token) => !intentConceptStopwords.has(token));
  return tokens.length > 0;
}

function conceptGroupMatches(paper: Paper, phrases: string[]): boolean {
  return conceptGroupMatchesText(`${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`, phrases);
}

function conceptGroupMatchesTitle(paper: Paper, phrases: string[]): boolean {
  return conceptGroupMatchesText(paper.title, phrases);
}

function conceptGroupMatchesText(value: string, phrases: string[]): boolean {
  const normalized = normalizePhraseText(value);
  if (phrases.some((phrase) => textMatchesPhrase(normalized, phrase))) return true;
  const haystack = ` ${value} `.toLowerCase();
  return phrases.some((phrase) => {
    const tokens = [...new Set(
      phrase
        .split(/[^a-z0-9가-힣]+/)
        .filter(Boolean)
        .filter((token) => !rankingStopwords.has(token) && !intentConceptStopwords.has(token))
    )];
    const requiredHits = Math.min(2, tokens.length);
    return requiredHits > 0 && tokens.filter((token) => tokenMatches(haystack, token)).length >= requiredHits;
  });
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
  const haystack = normalizePhraseText(`${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`);
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
  return ` ${normalizeScholarlyAbbreviations(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function textMatchesPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeScholarlyAbbreviations(phrase)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizedText.includes(` ${normalizedPhrase} `);
}

function normalizeScholarlyAbbreviations(value: string): string {
  // These are field-wide aliases used in paper titles, not topic-specific
  // assumptions. Expanding them before relevance matching prevents a valid
  // CVD/CHD review from losing to an older paper that spells every word out.
  return value
    .replace(/\bCVD\b/gi, "cardiovascular disease")
    .replace(/\bCHD\b/gi, "coronary heart disease")
    .replace(/\bLDL-?C\b/gi, "LDL cholesterol")
    .replace(/\bLDL\b/gi, "LDL cholesterol");
}

function isAnimalOnlyPaper(paper: Paper): boolean {
  const haystack = ` ${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")} `.toLowerCase();
  const title = paper.title.toLowerCase();
  // A title that explicitly says animal model, murine, or rodent is not a
  // human outcome study even if its background paragraph also mentions human
  // patients. Direct food-composition assays are handled as a narrow exception
  // by isDirectFoodProteinQualityAssay above.
  if (/\b(?:animal models?|murine|rodent|mice|rats?|laying hens?|hens?|chicks?|quails?|rabbits?|guinea pigs?|hamsters?|cattle|bovine|ovine|sheep|goats?|swine|pigs?|piglets?|barrows?|gilts?|sows?|boars?|nonhuman primates?|macaques?)\b/.test(title)) {
    return true;
  }
  if (/\bducks?\b/.test(haystack) && !/\b(?:rendered\s+)?duck\s+fat\b/.test(haystack)) return true;
  if (/\b(?:broiler|poultry|chicken|duck|ducks)\b/.test(haystack) && /\b(?:growth performance|feed-to-gain|dietary inclusion|breast muscle|carcass traits|animal production|companion animal|pet food)\b/.test(haystack)) {
    return true;
  }
  // "chicken" and "poultry" can describe food on a plate, not an animal
  // experiment. Keep them out of this broad filter; the production-study
  // rule above still removes broiler and feed trials.
  if (!/\b(nonhuman|non-human|macaque|primate|mouse|mice|rat|rats|zebrafish|broiler|chicks?|quails?|laying hens?|hens?|rabbits?|guinea pigs?|hamsters?|cattle|bovine|ovine|sheep|goats?|canine|dog|swine|piglets?|barrows?|gilts?|sows?|boars?|animal model)\b/.test(haystack)) return false;
  return !/(human infants|children|child|toddler|pediatric|participant|patient|caregiver)/.test(haystack);
}

function isDirectFoodProteinQualityAssay(paper: Paper, intent: ResearchIntent | undefined): boolean {
  if (!intent || intent.questionType !== "comparison" || !isFoodProteinQualityIntent(intent)) return false;
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  if (!isFoodProteinConsumerStudy(paper, intent)) return false;
  return matchesNamedOption(paper, intent.exposureTerms) &&
    matchesNamedOption(paper, intent.comparatorTerms) &&
    hasFoodProteinQualitySignal(text);
}

function isFoodProteinMetricAssay(paper: Paper, intent: ResearchIntent | undefined): boolean {
  if (!intent || intent.questionType !== "comparison" || !isFoodProteinQualityIntent(intent)) return false;
  if (!isFoodProteinConsumerStudy(paper, intent)) return false;
  const namesRequestedFood = matchesComparisonOption(paper, intent.exposure, intent.exposureTerms) ||
    matchesComparisonOption(paper, intent.comparator, intent.comparatorTerms);
  return namesRequestedFood && hasFoodProteinQualitySignal(`${paper.title} ${paper.abstract ?? ""}`.toLowerCase());
}

function isFoodProteinQualityIntent(intent: ResearchIntent): boolean {
  return intent.outcomeTerms.some((term) =>
    /(?:protein\s*(?:quality|digestibility|bioaccessibility|content|efficiency)|amino\s+acid|diaas|essential\s+amino)/i.test(term)
  );
}

function hasFoodProteinQualitySignal(text: string): boolean {
  // Bare "protein" and "protein synthesis" occur constantly in virology,
  // genetics, and food processing papers. A nutrition comparison needs an
  // actual food-protein metric, or explicitly muscle protein synthesis.
  return /\b(?:protein\s*(?:quality|digestibility|bioaccessibility|content|efficiency)|muscle\s+protein\s+synthesis|(?:true\s+)?(?:tryptophan|trp|indispensable\s+amino\s+acid|amino\s+acid)\s+digestibility|(?:digestibility|bioaccessibility).{0,120}\b(?:crude\s+)?protein\b|crude\s+protein|(?:free|essential)\s+amino\s+acid|amino\s+acid\s*(?:profile|composition|digestibility)|diaas|pdcaas|digestible indispensable)\b/i.test(text);
}

function isFoodProteinConsumerStudy(paper: Paper, intent: ResearchIntent): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  const title = paper.title.toLowerCase();
  const requested = [
    intent.exposure,
    intent.comparator,
    ...intent.exposureTerms,
    ...intent.comparatorTerms
  ].filter(Boolean).join(" ").toLowerCase();
  // Animal names have a second meaning in biomedical literature. Require
  // evidence that the named item is treated as food or nutrition before a
  // pork/chicken/fish-style comparison can use it. This excludes animal
  // viruses, embryos, genes, and vaccines without a topic lookup table.
  const foodContext = /\b(?:dietary|diet\b|nutrition(?:al)?|food(?:s)?|edible|consum(?:e|ption|ed|ing)|intake|meal|meat|lean\s+meat|poultry\s+meat|animal[- ]source\s+protein|amino\s+acid|digestib(?:ility|le)|bioaccessib(?:ility|le)|diaas|pdcaas|muscle\s+protein\s+synthesis)\b/i;
  if (!foodContext.test(text)) return false;
  // The named animal can be the source of a hormone, collagen, virus, or
  // sensory-food experiment rather than an edible protein source. These
  // title-level subjects cannot answer a nutrition-quality comparison.
  const nonNutritionSubject = /\b(?:virus|viral|vaccine|pathogen|infection|embryo|cell(?:s|ular)?|gene|genomic|mutation|glucagon|hormone|antibody|receptor|collagen|gelatin|aroma|taste|flavo(?:u)?r|volatile|sensory|texture|colour|color|physicochemical|oxidation|freeze[- ]?thaw|antifreeze)\b/i;
  const titleHasNutritionMetric = hasFoodProteinQualitySignal(title);
  if (nonNutritionSubject.test(title) && !titleHasNutritionMetric) return false;
  const titleNamesRequestedFood = matchesComparisonOption({ ...paper, abstract: undefined }, intent.exposure, intent.exposureTerms) ||
    matchesComparisonOption({ ...paper, abstract: undefined }, intent.comparator, intent.comparatorTerms);
  // A named option that appears only in an abstract can be a reference food
  // in a study whose real subject is something else (for example, an insect
  // protein experiment using chicken as a benchmark). Allow title-neutral
  // protein-method papers, but not a paper whose title is centred on another
  // specific entity. This preserves genuinely generic human digestibility
  // studies while keeping reference-food contamination out of comparisons.
  if (!titleNamesRequestedFood && !isGenericFoodProteinMetricTitle(title)) return false;
  // A food-comparison question is about edible foods. Keep laboratory
  // digestibility work when it studies the foods themselves, but not animal
  // feed, pet food, by-products, or a processing-variable experiment on just
  // one food. This rule is intentionally domain-based rather than tied to a
  // specific food name.
  if (/\b(?:feather|by-?product|slaughter(?:house)? waste|hydrolysate|pet food|canine|dog|cat|broiler|animal feed|feed formulation|feed-to-gain|growth performance|dietary inclusion|carcass traits|animal production|cooking parameters?|cooking temperature|cooking time|fed|reared)\b/i.test(text)) {
    return false;
  }
  const processedForm = /\b(?:sausages?|burgers?|meatballs?|patt(?:y|ies)|emulsified|marinated|dry[- ]?cured|curing|ripening|cured|processed meat|shelf[- ]?life|storage|sensory|meat quality|freeze[- ]?thaw)\b/i;
  // A sound comparison can list processed foods in its abstract. Do not let
  // planner-added synonyms widen an ordinary pork-versus-chicken question to
  // sausage or patty development; only the user's canonical option can opt
  // into a processed-food comparison.
  const canonicalRequested = `${intent.exposure} ${intent.comparator ?? ""}`.toLowerCase();
  if (processedForm.test(title) && !processedForm.test(canonicalRequested)) return false;
  // A study of a preparation technique or an added matrix describes how that
  // condition changes a food, not the food's inherent protein quality. Keep
  // it only if the user explicitly asked about that condition. This prevents
  // the fallback side search from padding an ordinary food-versus-food
  // comparison with frying, ultrasound, gel, or additive experiments.
  const preparationCondition = /\b(?:pre[- ]?treat(?:ment|ed)|ultrasound|stir[- ]?fry(?:ing)?|frying|fried|roast(?:ing|ed)?|baking|boil(?:ing|ed)?|cook(?:ing|ed)?|doneness|cooking temperature|cooking time|gel(?:s|ation)?|polysaccharide|emuls(?:ion|ified)|marinat(?:ion|ed)?|curing|ferment(?:ation|ed)?|ionic)\b/i;
  const requestedContext = [
    intent.exposure,
    intent.comparator ?? "",
    ...intent.exposureTerms,
    ...intent.comparatorTerms,
    ...intent.outcomeTerms
  ].join(" ");
  if (preparationCondition.test(title) && !preparationCondition.test(requestedContext)) return false;
  const addedIngredient = /\b(?:extract|procyanidin|polyphenol|fortif(?:ied|ication)|supplement(?:ed|ation)|complex(?:es)?|encapsulat(?:ed|ion))\b/i;
  return !addedIngredient.test(title) || addedIngredient.test(requested);
}

function isGenericFoodProteinMetricTitle(title: string): boolean {
  const genericTokens = new Set([
    "true", "digestibility", "digestible", "indispensable", "amino", "acid", "acids", "protein", "proteins",
    "quality", "human", "humans", "adult", "adults", "plant", "plants", "animal", "animals", "source", "sources",
    "dietary", "diet", "food", "foods", "bioavailability", "bioavailable", "consumption", "intake", "response",
    "postprandial", "study", "randomized", "controlled", "trial", "trials", "assessment", "evaluation", "comparison",
    "comparative", "nutritional", "nutrition", "score", "scores", "diaas", "pdcaas", "profile", "profiles", "content",
    "value", "values", "essential", "tryptophan", "lysine", "leucine", "methionine", "histidine", "phenylalanine",
    "threonine", "isoleucine", "valine", "in", "of", "and", "the", "a", "an", "to", "for", "with", "by", "from"
  ]);
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  return tokens.length > 0 && tokens.every((token) => genericTokens.has(token));
}

function hasFoodProteinStudyFinding(paper: Paper, intent: ResearchIntent): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`;
  const title = paper.title;
  const titleNamesOne = matchesNamedOption({ ...paper, abstract: undefined }, intent.exposureTerms) ||
    matchesNamedOption({ ...paper, abstract: undefined }, intent.comparatorTerms);
  const methodCentredTitle = /\b(?:protein\s*(?:quality|digestibility|bioaccessibility|efficiency)|(?:digestibility|bioaccessibility).{0,120}\b(?:crude\s+)?protein\b|(?:free|essential)\s+amino\s+acid|amino\s+acid\s*(?:profile|composition|digestibility)|diaas|digestible indispensable)\b/i.test(title);
  if (!hasFoodProteinQualitySignal(text) || !(titleNamesOne || methodCentredTitle)) return false;
  if (/\b(?:perspective|commentary|editorial)\b/i.test(text)) return false;
  // Do not combine a background sentence about protein quality with a later
  // result about an unrelated endpoint such as soreness, storage, or viral
  // protein. The exact metric and a measured outcome must coexist in one
  // sentence, with a named option either there or in the paper title.
  return hasFoodProteinResultSentence(
    paper,
    [...intent.exposureTerms, ...intent.comparatorTerms],
    titleNamesOne
  );
}

function matchesFoodProteinQualityOutcome(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return hasFoodProteinQualitySignal(text);
}

function matchesFoodProteinOptionEvidence(
  paper: Paper,
  canonical: string | undefined,
  terms: string[]
): boolean {
  const titlePaper = { ...paper, abstract: undefined };
  const titleNamesOption = matchesComparisonOption(titlePaper, canonical, terms);
  // Some high-quality human nutrition studies have a generic title such as
  // "true digestibility of plant and animal protein" and name each food only
  // in the measured-result sentence. Accept that only when the exact option
  // and a food-protein metric occur together in a result, never on a title or
  // background-word match alone.
  return hasFoodProteinResultSentence(paper, [canonical ?? "", ...terms], titleNamesOption);
}

function hasFoodProteinResultSentence(
  paper: Paper,
  optionTerms: string[],
  titleNamesOption: boolean
): boolean {
  return (paper.abstract ?? "")
    .split(/(?<=[.!?])\s+/)
    .some((sentence) =>
      (titleNamesOption || matchesNamedOption({ ...paper, title: sentence, abstract: undefined }, optionTerms)) &&
      hasFoodProteinQualitySignal(sentence.toLowerCase()) &&
      /\b(?:results?|conclusion|found|observed|measured|determined|evaluated|significant(?:ly)?|higher|lower|increased|decreased|greater|less|were|was|had|showed|\d+(?:\.\d+)?\s*%)\b/i.test(sentence)
    );
}

function extractHighValueTokens(queryTerms: string[]): string[] {
  const tokens = new Set<string>();
  for (const term of queryTerms) {
    for (const token of term.toLowerCase().split(/[^a-z0-9가-힣]+/)) {
      if (rankingStopwords.has(token)) continue;
      if (/^\d+(?:\.\d+)?$/.test(token) || containsKorean(token) || token.length >= 4 || highValueTokenAllowlist.has(token)) tokens.add(token);
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
  if (/\bomega 3\b|\bomega-3\b|\bfish oil\b/.test(joined) && /\bcardiovascular\b|\bheart disease\b|\bmyocardial\b|\bstroke\b/.test(joined)) {
    groups.push(
      ["omega 3", "omega-3", "fish oil", "marine omega 3", "marine omega-3", "eicosapentaenoic acid", "docosahexaenoic acid"],
      ["cardiovascular", "cardiovascular disease", "cardiovascular outcomes", "heart disease", "myocardial infarction", "stroke", "cardiac death"]
    );
  }
  const hasLowNoCalorieDrink = /\blow calorie sweetened beverages?\b|\bno calorie sweetened beverages?\b|\bartificially sweetened beverages?\b|\bnon nutritive sweetened beverages?\b|\bdiet (?:soda|beverages?|drinks?)\b/.test(joined);
  const hasSugarSweetenedDrink = /\bsugar sweetened beverages?\b|\bsugary (?:soda|beverages?|drinks?)\b/.test(joined);
  if (hasLowNoCalorieDrink && hasSugarSweetenedDrink) {
    groups.push(
      [
        "low calorie sweetened beverage",
        "low calorie sweetened beverages",
        "no calorie sweetened beverage",
        "no calorie sweetened beverages",
        "artificially sweetened beverage",
        "artificially sweetened beverages",
        "non nutritive sweetened beverage",
        "non nutritive sweetened beverages",
        "diet soda"
      ],
      ["sugar sweetened beverage", "sugar sweetened beverages", "sugary drink", "sugary drinks", "sugary soda"]
    );
  } else if (/\bsweetener\b|\bsweeteners\b|\baspartame\b|\bsucralose\b|\bdiet soda\b|\bnon sugar\b|\blow calorie sweeteners\b|\bartificial sweeteners\b/.test(joined)) {
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
  if (/\bolfactory\b|\bodou?r\b|\baroma\b/.test(joined) && /\bmemory\b|\blearning\b|\bcognition\b/.test(joined)) {
    groups.push(["olfactory", "odor", "odour", "aroma", "scent"], ["memory", "learning", "cognition", "recall"]);
  }
  if (/\bgaming\b|\bvideo game\b/.test(joined) && /\bsleep deprivation\b|\battention\b|\bcognition\b/.test(joined)) {
    groups.push(["gaming", "video game", "video games"], ["sleep deprivation", "attention", "cognition", "cognitive"]);
  }
  return groups;
}

function tokenMatches(haystack: string, token: string): boolean {
  if (containsKorean(token)) return haystack.includes(token);
  return new RegExp(englishTokenPattern(token), "i").test(haystack);
}

function englishTokenPattern(token: string): string {
  const normalized = token.toLowerCase();
  if (normalized === "glycemic" || normalized === "glycaemic") return "\\bglyc(?:e|ae)mic\\b";

  const stems = new Set([normalized]);
  if (normalized.length > 5 && normalized.endsWith("ing")) {
    stems.add(normalized.slice(0, -3));
    stems.add(`${normalized.slice(0, -3)}e`);
  }
  if (normalized.length > 4 && normalized.endsWith("ed")) {
    stems.add(normalized.slice(0, -2));
    stems.add(`${normalized.slice(0, -2)}e`);
  }
  if (normalized.length > 4 && normalized.endsWith("ies")) {
    stems.add(`${normalized.slice(0, -3)}y`);
  } else if (normalized.length > 4 && normalized.endsWith("es")) {
    stems.add(normalized.slice(0, -2));
  } else if (normalized.length > 3 && normalized.endsWith("s")) {
    stems.add(normalized.slice(0, -1));
  }

  const alternatives = [...stems]
    .filter((value) => value.length >= 3)
    .map((value) => `${escapeRegExp(value)}(?:s|es|ed|ing)?`);
  if (alternatives.length === 0) return `\\b${escapeRegExp(normalized)}\\b`;
  return `\\b(?:${alternatives.join("|")})\\b`;
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
  [/\bcoffee\b|\bcaffeine\b/, ["coffee", "caffeine"]],
  [/\bshort sleep\b|\bsleep duration\b|\bsleep deprivation\b|\bsleep restriction\b/, ["short sleep", "sleep duration", "sleep deprivation", "sleep restriction"]],
  [/\bomega 3\b|\bomega-3\b/, ["omega 3", "omega-3"]],
  [/\bsweetener\b|\bsweeteners\b|\bdiet soda\b|\baspartame\b|\bsucralose\b/, ["sweetener", "sweeteners", "diet soda", "aspartame", "sucralose"]],
  [/\bprotein\b|\bwhey\b/, ["protein", "whey"]],
  [/\badded sugar\b|\bsugar intake\b|\bsugar sweetened beverages\b/, ["added sugar", "sugar intake", "sugar-sweetened beverages"]],
  [/\bprobiotic\b|\bprobiotics\b|\bbifidobacterium\b|\blactobacillus\b/, ["probiotic", "probiotics", "bifidobacterium", "lactobacillus"]],
  [/\bscreen time\b|\bscreen based\b/, ["screen time", "screen-based", "screen based"]],
  [/\beye contact\b|\bjoint attention\b/, ["eye contact", "joint attention"]],
  [/\bolfactory\b|\bodou?r\b|\baroma\b/, ["olfactory", "odor", "odour", "aroma", "scent"]],
  [/\bgaming\b|\bvideo game\b/, ["gaming", "video game", "video games"]]
];

const intentConceptStopwords = new Set([
  "blood",
  "body",
  "change",
  "changes",
  "condition",
  "conditions",
  "disease",
  "general",
  "level",
  "levels",
  "outcome",
  "outcomes",
  "people",
  "person",
  "population",
  "populations",
  "response",
  "responses"
]);

const genericComparatorTokens = new Set([
  "control",
  "habitual",
  "no",
  "none",
  "non",
  "placebo",
  "usual",
  "without"
]);

const exposureQualifierStopwords = new Set([
  "after",
  "before",
  "consumption",
  "daily",
  "during",
  "evening",
  "exposure",
  "habit",
  "habits",
  "intake",
  "intervention",
  "morning",
  "oral",
  "regular",
  "supplement",
  "supplementation",
  "therapy",
  "treatment",
  "use",
  "using"
]);

const directConceptQualifierStopwords = new Set([
  "high",
  "low",
  "intake",
  "consumption",
  "consuming",
  "dietary",
  "daily",
  "regular",
  "habitual",
  "incident",
  "incidence",
  "new",
  "onset",
  "diagnosis",
  "risk",
  "outcome",
  "outcomes"
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
  "education",
  "learning",
  "psychology",
  "mental",
  "physical",
  "activity",
  "exercise",
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
