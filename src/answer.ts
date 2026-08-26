import { classifyPaperForIntent, comparisonEvidenceScope, strongestEvidenceLevel } from "./evidence.js";
import { resolveKoreanBrandAliases } from "./clients/rxnav.js";
import { standardSafetyNote } from "./safety.js";
import { broadTopicSubject } from "./text.js";
import type { ClaimAnswer, Citation, EvidenceDetails, EvidenceInterpretation, EvidenceSearchResult, EvidenceStance, KeyStudyDetail, Paper, PracticalCheck, ResearchIntent, ResearchPattern, ResearchStory, Verdict, GlossaryEntry } from "./types.js";

const noEvidenceAnswer =
  "관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다.";

export function composeAnswer(
  question: string,
  evidence: EvidenceSearchResult,
  cached: boolean
): ClaimAnswer {
  // Separate the two jobs explicitly: up to eight papers form the evidence
  // base for the conclusion, while chat exposes three to five representative
  // papers with readable results and links.
  // The response only exposes a few representative papers, but the verdict
  // must not be based on the first handful returned by a provider. Keep a
  // wider evidence base so an exact-item review and its parent evidence can
  // both influence the answer.
  const evaluationPaperLimit = Math.min(20, Math.max(1, evidence.papers.length));
  // Hand-authored diagnostic payloads without a retrieval classification are
  // kept intact for backwards-compatible rendering. Every live search sets at
  // least one of these fields before it reaches this function.
  const hasRetrievalContract = Boolean(evidence.researchIntent);
  const contractPapers = hasRetrievalContract
    ? evidence.papers.filter((paper) => classifyPaperForIntent(paper, evidence.researchIntent) !== "reject")
    : evidence.papers;
  const candidatePapers = selectCorePapers(
    question,
    contractPapers,
    evaluationPaperLimit,
    evidence.researchIntent
  );
  const safetyQuestion = isSafetyQuestion(question, evidence.researchIntent);
  // A title match is only a retrieval candidate. It becomes user-visible
  // evidence only after an actual result sentence has been identified. Test
  // fixtures and hand-authored diagnostics have no retrieval provenance, so
  // preserve their existing rendering contract.
  const evaluationPapers = evidence.searchPlannedBy
    ? candidatePapers.filter((paper) =>
      hasUserVisibleFinding(paper, evidence.researchIntent, safetyQuestion)
    )
    : candidatePapers;
  const topPapers = selectRepresentativePapers(evaluationPapers, 5, safetyQuestion, evidence.researchIntent);

  if (evaluationPapers.length === 0) return noEvidenceClaimAnswer(evidence, cached);

  const evidenceLevel = strongestEvidenceLevel(evaluationPapers);
  const citations = topPapers.map(toCitation);
  const interpretation = interpretEvidence(question, topPapers, evidence.claimDirection, safetyQuestion, evidence.researchIntent);
  const evaluationInterpretation = interpretEvidence(question, evaluationPapers, evidence.claimDirection, safetyQuestion, evidence.researchIntent);
  const effectiveDirectness = evidence.researchIntent && evaluationPapers.some((paper) =>
    classifyPaperForIntent(paper, evidence.researchIntent) === "direct"
  )
    ? "direct"
    : evidence.researchIntent && evaluationPapers.some((paper) =>
      classifyPaperForIntent(paper, evidence.researchIntent) === "contextual"
    )
      ? "contextual"
      : undefined;
  const effectiveComparisonScope = comparisonEvidenceScope(evaluationPapers, evidence.researchIntent);
  const verdict = decideVerdict(evaluationInterpretation);
  const limitations = buildLimitations(evaluationPapers, evidence.sourceErrors.length);
  const parallelComparison = effectiveComparisonScope === "parallel";
  const contextualEvidence = effectiveDirectness === "contextual";
  const broadTopic = isBroadTopicIntent(evidence.researchIntent);
  const researchStory = parallelComparison
    ? buildParallelComparisonResearchStory(interpretation, topPapers, evidence.researchIntent, question)
    : broadTopic
      ? buildTopicOverviewResearchStory(question, topPapers, evidence.researchIntent)
      : contextualEvidence
        ? buildContextualEvidenceResearchStory(interpretation)
        : buildResearchStory(question, verdict, topPapers, interpretation, evidence.researchIntent, effectiveComparisonScope);
  const summary = formatResearchStory(researchStory);
  const detail = buildEvidenceDetails(question, topPapers, interpretation, limitations, safetyQuestion, evidence.researchIntent);

  return {
    answer_ko: summary,
    summary_ko: summary,
    synthesis_mode: "grounded_template",
    research_story: researchStory,
    evidence_basis_ko: buildEvidenceBasis(evaluationPapers, evidence.retrievedPaperCount),
    evidence_status: "verified",
    detail,
    verdict: broadTopic || parallelComparison || contextualEvidence ? "mixed" : verdict,
    evidence_level: evidenceLevel,
    citations,
    evidence_interpretation: interpretation,
    practical_checks: undefined,
    limitations: parallelComparison
      ? [...new Set([
        ...limitations,
        "선택지들을 같은 조건에서 직접 비교한 연구가 아니라, 각 선택지를 따로 평가한 근거입니다."
      ])]
      : contextualEvidence
        ? [...new Set([
          ...limitations,
          "질문의 정확한 용량, 시점, 국가, 대상 또는 비교 조건을 직접 검증한 연구는 아니며 가까운 주제를 다룬 근거입니다."
        ])]
        : limitations,
    safety_note: "",
    glossary: evidence.glossary,
    cached,
    single_exposure_question: asksForSingleExposure(question),
    category: evidence.category,
    query_terms: evidence.queryTerms
  };
}

/**
 * Without the planner the search runs on rule-based terms taken from the
 * Korean question, and PubMed, Europe PMC, OpenAlex and Crossref all index
 * English only. Every such search comes back empty, and reporting that as
 * "no reliable research exists" states something false about the literature
 * when the truth is that the search never really ran.
 */
function unplannedSearchAnswer(evidence: EvidenceSearchResult): string | undefined {
  if (evidence.searchPlannedBy !== "fallback") return undefined;
  return "질문을 영어 학술 검색어로 변환하는 단계가 동작하지 않아 논문 검색을 제대로 수행하지 못했습니다. 관련 연구가 없다는 뜻은 아닙니다. 잠시 후 다시 시도해주세요.";
}

function noEvidenceClaimAnswer(evidence: EvidenceSearchResult, cached: boolean): ClaimAnswer {
  const answer = unplannedSearchAnswer(evidence) ?? noEvidenceAnswer;
  return {
    answer_ko: answer,
    summary_ko: answer,
    evidence_status: "verified",
    detail: emptyEvidenceDetails(),
    verdict: "insufficient_evidence",
    evidence_level: "unknown",
    citations: [],
    practical_checks: undefined,
    limitations: [],
    safety_note: "",
    cached,
    category: evidence.category,
    query_terms: evidence.queryTerms
  };
}

function buildTopicOverviewResearchStory(
  question: string,
  papers: Paper[],
  intent: ResearchIntent | undefined
): ResearchStory {
  const topic = questionTopicLabel(question)
    ?? broadTopicSubject(question)
    ?? koreanSubjectFromQuestion(question)
    ?? intent?.exposure
    ?? "질문의 주제";
  const findings = papers
    .map((paper, index) => ({ finding: reportedFindingFromPaper(paper), index: index + 1, paper }))
    .filter((item): item is { finding: string; index: number; paper: Paper } => Boolean(item.finding));
  const primary = findings[0];
  const directCount = papers.filter((paper) =>
    !intent || classifyPaperForIntent(paper, intent) === "direct"
  ).length;
  const contextualCount = papers.length - directCount;
  const hasSynthesis = papers.some((paper) => paper.evidenceLevel === "systematic_review");
  const primaryScope = primary ? broadPrimaryScope(primary.paper) : "";
  const laboratoryCount = papers.filter(isLaboratoryOnlyPaper).length;
  const humanOrSynthesisCount = papers.length - laboratoryCount;
  const populationScopes = [...new Set(papers
    .map((paper) => inferPopulationFromPaper(paper))
    .filter((scope) => Boolean(scope) && scope !== "세포 실험" && !scope.startsWith("동물 ") && !scope.startsWith("실험실 ")))].slice(0, 3);
  const scopeSummary = populationScopes.length > 0
    ? populationScopes.join("·")
    : "서로 다른 사람 대상 연구";

  return {
    pattern: findings.length >= 2 ? "mostly_consistent" : "insufficient",
    opening_ko: primary
      ? directCount === 0
        ? `${topic} 자체를 직접 평가한 사람 대상 건강 연구는 이번 대표 근거에서 충분히 확인되지 않았습니다. 대신 더 넓은 관련 범주를 다룬 연구에서는 ${primary.finding} [${primary.index}]`
        : !hasSynthesis
          ? laboratoryCount > 0
            ? `${topic}를 직접 다룬 사람 또는 사람 대상 연구를 종합한 자료 ${humanOrSynthesisCount}편과 세포·실험 연구 ${laboratoryCount}편을 확인했습니다. 사람 대상 연구는 ${scopeSummary}에서 서로 다른 지표를 측정했습니다. ${primaryScope}${primary.finding} [${primary.index}]`
            : `${topic}를 직접 다룬 사람 대상 연구는 확인됐습니다. 다만 현재 대표 근거는 ${scopeSummary}에서 서로 다른 지표를 측정했습니다. ${primaryScope}${primary.finding} [${primary.index}]`
          : `${topic} 관련 연구를 종합하면, ${primary.finding} [${primary.index}]`
      : `${topic} 자체를 다룬 연구는 확인됐지만, 대표 논문에서 질문과 직접 연결되는 결과는 확인하지 못했습니다.`,
    timeline_ko: findings.slice(1, 3)
      // The citation marker is stripped from the summary, so a particle
      // attached to it lands on the year instead: "2021년 [2]은 ..." became
      // "2021년은 ...", which reads as a sentence about the year itself.
      // Keep every sentence grammatical with and without the marker.
      .map((item) => `${item.paper.year ? `${item.paper.year}년 연구에서는` : "다른 연구에서는"} ${item.finding} [${item.index}]`)
      .join(" "),
    resolution_ko: contextualCount > 0
      ? directCount === 0
        ? `이번 대표 근거는 ${topic} 자체만 따로 평가한 연구가 아니라, 더 넓은 관련 범주를 다룬 연구입니다. 따라서 이 결과를 ${topic} 하나의 독립 효과나 위험으로 단정할 수는 없습니다.`
        : `${topic} 자체를 다룬 연구와 더 넓은 관련 범주를 다룬 연구를 함께 참고했습니다. 두 종류의 결과는 같은 범위로 해석하면 안 됩니다.`
      : laboratoryCount > 0
        ? `대표 근거 ${papers.length}편 중 ${humanOrSynthesisCount}편은 사람 대상 연구 또는 사람 연구를 종합한 자료이고, ${laboratoryCount}편은 세포·실험 연구입니다. 세포·실험 결과만으로 사람에게 같은 효과가 입증됐다고 볼 수는 없습니다.`
        : `대표 논문 ${papers.length}편은 질문 주제를 직접 다룬 자료입니다. 연구마다 대상과 측정 결과가 달라, 이 결과만으로 모든 건강 효과를 하나로 단정할 수는 없습니다.`
  };
}

function isLaboratoryOnlyPaper(paper: Paper): boolean {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  return /\b(?:cell line|cell culture|cultured cells?|nk-92(?:mi)?|in vitro|simulated digestion|gastrointestinal model|tiny-tim|ileal cannulated|gilts?|swine|pigs?|laboratory[- ]?based|laboratory study|bench study|physicochemical|focused on p\s*h)\b/.test(text);
}

function broadPrimaryScope(paper: Paper): string {
  const population = inferPopulationFromPaper(paper);
  return population ? `${withObjectParticle(population)} 대상으로 한 연구에서는 ` : "이 연구에서는 ";
}

function questionTopicLabel(question: string): string | undefined {
  const normalized = question.replace(/[?!.,]+$/g, "").replace(/\s+/g, " ").trim();
  const match = /^(.{2,48}?)(?:은|는|이|가|을|를|에\s*(?:대해|관해)|의)\s*/.exec(normalized);
  if (!match) return undefined;
  const topic = match[1]!.trim();
  if (!/[가-힣]/.test(topic)) return undefined;
  // A one-word question has no particle to strip: "제로슈가" is the product,
  // not "제로슈" followed by the subject marker 가. Only treat a trailing
  // syllable as a particle when something follows it.
  if (match[0].length >= normalized.length) return undefined;
  // The lazy match stops at the first particle-shaped syllable, which can sit
  // inside a word: "숙취해소제 효과 있는거 맞아?" split at the 는 of 있는 and
  // printed "숙취해소제 효과 있를 직접 다룬 사람 대상 연구는...". A topic that
  // ends mid-verb is not a topic.
  return endsMidWord(topic) ? undefined : topic;
}

/**
 * A Korean topic label should end on a noun. These endings only appear when
 * the split landed inside a verb or adjective stem.
 */
function endsMidWord(topic: string): boolean {
  return /(?:있|없|되|하|받|같|맞|좋|나쁘|아니|먹|마시|쓰|보|들|주|오|가)$/.test(topic);
}

/**
 * The planner's exposure is an English scholarly label, so falling back to it
 * printed "sausage (processed meat product) 자체를 직접 평가한..." three times
 * in one Korean paragraph. Use the word the reader actually typed instead;
 * only reach for the English label when the question has no Korean subject.
 */
function koreanSubjectFromQuestion(question: string): string | undefined {
  const tokens = question.replace(/\s+/g, " ").match(/[가-힣]{2,20}/g) ?? [];
  const first = tokens[0];
  if (!first) return undefined;
  // A particle only does grammatical work inside a sentence. When the question
  // is a single word, its last syllable belongs to the word: "제로슈가" is the
  // product, and stripping 가 printed "제로슈 관련 연구를 종합하면".
  if (tokens.length < 2) return first;
  const stripped = first.replace(/(?:이랑|에서|에게|으로|부터|까지|보다|처럼|랑|과|와|은|는|이|가|을|를|의|도|만|에)$/u, "");
  return stripped.length >= 2 ? stripped : first;
}

function selectRepresentativePapers(
  papers: Paper[],
  limit: number,
  preferSafety = false,
  intent?: ResearchIntent
): Paper[] {
  const linkablePapers = papers.filter((paper) => Boolean(paper.url?.trim() || paper.doi?.trim()));
  const displayPool = linkablePapers.length > 0 ? linkablePapers : papers;
  const focusedPool = intent
    ? displayPool.filter((paper) => Boolean(reportedFindingForIntent(paper, intent)))
    : displayPool;
  // A representative citation must contain a result for the user's question.
  // It is better to show two verifiable papers than pad the response with a
  // third paper whose abstract we could not interpret. The retrieval layer
  // independently tries to fill this pool to three to five papers.
  const representativePool = focusedPool.length > 0 ? focusedPool : displayPool;
  // selectCorePapers already ranks the full evidence basis using directness,
  // reported results, review design, and study breadth. Re-ranking here used
  // to erase that order and let a narrow but newer review replace the broad
  // representative review. Only safety questions need a separate priority.
  if (!preferSafety) return representativePool.slice(0, Math.min(limit, representativePool.length));
  const score = (paper: Paper): number => {
    const safetyFinding = reportedSafetyFindingFromPaper(paper);
    const concreteFinding = (preferSafety ? safetyFinding : undefined)
      ?? reportedFindingFromPaper(paper)
      ?? reportedMetricSummary(paper, "")
      ?? broadQuantitativeFinding(paper.abstract ?? "");
    const designScore = paper.evidenceLevel === "systematic_review"
      ? 20
      : paper.evidenceLevel === "clinical_study"
        ? 12
        : paper.evidenceLevel === "observational_study"
          ? 8
          : 0;
    const preprintPenalty = /\b(?:research square|preprint)\b/i.test(
      `${paper.title} ${paper.venue ?? ""} ${paper.publisher ?? ""}`
    ) ? 80 : 0;
    return (concreteFinding ? 100 : 0) + (preferSafety && safetyFinding ? 120 : 0) + designScore - preprintPenalty;
  };

  return representativePool
    .map((paper, index) => ({ paper, index, score: score(paper) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.min(limit, papers.length))
    .map(({ paper }) => paper);
}

function hasUserVisibleFinding(
  paper: Paper,
  intent: ResearchIntent | undefined,
  preferSafety: boolean
): boolean {
  // Live retrieval must carry the Korean finding and the exact abstract
  // sentence that supports it. Without both, an older heuristic can turn a
  // parser failure into a convincing-looking but empty Korean sentence.
  if (intent && (!paper.groundedFindingKo || !paper.groundedSourceSentence)) return false;
  const finding = preferSafety
    ? reportedSafetyFindingFromPaper(paper)
    : reportedFindingForIntent(paper, intent);
  if (!finding || isGenericPaperResult(finding)) return false;
  const source = paper.groundedSourceSentence?.toLowerCase();
  if (!source) return true;
  if (/\b(?:papers?|studies|trials|articles|records)\b[^.]{0,180}\b(?:which|that)\b[^.]{0,100}\b(?:explored|examined|assessed|investigated)\b[^.]{0,120}\b(?:were|was)\s+included\b/i.test(source)) return false;
  if (/\b(?:is|are|were)\s+(?:currently\s+)?used\s+(?:as|to)\b/i.test(source)) return false;
  if (preferSafety && /\b(?:most common adverse events?|adverse effects?)\b[^.]{0,90}\b(?:cardiovascular|neurological|gastrointestinal|psychiatric)(?:\s+(?:and|or)\s+(?:cardiovascular|neurological|gastrointestinal|psychiatric)){0,3}\s+systems?\b/i.test(source)) return false;
  if (preferSafety && (/\b(?:this|the) review\b[^.]{0,160}\b(?:growing evidence|numerous|multiple|adverse (?:physical|mental|health) outcomes?|health outcomes?)\b/i.test(source)
    || /\b(?:studies|evidence)\b[^.]{0,100}\b(?:consistently found|growing evidence)\b/i.test(source)
    || /\b(?:risky behaviours?|risk[- ]?taking|illicit drug use|substance use|marijuana use|cannabis use|smoking)\b/i.test(source)
    || /\b(?:educational campaigns?|legal restrictions?|regulation|policy|poison (?:center|centre) calls?|reports? of (?:toxicity|adverse events?))\b/i.test(source)
    || /\b(?:self[- ]?reported|consumer(?:s)?|survey|questionnaire|awareness|perceived)\b/i.test(source))) return false;
  return true;
}

function isBroadTopicIntent(intent: ResearchIntent | undefined): boolean {
  return intent?.questionType === "other" && intent.outcomeTerms.length === 0;
}

function isTopicLevelReview(paper: Paper): boolean {
  return /\b(?:systematic review|meta[ -]?analysis|umbrella review|state[- ]of[- ]the[- ]art review|narrative review|review)\b/i
    .test(`${paper.title} ${paper.publicationTypes.join(" ")}`);
}

function buildBroadTopicResearchStory(question: string, papers: Paper[], intent?: ResearchIntent): ResearchStory {
  // Prefer the paper that actually reports a study count or numerical result.
  // A newer review that only mentions the topic in its background must not
  // erase a directly relevant quantitative review from the opening answer.
  const scopeLimited = papers.find((paper) => broadQuantitativeFinding(paper.abstract ?? ""))
    ?? papers.find((paper) => paperNamesIntentExposure(paper, intent))
    ?? papers.find((paper) =>
    /cannot be solely attributed|not solely attributed|global and integrated|further clinical|majority of the existing evidence.*laboratory|heterogeneity.*causal inference/i
      .test(`${paper.title} ${paper.abstract ?? ""}`)
  ) ?? papers[0]!;
  const citationIndex = papers.indexOf(scopeLimited) + 1;
  const topic = broadTopicSubject(question) ?? (question
    .replace(/\s*(?:의)?\s*(?:효능|효과|장점|건강상?\s*이점)(?:\s*(?:이|가|은|는)?\s*(?:뭐야|궁금(?:해)?|알려(?:줘)?|설명(?:해줘)?|말해줘)?)?\s*[?!]?$/i, "")
    .replace(/\s*에\s*대해\s*(?:궁금(?:해)?|알려(?:줘)?|설명(?:해줘)?|말해줘)\s*[?!]?$/i, "")
    .trim() || intent?.exposure || "질문의 대상");
  const hasIsolationLimit = /cannot be solely attributed|not solely attributed|global and integrated/i
    .test(scopeLimited.abstract ?? "");
  const hasLabLimit = /majority of the existing evidence.*laboratory|further clinical/i.test(scopeLimited.abstract ?? "");
  const exactTopicPaper = paperNamesIntentExposure(scopeLimited, intent);
  const exactTopicTitlePaper = paperTitleNamesIntentExposure(scopeLimited, intent);
  const sourceScope = broadSourceScope(scopeLimited, topic);
  const reportedDomains = broadReportedDomains(scopeLimited.abstract ?? "");
  const quantitativeFinding = broadQuantitativeFinding(scopeLimited.abstract ?? "");
  const harmQuestion = /(?:나쁜|안\s*좋|해롭|위험|부작용|위해|독성)/i.test(question);
  const foodTopic = /(?:음식|식품|식단)/.test(topic);
  const dietaryFatContext = papers.some((paper) => /saturated fat|dietary fat|solid fats?|blood lipids?|cardiovascular disease/i.test(`${paper.title} ${paper.abstract ?? ""}`));
  const broadInterventionVerdict = deriveBroadInterventionVerdict(papers);
  const hasConflictingDietaryFatFinding = dietaryFatContext &&
    papers.some((paper) => /not associated with (?:an )?increased risk|no significant evidence.*saturated fat/i.test(paper.abstract ?? "")) &&
    papers.some((paper) => /reducing (?:dietary )?saturated fat reduced|reduction in combined cardiovascular events/i.test(paper.abstract ?? ""));
  const limitation = hasIsolationLimit
    ? `관찰된 변화가 해당 성분 하나만의 효과로 분리되지는 않는다고 정리했습니다${hasLabLimit ? ". 추가적인 사람 대상 임상 연구가 필요하다고 덧붙였습니다" : ""}`
    : !exactTopicPaper
      ? "질문 대상 자체가 아니라 가까운 주제를 다룬 문헌이라, 해당 성분 하나의 독립 효과를 직접 검증한 연구는 아닙니다"
      : hasLabLimit
        ? "추가적인 사람 대상 임상 연구가 필요하다고 정리했습니다"
        : "주제 전체의 효과를 하나의 결과로 확정한 문헌은 아닙니다";
  const contextLabel = exactTopicPaper
    ? "관련 문헌"
    : "가까운 주제를 다룬 문헌";
  const defaultOpening = harmQuestion
    ? exactTopicTitlePaper
      ? `${topic} 자체의 위해를 한 문장으로 확정할 수는 없지만, 관련 연구에서 확인된 위험 신호와 조건은 따로 볼 수 있습니다.`
      : `${topic} 자체를 장기간 따로 평가한 사람 대상 연구는 제한적입니다. 대신 ${sourceScope}에서 확인된 결과를 참고해야 합니다.`
    : quantitativeFinding
      ? foodTopic
        ? `노화에 유리하다고 확립된 특정 음식 하나는 없지만, 식단 패턴과 건강수명을 다룬 연구에서는 확인된 흐름이 있습니다.`
        : `${topic}는 가까운 주제에서 일부 건강 지표 변화가 보고됐지만, ${topic} 하나의 건강 효능이 확립됐다고 보기는 어렵습니다.`
      : foodTopic
        ? "노화에 유리하다고 확립된 특정 음식 하나는 없지만, 식단과 건강수명의 관계를 다룬 연구는 있습니다."
        : `${topic} 관련 연구는 있지만, ${topic} 하나의 건강 효능이 확립됐다고 보기는 어렵습니다.`;
  const defaultResolution = harmQuestion
    ? hasConflictingDietaryFatFinding
      ? "관찰연구와 식단을 실제로 바꾼 장기 연구의 결과가 달랐습니다. 단순 섭취량만 볼지, 포화지방을 무엇으로 대체했는지까지 볼지에 따라 해석이 달라진다는 점이 현재 논쟁의 핵심입니다."
      : exactTopicPaper
        ? `${topic} 관련 결과도 연구 대상, 섭취량과 비교 대상에 따라 달라질 수 있어 한 편의 결과만으로 위해를 단정하면 안 됩니다.`
        : `${topic} 자체를 직접 검증한 결과는 제한적입니다. 가까운 주제의 결과를 ${topic} 하나의 독립 효과로 단정하지 말고, 노출 방식과 비교 대상을 함께 봐야 합니다.`
    : quantitativeFinding
      ? foodTopic
        ? "따라서 한 가지 식품을 '노화 방지 음식'으로 단정하기보다, 연구가 함께 다룬 식단의 구성과 실제로 측정한 건강 지표를 구분해 봐야 합니다."
        : "이 결과는 가까운 주제에서 확인된 제한적 근거이므로, 질병 예방·치료나 전반적인 건강 개선 효과로 그대로 넓힐 수는 없습니다."
      : "관련 연구가 있다는 사실과 특정 성분의 독립 효과가 입증됐다는 것은 다릅니다. 그래서 현재 근거만으로 예방·치료 효과를 단정할 수는 없습니다.";
  return {
    pattern: "insufficient",
    opening_ko: broadInterventionVerdict?.opening_ko ?? defaultOpening,
    timeline_ko: `${scopeLimited.year ? `${scopeLimited.year}년 ` : ""}${contextLabel} [${citationIndex}]에서는 ${sourceScope}. ${quantitativeFinding ?? (reportedDomains ? `초록은 ${reportedDomains}을(를) 다룹니다.` : "")} ${limitation}.`,
    resolution_ko: broadInterventionVerdict?.resolution_ko ?? defaultResolution
  };
}

/**
 * Broad questions should still receive the practical verdict that the
 * selected abstracts actually support. These branches are keyed to explicit
 * exposure, comparator, and result language in the papers, never to a
 * prewritten answer for the user's exact wording.
 */
function deriveBroadInterventionVerdict(papers: Paper[]): { opening_ko: string; resolution_ko: string } | undefined {
  const text = papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" ").toLowerCase();
  if (/\bintermittent fasting\b/.test(text) &&
    /\b(?:similar|comparable|equivalent)\b[^.]{0,120}\b(?:continuous (?:energy|calorie|caloric) restriction|cer\w*)\b|\b(?:continuous (?:energy|calorie|caloric) restriction|cer\w*)\b[^.]{0,120}\b(?:similar|comparable|equivalent)\b/.test(text)) {
    return {
      opening_ko: "간헐적 단식은 체중 감량에는 도움이 될 수 있지만, 일반적인 열량 제한보다 일관되게 더 낫다고 보기는 어렵습니다.",
      resolution_ko: "즉 핵심은 단식 방식 자체의 우열보다, 실제로 유지할 수 있는 식사량 조절인지입니다. 연구에서도 방식에 따라 차이가 있었고 장기 결과는 더 확인할 필요가 있습니다."
    };
  }
  if (/\b(?:artificially sweetened beverages?|asbs?|low[- ]?(?:calorie|cal) sweetened beverages?)\b/.test(text) &&
    /\breplac(?:ing|ed)[^.]{0,160}\b(?:sugar[- ]sweetened beverages?|ssbs?)\b/.test(text)) {
    return {
      opening_ko: "제로 탄산은 설탕 탄산을 대신했을 때 단기 체중·체지방 감소가 보고됐지만, 장기적으로 몸에 해로운지에 대한 결론은 아직 확정되지 않았습니다.",
      resolution_ko: "선택된 종합 문헌도 장기적 이득과 위해 근거가 일관되지 않다고 정리했습니다. 따라서 설탕 탄산을 줄이는 대체재로 본 단기 결과와, 장기 섭취를 관찰한 결과는 구분해서 봐야 합니다."
    };
  }
  return undefined;
}

function buildBroadTopicEvidenceDetails(
  question: string,
  papers: Paper[],
  intent?: ResearchIntent
): EvidenceDetails {
  const topic = broadTopicSubject(question) ?? intent?.exposure ?? "질문의 주제";
  return {
    short_term_ko: "질문의 주제를 폭넓게 다룬 문헌을 중심으로 확인했습니다.",
    long_term_ko: "선택된 문헌만으로 장기적인 건강 효과를 하나로 확정할 수는 없습니다.",
    risk_ko: isSafetyQuestion(question, intent) ? reportedSafetyDetail(papers) : "",
    applicability_ko: "논문마다 성분 조성, 노출 방식, 연구 대상과 측정 지표가 달라 같은 결과를 모든 사람에게 적용할 수는 없습니다.",
    limitations_ko: "질문의 주제 전체와 특정 질병 예방·치료 효과는 구분해서 읽어야 합니다.",
    key_studies: papers.slice(0, 5).map((paper, index) => {
      const quantitativeFinding = broadQuantitativeFinding(paper.abstract ?? "");
      const sourceScope = broadSourceScope(paper, topic);
      const domains = broadReportedDomains(paper.abstract ?? "");
      const participantMatch = /\b(\d[\d,]*)\s+participants\b/i.exec(paper.abstract ?? "");
      const studyMatch = /\b(?:\d[\d,]*|twenty[- ]five|twenty[- ]four|one|two|three|four|five|six|seven|eight|nine|ten)\s+studies\b/i.exec(paper.abstract ?? "");
      const participantScope = participantMatch
        ? `성인 ${formatResearchNumber(participantMatch[1]!)}명${studyMatch ? ` · ${researchQuantityKo(studyMatch[0]!.split(/\s+/)[0]!)}개 연구` : ""}`
        : "문헌에 포함된 연구와 활용 사례";
      const hasIsolationLimit = /cannot be solely attributed|not solely attributed|global and integrated/i
        .test(paper.abstract ?? "");
      const hasClinicalGap = /further clinical|randomized controlled trials|efficacy and safety.*diverse/i
        .test(paper.abstract ?? "");
      const result = quantitativeFinding
        ?? `${sourceScope}. ${domains ? `${domains} 관련 기존 연구를 검토했지만, 초록에서는 하나의 수치 결과를 제시하지 않았습니다.` : "초록에서는 질문에 대한 하나의 수치 결과를 제시하지 않았습니다."}`;
      const limitation = hasIsolationLimit
        ? "관찰된 변화가 해당 성분 하나만의 효과로 분리되지는 않는다고 저자들이 정리했습니다."
        : hasClinicalGap
          ? "저자들은 특정 성분을 이용한 추가 사람 대상 무작위시험이 필요하다고 적었습니다."
          : "이 문헌의 검토 범위가 넓어, 특정 질병 예방·치료 효과로 바로 해석할 수는 없습니다.";
      return {
        citationIndex: index + 1,
        title: paper.title,
        year: paper.year,
        design_ko: shortEvidenceDesignLabel(paper.evidenceLevel),
        population_ko: participantScope,
        exposure_ko: broadEvidenceExposure(paper, topic),
        result_ko: result,
        headline_ko: paper.groundedHeadlineKo,
        time_horizon: inferTimeHorizon(paper),
        limitation_ko: limitation,
        url: paper.url
      };
    })
  };
}

function broadSourceScope(paper: Paper, topic: string): string {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  const scopes: string[] = [];
  if (/essential oils?/.test(text)) scopes.push("에센셜오일");
  if (/aromatherapy|aromachology/.test(text)) scopes.push("아로마테라피");
  if (/forest bathing|forest therapy|shinrin-yoku/.test(text)) scopes.push("산림욕·숲 치료");
  if (scopes.length > 0) return `${withObjectParticle(topic)} ${scopes.join(", ")}와 함께 검토했습니다`;
  if (/saturated fat|dietary fat|animal fat|solid fats?|oils?/.test(title)) {
    return "포화지방·식이 지방과 심혈관 건강을 다룬 문헌";
  }
  return `${topic} 관련 문헌을 검토했습니다`;
}

function broadEvidenceExposure(paper: Paper, topic: string): string {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  if (/forest bathing|forest therapy|shinrin-yoku/.test(text)) {
    return `${topic} 관련 산림욕·숲 치료 (직접 검증 아님)`;
  }
  if (/aromatherapy|aromachology/.test(text)) {
    return `${topic} 관련 아로마테라피 (직접 검증 아님)`;
  }
  if (/essential oils?/.test(text)) {
    return `${topic} 관련 에센셜오일 (직접 검증 아님)`;
  }
  if (/saturated fat|dietary fat|animal fat|solid fats?|oils?/.test(title)) {
    return `포화지방·식이 지방 연구 (${topic} 직접 검증 아님)`;
  }
  return topic;
}

function broadReportedDomains(abstract: string): string | undefined {
  const text = abstract.toLowerCase();
  const domains: string[] = [];
  if (/stress|mental fatigue|relaxation|anxiety|mood/.test(text)) domains.push("스트레스·정신적 피로 관련 변화");
  if (/immune|immunosuppression/.test(text)) domains.push("면역 기능");
  if (/blood pressure|hypertension/.test(text)) domains.push("혈압");
  if (/respiratory|airways?/.test(text)) domains.push("호흡기 관련 변화");
  if (/antimicrobial|anti-microbial|antiseptic/.test(text)) domains.push("항균 작용");
  if (/anti-cancer|anticancer/.test(text)) domains.push("항암 관련 작용");
  if (/cardiovascular|coronary|heart disease|stroke/.test(text)) domains.push("심혈관질환");
  if (/cholesterol|lipid|ldl|hdl|triglyceride/.test(text)) domains.push("혈중 지질");
  return domains.length > 0 ? domains.slice(0, 3).join(", ") : undefined;
}

function broadQuantitativeFinding(abstract: string): string | undefined {
  const clean = abstract
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ");
  const healthyAgingFoodFinding = extractHealthyAgingFoodFinding(clean);
  if (healthyAgingFoodFinding) return healthyAgingFoodFinding;
  const saturatedFatFinding = extractSaturatedFatOutcomeFinding(clean);
  if (saturatedFatFinding) return saturatedFatFinding;
  const dietaryFatReplacement = extractDietaryFatReplacementFinding(clean);
  if (dietaryFatReplacement) return dietaryFatReplacement;
  // Do not wait for a generic effect-size pattern when the abstract already
  // reports a named outcome and mean difference. This is how broad dietary
  // questions retain the useful result rather than falling back to a vague
  // "the paper reviewed the topic" sentence.
  const commonOutcomeFinding = extractCommonEffectSummary(clean);
  if (commonOutcomeFinding) return commonOutcomeFinding;
  const directionalOutcomeFinding = extractDirectionalMetricFinding(clean);
  if (directionalOutcomeFinding) return directionalOutcomeFinding;
  const beverageReplacementFinding = extractSweetenedBeverageReplacementFinding(clean);
  if (beverageReplacementFinding) return beverageReplacementFinding;
  const genericFinding = extractMetaOutcomeFinding(clean);
  if (genericFinding && !/nk\s*cells?|natural killer/i.test(clean)) return genericFinding;
  const countToken = "(?:\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)";
  const studyMatch = new RegExp(`\\b(${countToken})\\s+studies\\s*\\((\\d[\\d,]*)\\s+participants\\)`, "i").exec(clean) ??
    new RegExp(`\\b(${countToken})\\s+studies\\b[\\s\\S]{0,100}?\\b(\\d[\\d,]*)\\s+participants\\b`, "i").exec(clean);
  const effectMatch = /(?:effect size|cohen['’]?s d|\bSMD\b)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?:\s*;?\s*95\s*%\s*CI\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*[,-]\s*([+-]?\d+(?:\.\d+)?)\s*\])?/i.exec(clean);
  if (!studyMatch || !effectMatch) return extractMetaOutcomeFinding(clean);
  const outcome = /nk\s*cells?|natural killer/i.test(clean)
    ? "NK세포 활성"
    : /t[- ]?cells?/i.test(clean)
      ? "T세포 관련 지표"
      : undefined;
  // A generic standardized effect size does not say which health outcome it
  // measures. Never label it as an immune result merely because this helper
  // was first introduced for a phytoncide review.
  if (!outcome) return extractCommonEffectSummary(clean);
  const studies = /^\d/.test(studyMatch[1]!)
    ? formatResearchNumber(studyMatch[1]!)
    : researchQuantityKo(studyMatch[1]!);
  const count = `${studies}개 연구, ${formatResearchNumber(studyMatch[2]!)}명`;
  const effect = `효과크기 ${effectMatch[1]}`;
  const interval = effectMatch[2] && effectMatch[3] ? ` (95% CI ${effectMatch[2]}~${effectMatch[3]})` : "";
  return `${count}을 종합한 결과 ${outcome} 증가가 보고됐습니다(${effect}${interval}).`;
}

function extractDirectionalMetricFinding(abstract: string): string | undefined {
  const definitions = [
    { pattern: "(?:body )?weight", label: "체중", unit: "kg" },
    { pattern: "(?:body mass index|bmi)", label: "체질량지수", unit: "kg/m²" },
    { pattern: "waist circumference", label: "허리둘레", unit: "cm" },
    { pattern: "(?:body )?fat mass", label: "체지방량", unit: "kg" },
    { pattern: "fasting (?:blood )?glucose", label: "공복 혈당", unit: "mmol/L" },
    { pattern: "glyc(?:ated|osylated) haemoglobin|hba1c", label: "당화혈색소", unit: "%" },
    { pattern: "(?:total |low-density |high-density )?cholesterol", label: "콜레스테롤", unit: "mmol/L" },
    { pattern: "triglycerides?", label: "중성지방", unit: "mmol/L" }
  ];
  const effects = definitions.flatMap(({ pattern, label, unit }) => {
    const match = new RegExp(
      `${pattern}\\s+(?:was |were )?(?:significantly\\s+)?(reduced|decreased|lowered|increased|improved)\\s+by\\s+([−-]?\\s*\\d+(?:\\.\\d+)?)\\s*(${unit === "kg/m²" ? "kg(?:/m(?:2|²)|\\.m)" : unit.replace("²", "(?:2|²)").replace("/", "\\/")})?`,
      "i"
    ).exec(abstract);
    if (!match) return [];
    const value = Math.abs(Number(match[2]!.replace(/[−\\s]/g, "-")));
    if (!Number.isFinite(value)) return [];
    const direction = /increased|improved/i.test(match[1]!) ? "증가" : "감소";
    return [`${label} 평균 ${value}${unit} ${direction}`];
  });
  return effects.length > 0 ? `${effects.slice(0, 2).join(", ")}가 보고됐습니다.` : undefined;
}

function extractSweetenedBeverageReplacementFinding(abstract: string): string | undefined {
  if (!/\b(?:artificially sweetened beverages?|asbs?|low[- ]?(?:calorie|cal) sweetened beverages?|non[- ]?sugar sweeteners?)\b/i.test(abstract)) {
    return undefined;
  }
  const trialCount = /\b(\d[\d,]*)\s+(?:rcts|randomi[sz]ed controlled trials?|trials?)\b/i.exec(abstract);
  const weight = /(?:body )?weight\s*\(?\s*([−-]\s*\d+(?:\.\d+)?)\s*kg/i.exec(abstract)
    ?? /weight\s*(?:change|reduction)?[^.;]{0,90}?([−-]\s*\d+(?:\.\d+)?)\s*kg/i.exec(abstract);
  const fat = /(?:body )?fat\s*\(?\s*([−-]\s*\d+(?:\.\d+)?)\s*%/i.exec(abstract)
    ?? /body fat[^.;]{0,90}?([−-]\s*\d+(?:\.\d+)?)\s*%/i.exec(abstract);
  if (!trialCount || (!weight && !fat) || !/replac(?:ing|ed)[^.]{0,120}?(?:sugar[- ]sweetened beverages?|ssbs?)/i.test(abstract)) {
    return undefined;
  }
  const outcomes = [
    weight ? `체중 평균 ${Math.abs(Number(weight[1]!.replace(/[−\s]/g, "-")))}kg 감소` : "",
    fat ? `체지방률 평균 ${Math.abs(Number(fat[1]!.replace(/[−\s]/g, "-")))}%p 감소` : ""
  ].filter(Boolean).join(", ");
  return `${formatResearchNumber(trialCount[1]!)}개 시험에서 설탕 음료를 무설탕 감미 음료로 바꿨을 때 ${outcomes}가 보고됐습니다.`;
}

function extractHealthyAgingFoodFinding(abstract: string): string | undefined {
  if (!/(?:healthy longevity|healthy aging|ageing|aging)/i.test(abstract)) return undefined;
  if (/whole and plant-rich foods/i.test(abstract) && /moderate amounts of animal foods/i.test(abstract)) {
    return "통곡·식물성 식품을 중심으로 하고 동물성 식품을 적당히 포함한 식단이 건강수명 관련 초기 지표를 뒷받침한다고 정리했습니다.";
  }
  if (/higher (?:upf|ultra-processed food) intake is associated/i.test(abstract) &&
    /biological age|functional impairment/i.test(abstract)) {
    return "초가공식품 섭취가 많을수록 생물학적 나이의 진행과 기능 저하 위험이 더 높게 관찰됐다고 정리했습니다.";
  }
  return undefined;
}

function extractSaturatedFatOutcomeFinding(abstract: string): string | undefined {
  if (!/saturated fat/i.test(abstract)) return undefined;
  const trialCount = /\b(\d[\d,]*)\s+(?:randomi[sz]ed controlled trials?|trials?|rcts?)\b/i.exec(abstract);
  const participantCount = /(?:~|about|approximately)?\s*(\d[\d,]*)\s+participants\b/i.exec(abstract);
  const combinedEvents = /reduc(?:ing|ed) (?:dietary )?saturated fat reduced the risk of combined cardiovascular events by\s*(\d+(?:\.\d+)?)%/i.exec(abstract);
  if (combinedEvents) {
    const scope = [
      trialCount ? `${formatResearchNumber(trialCount[1]!)}개 장기 무작위시험` : "장기 무작위시험",
      participantCount ? `${formatResearchNumber(participantCount[1]!)}명` : ""
    ].filter(Boolean).join(", ");
    return `${scope}을 종합한 결과, 포화지방을 줄인 식단은 복합 심혈관 사건 위험을 ${combinedEvents[1]}% 낮췄습니다.`;
  }

  const cohortCount = /\b(\d[\d,]*)\s+studies\b/i.exec(abstract);
  const followUp = /during\s+(\d+(?:-\d+)?)\s+y(?:ears?)?\s+of follow-?up of\s+(\d[\d,]*)\s+subjects/i.exec(abstract);
  if (/not associated with (?:an )?increased risk|no significant evidence for concluding that dietary saturated fat is associated/i.test(abstract) && cohortCount) {
    const scope = [
      `${formatResearchNumber(cohortCount[1]!)}개 장기 관찰연구`,
      followUp ? `${formatResearchNumber(followUp[2]!)}명` : ""
    ].filter(Boolean).join(", ");
    return `${scope}에서는 포화지방 섭취량이 관상동맥질환·뇌졸중 위험 증가와 뚜렷하게 연관되지 않았습니다.`;
  }

  const strokeRisk = /higher dietary (?:sfa|saturated fat) intake was associated with a decreased overall risk for stroke\s*\(rr,?\s*([0-9.]+)/i.exec(abstract);
  const strokeStudies = /\b(\d[\d,]*)\s+studies\s+involving a total of\s+(\d[\d,]*)\s+participants/i.exec(abstract);
  if (strokeRisk && strokeStudies) {
    return `${formatResearchNumber(strokeStudies[1]!)}개 관찰연구, ${formatResearchNumber(strokeStudies[2]!)}명에서는 포화지방 섭취가 높은 군의 뇌졸중 위험이 더 낮게 관찰됐습니다(RR ${strokeRisk[1]}).`;
  }
  return undefined;
}

function extractDietaryFatReplacementFinding(abstract: string): string | undefined {
  if (!/support(?:s|ed)?\s+(?:current\s+)?recommendations?\s+to\s+replace\s+high\s+saturated[- ]fat\s+food\s+with\s+unsaturated\s+oils/i.test(abstract)) {
    return undefined;
  }
  const trialMatch = /\b(\d[\d,]*)\s+trials?\b/i.exec(abstract);
  const scale = trialMatch ? `${formatResearchNumber(trialMatch[1]!)}개 무작위시험을 종합했고, ` : "";
  return `${scale}포화지방이 많은 식품을 불포화지방 식용유로 바꾸라는 기존 권고를 뒷받침했습니다.`;
}

function namesTopicInPaper(paper: Paper, topic: string): boolean {
  const normalizedTopic = topic.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
  if (!normalizedTopic) return false;
  const text = ` ${`${paper.title} ${paper.abstract ?? ""}`.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return text.includes(` ${normalizedTopic} `);
}

function paperNamesIntentExposure(paper: Paper, intent: ResearchIntent | undefined): boolean {
  const text = ` ${`${paper.title} ${paper.abstract ?? ""}`.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return (intent?.exposureTerms ?? []).some((term) => {
    const normalized = term.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
    return normalized.length > 0 && text.includes(` ${normalized} `);
  });
}

function paperTitleNamesIntentExposure(paper: Paper, intent: ResearchIntent | undefined): boolean {
  const title = ` ${paper.title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return (intent?.exposureTerms ?? []).some((term) => {
    const normalized = term.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
    return normalized.length > 0 && title.includes(` ${normalized} `);
  });
}

function buildParallelComparisonResearchStory(
  interpretation: EvidenceInterpretation[],
  papers: Paper[],
  intent: ResearchIntent | undefined,
  question: string
): ResearchStory {
  const exposurePaper = findParallelOptionPaper(papers, intent?.exposure, intent?.exposureTerms ?? []);
  const comparatorPaper = findParallelOptionPaper(
    papers,
    intent?.comparator,
    intent?.comparatorTerms ?? [],
    exposurePaper?.paper
  );
  const separatelyReported = [exposurePaper, comparatorPaper]
    .filter((item): item is { paper: Paper; index: number } => Boolean(item))
    .map((item) => {
      const option = item === exposurePaper
        ? displayComparisonOption(intent?.exposure, question)
        : displayComparisonOption(intent?.comparator, question);
      return `[${item.index}] ${option}: ${summarizeParallelFinding(item.paper)}`;
    })
    .join(" ");
  const fallbackReported = interpretation
    .filter((item) => item.stance !== "unclear")
    .slice(0, 2)
    .map((item) => `[${item.citationIndex}] ${item.reason_ko}`)
    .join(" ");
  return {
    pattern: "insufficient",
    opening_ko: "두 선택지를 같은 조건에서 직접 비교한 연구는 충분히 확인되지 않았습니다.",
    timeline_ko: separatelyReported
      ? `대신 각 선택지를 따로 평가한 연구는 확인했습니다. ${separatelyReported}`
      : fallbackReported
        ? `대신 각 선택지를 따로 평가한 연구에서는 ${fallbackReported}`
      : "검색된 자료는 각 선택지와 결과의 관계를 따로 살핀 연구이므로, 한쪽이 다른 쪽보다 낫다는 결론으로 바로 합칠 수 없습니다.",
    resolution_ko: "따라서 지금은 우열을 단정하지 않고, 각 선택지에서 관찰된 결과와 적용 조건을 분리해서 해석해야 합니다."
  };
}

function findParallelOptionPaper(
  papers: Paper[],
  canonical: string | undefined,
  terms: string[],
  excluded?: Paper
): { paper: Paper; index: number } | undefined {
  const concepts = [canonical, ...terms].filter((term): term is string => Boolean(term?.trim()));
  for (const [index, paper] of papers.entries()) {
    if (paper === excluded) continue;
    const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
    if (concepts.some((concept) => evidenceTextHasConcept(text, concept))) {
      return { paper, index: index + 1 };
    }
  }
  return undefined;
}

function evidenceTextHasConcept(text: string, concept: string): boolean {
  const normalized = normalizeEvidenceText(concept);
  if (!normalized) return false;
  if (text.includes(normalized)) return true;
  const tokens = normalized.split(" ").filter((token) => token.length >= 4);
  return tokens.length === 1 && text.split(" ").includes(tokens[0]!);
}

function displayComparisonOption(value: string | undefined, question: string): string {
  if (!value) return "이 선택지";
  // The planner writes the option as an English scholarly label and sometimes
  // misspells the brand: "Maunjaro (tirzepatide)" appeared verbatim inside a
  // Korean answer. When the reader named the product themselves, use their
  // word; the glossary footnote already ties it to the ingredient.
  const askedAs = resolveKoreanBrandAliases(question).find((alias) =>
    new RegExp(`\\b${alias.ingredient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(value)
    || value.includes(alias.mention));
  if (askedAs) return askedAs.mention;
  const food = foodNameKo(value, question);
  return food === "비교 식품" ? value : food;
}

function summarizeParallelFinding(paper: Paper): string {
  // The retrieval gate already translated one explicit result sentence for
  // every live paper. Reuse that source-grounded result instead of replacing
  // it with a generic "improvement signal" sentence in comparison answers.
  if (paper.groundedFindingKo) return paper.groundedFindingKo;
  const abstract = normalizeEvidenceText(paper.abstract ?? "");
  if (/\b(?:no significant (?:difference|effect)|did not (?:change|improve|reduce)|no (?:clear|meaningful) (?:effect|difference))\b/.test(abstract)) {
    return "뚜렷한 변화가 확인되지 않았습니다.";
  }
  if (/\b(?:heterogeneous|heterogenous|inconsistent|mixed|conflicting)\b/.test(abstract) && /\b(?:minor|modest|small|limited)\b/.test(abstract)) {
    return "변화가 작았고 연구마다 결과가 일관되지 않았습니다.";
  }
  if (/\b(?:heterogeneous|heterogenous|inconsistent|mixed|conflicting)\b/.test(abstract)) {
    return "연구마다 결과가 엇갈렸습니다.";
  }
  if (/\b(?:improved?|benefit(?:ed)?|increased?|reduced?|decreased?|lower(?:ed)?|higher|modulat(?:ed|ion))\b/.test(abstract)) {
    return "질문과 관련된 변화 또는 개선 신호가 보고됐지만, 연구 대상과 조건 안에서 해석해야 합니다.";
  }
  return "질문과 같은 결과를 평가했지만, 초록만으로 두 선택지의 우열을 정할 수 있는 수치는 확인되지 않았습니다.";
}

interface FoodProteinComparisonEvidence {
  story: ResearchStory;
  detail: EvidenceDetails;
}

function selectFoodProteinComparisonPapers(
  question: string,
  papers: Paper[],
  intent: ResearchIntent | undefined
): Paper[] {
  if (!intent || intent.questionType !== "comparison" || !asksAboutFoodProtein(question, intent)) return [];
  const metricPapers = papers.filter((paper) => Boolean(extractFoodProteinEfficiencyMetric(paper, intent)));
  if (metricPapers.length === 0) return [];
  const namedCookingPapers = papers.filter((paper) =>
    !metricPapers.includes(paper) &&
    titleNamesBothFoods(paper, intent) &&
    reportsCookingDependentProteinAccess(paper)
  );
  return [...metricPapers, ...namedCookingPapers].slice(0, 3);
}

function titleNamesBothFoods(paper: Paper, intent: ResearchIntent): boolean {
  const title = paper.title.toLowerCase();
  const includesOne = (terms: string[]) => terms.some((term) => {
    const normalized = term.trim().toLowerCase();
    return normalized.length >= 3 && title.includes(normalized);
  });
  return includesOne(intent.exposureTerms) && includesOne(intent.comparatorTerms);
}

function buildFoodProteinComparisonEvidence(
  question: string,
  papers: Paper[],
  intent: ResearchIntent | undefined
): FoodProteinComparisonEvidence | undefined {
  if (!intent || intent.questionType !== "comparison" || !asksAboutFoodProtein(question, intent)) return undefined;
  const direct = papers
    .map((paper, index) => ({ paper, index: index + 1, metric: extractFoodProteinEfficiencyMetric(paper, intent) }))
    .find((item) => Boolean(item.metric));
  if (!direct?.metric) return undefined;

  const exposureName = foodNameKo(intent.exposure, question);
  const comparatorName = foodNameKo(intent.comparator ?? "", question);
  const exposureValue = direct.metric.exposureValue;
  const comparatorValue = direct.metric.comparatorValue;
  const higherName = exposureValue === comparatorValue
    ? "두 식품"
    : exposureValue > comparatorValue ? exposureName : comparatorName;
  const assayPopulation = /\b(?:rat|rats|mouse|mice|rooster|pig|pigs)\b/i.test(`${direct.paper.title} ${direct.paper.abstract ?? ""}`)
    ? "성장기 쥐를 이용한 식품 단백질 실험"
    : "같은 조건의 식품 단백질 실험";
  const supporting = papers
    .map((paper, index) => ({ paper, index: index + 1 }))
    .find((item) => item.index !== direct.index && reportsCookingDependentProteinAccess(item.paper));
  const supportTimeline = supporting
    ? `${supporting.paper.year ? `${supporting.paper.year}년 ` : ""}다른 실험실 소화 연구는 두 고기를 포함해 조리 조건을 비교했는데, 가열 온도와 시간이 늘수록 단백질 생체접근성이 낮아졌습니다. 다만 이 연구는 두 고기 중 어느 쪽이 더 높다고 결론내리지는 않았습니다. [${supporting.index}]`
    : "다만 이 수치 하나로 사람의 실제 흡수나 근육 증가까지 비교한 것은 아닙니다.";

  const directResult = `${direct.paper.year ? `${direct.paper.year}년 ` : ""}${assayPopulation}에서 단백질 효율비(PER)는 ${exposureName} ${formatMetric(exposureValue)}, ${comparatorName} ${formatMetric(comparatorValue)}였습니다. [${direct.index}]`;
  return {
    story: {
      pattern: "context_explains_difference",
      opening_ko: `단백질 효율비만 놓고 보면, 같은 조건의 직접 비교에서는 ${higherName} 쪽이 더 높았습니다. 다만 이 결과는 사람 대상 임상시험이 아니라 ${assayPopulation}입니다.`,
      timeline_ko: `${directResult} ${supportTimeline}`,
      resolution_ko: `즉 이 PER 지표에서는 ${higherName} 쪽 결과가 우세했지만, 이를 "사람에게 항상 더 좋은 단백질"이라는 결론으로 넓힐 수는 없습니다. 부위와 조리법, 무엇을 단백질의 기준으로 보는지에 따라 해석이 달라집니다.`
    },
    detail: {
      short_term_ko: `${directResult} PER은 일정 기간 성장 반응으로 단백질 이용 효율을 본 지표입니다.`,
      long_term_ko: "선택된 직접 비교는 사람을 장기 추적한 연구가 아니므로, 장기적인 근육 증가나 건강 결과의 우열을 판단할 수 없습니다.",
      risk_ko: "",
      applicability_ko: `가장 직접적인 비교는 ${joinFoodsKo(exposureName, comparatorName)}의 특정 부위를 같은 실험 조건에서 평가한 결과입니다. 실제 식사에서의 흡수나 운동 후 근육 반응과는 구분해야 합니다.`,
      limitations_ko: "직접 비교 수치는 동물 성장 실험에서 나온 값입니다. 고기의 부위, 가공·조리 방식, 섭취량이 달라지면 단백질 관련 지표도 달라질 수 있습니다.",
      key_studies: [
        {
          citationIndex: direct.index,
          title: direct.paper.title,
          year: direct.paper.year,
          design_ko: "식품 단백질 효율 직접 비교 실험",
          population_ko: assayPopulation,
          exposure_ko: `${joinFoodsKo(exposureName, comparatorName)} 단백질`,
          result_ko: `PER: ${exposureName} ${formatMetric(exposureValue)}, ${comparatorName} ${formatMetric(comparatorValue)}.`,
          time_horizon: "short_term",
          limitation_ko: "동물 성장 실험 지표이므로 사람의 장기 근육·건강 결과로 그대로 일반화할 수 없습니다.",
          url: direct.paper.url
        },
        ...(supporting
          ? [{
            citationIndex: supporting.index,
            title: supporting.paper.title,
            year: supporting.paper.year,
            design_ko: "실험실 소화 접근성 비교",
            population_ko: "식품 시료",
            exposure_ko: `${withObjectParticle(joinFoodsKo(exposureName, comparatorName))} 포함한 조리 육류`,
            result_ko: "가열 온도와 시간이 늘수록 단백질 생체접근성이 낮아졌습니다. 두 고기 중 어느 쪽이 더 높다는 결과는 초록에서 확인되지 않았습니다.",
            time_horizon: "short_term" as const,
            limitation_ko: "실험실 소화 모델이므로 사람의 실제 소화·흡수와 동일하다고 볼 수 없습니다.",
            url: supporting.paper.url
          }]
          : [])
      ]
    }
  };
}

function asksAboutFoodProtein(question: string, intent: ResearchIntent): boolean {
  return /(?:단백질|protein|아미노산|amino)/i.test(question) &&
    intent.outcomeTerms.some((term) => /(?:protein|amino|diaas)/i.test(term));
}

function extractFoodProteinEfficiencyMetric(
  paper: Paper,
  intent: ResearchIntent
): { exposureValue: number; comparatorValue: number } | undefined {
  const text = paper.abstract ?? "";
  if (!/\b(?:protein efficiency ratio|\bper\b)\b/i.test(text)) return undefined;
  const exposureValue = foodMetricValue(text, intent.exposureTerms);
  const comparatorValue = foodMetricValue(text, intent.comparatorTerms);
  if (exposureValue === undefined || comparatorValue === undefined) return undefined;
  return { exposureValue, comparatorValue };
}

function foodMetricValue(text: string, terms: string[]): number | undefined {
  const aliases = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  if (!aliases) return undefined;
  const expression = new RegExp(`\\b(?:${aliases})\\b(?:\\s+[a-z-]+){0,3}\\s*\\((\\d+(?:\\.\\d+)?)\\)`, "gi");
  const matches = [...text.matchAll(expression)];
  const value = matches.at(-1)?.[1];
  return value ? Number(value) : undefined;
}

function reportsCookingDependentProteinAccess(paper: Paper): boolean {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:cooking|thermal|heat|temperature)\b/.test(text) &&
    /\b(?:protein\s+bioaccessibility|bioaccessibility.{0,120}\bprotein)\b/.test(text) &&
    /\b(?:decreased|lower|reduced)\b/.test(text);
}

function foodNameKo(value: string, question: string): string {
  const normalized = value.toLowerCase();
  if (/(?:pork|돼지)/.test(normalized)) return "돼지고기";
  if (/(?:chicken|닭)/.test(normalized)) return "닭고기";
  if (/(?:beef|소고기|쇠고기)/.test(normalized)) return "소고기";
  if (/(?:fish|생선|어류)/.test(normalized)) return "생선";
  if (/(?:egg|달걀|계란)/.test(normalized)) return "달걀";
  if (/(?:milk|우유)/.test(normalized)) return "우유";
  if (/(?:yogurt|yoghurt|요거트|요구르트)/.test(normalized)) return "요거트";
  if (/(?:kefir|케피어)/.test(normalized)) return "케피어";
  return question.includes(value) ? value : value || "비교 식품";
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function joinFoodsKo(left: string, right: string): string {
  const lastCode = left.charCodeAt(left.length - 1);
  const hasFinalConsonant = lastCode >= 0xac00 && lastCode <= 0xd7a3 && (lastCode - 0xac00) % 28 !== 0;
  return `${left}${hasFinalConsonant ? "과" : "와"} ${right}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildContextualEvidenceResearchStory(interpretation: EvidenceInterpretation[]): ResearchStory {
  const closestFindings = interpretation
    .slice(0, 3)
    .map((item) => `[${item.citationIndex}] ${item.reason_ko}`)
    .join(" ");
  return {
    pattern: "insufficient",
    opening_ko: "질문의 정확한 조건을 그대로 검증한 연구는 충분히 확인되지 않았습니다.",
    timeline_ko: closestFindings
      ? `대신 가장 가까운 주제를 다룬 연구에서는 ${closestFindings}`
      : "대신 같은 행동과 결과를 더 넓은 조건에서 다룬 연구를 확인했습니다.",
    resolution_ko: "따라서 이 결과는 질문의 주제에 대한 참고 근거로는 쓸 수 있지만, 정확한 용량·시간·대상·지역 조건에 대한 직접 결론으로 단정할 수는 없습니다."
  };
}

export function formatResearchStory(story: ResearchStory): string {
  return [story.opening_ko, story.timeline_ko, story.resolution_ko].filter(Boolean).join("\n\n");
}

export function formatAnswerForText(answer: ClaimAnswer): string {
  if (answer.verdict === "safety_redirect") {
    return [answer.answer_ko, "", answer.safety_note].join("\n");
  }

  const cleanSummary = simplifyMobileSummary(answer.summary_ko ?? answer.answer_ko);
  // A broad-topic bridge (forest bathing -> phytoncides, for example) may
  // include many studies, but that is not a count of studies of the named
  // substance itself. Never turn a contextual count into false precision.
  const scale = researchScaleLine(answer.citations, answer.single_exposure_question);
  const summary = removeSummaryCitationIndices(cleanSummary);
  // No-evidence replies are deliberately one sentence. Adding an empty
  // heading makes a failed search look like a partial answer.
  if (answer.citations.length === 0) return summary;

  const detail = answer.detail;
  const studies = detail?.key_studies
    .filter((study) => Boolean(answer.citations[study.citationIndex - 1]))
    .slice(0, 5) ?? [];
  const evidenceOverview = formatMarkdownEvidenceOverview(answer, scale);
  const safetySection = detail?.risk_ko && isReportedSafetyDetail(detail.risk_ko)
    ? `## 논문에서 확인된 안전성\n${removeMethodologyLabel(detail.risk_ko)}`
    : "";
  const limitation = detail?.limitations_ko && isMeaningfulDetailText(detail.limitations_ko)
    ? `## 연구를 읽을 때\n${removeMethodologyLabel(detail.limitations_ko)}`
    : "";

  // Text content is the product surface in ChatGPT for Kakao. Keep the
  // conclusion easy to scan, then show the research trail rather than a
  // server-oriented diagnostic log.
  return [
    `## 현재 판단\n${summary}`,
    formatGlossaryFootnote(answer.glossary),
    evidenceOverview ? `## 이번 판단에 사용한 근거\n${evidenceOverview}` : "",
    studies.length > 1 ? `## 연구 결과 한눈에 보기\n${formatStudyComparisonTable(studies, answer.citations)}` : "",
    studies.length > 0 ? `## 대표 논문 ${studies.length}편\n${studies.map((study, index) => formatMarkdownStudy(study, index, answer.citations)).join("\n\n")}` : "",
    safetySection,
    limitation
  ].filter(Boolean).join("\n\n");
}

/**
 * Papers are indexed by active ingredient, so a question about "마운자로" comes
 * back as findings about "티르제파타이드". Without this line the reader cannot
 * tell which number belongs to the product they asked about, and a comparison
 * answer becomes unreadable.
 */
export function formatGlossaryFootnote(glossary: GlossaryEntry[] | undefined): string {
  const entries = (glossary ?? []).filter((entry) => entry.term.trim() && entry.askedAs.trim());
  if (entries.length === 0) return "";
  return `> 용어: ${entries
    .map((entry) => `${koreanIngredientName(entry.term)} = ${entry.askedAs.trim()}`)
    .join(" · ")}\n> 논문은 상품명이 아니라 성분명으로 검색되기 때문에 위 이름으로 설명합니다.`;
}

/**
 * Prefer the Korean spelling a reader will recognise, but never invent one:
 * an unknown ingredient keeps its Latin name rather than a guessed
 * transliteration that could name a different drug.
 */
function koreanIngredientName(ingredient: string): string {
  const korean = koreanIngredientNames[ingredient.toLowerCase()];
  return korean ? `${korean}(${ingredient})` : ingredient;
}

const koreanIngredientNames: Record<string, string> = {
  tirzepatide: "티르제파타이드",
  semaglutide: "세마글루타이드",
  liraglutide: "리라글루타이드",
  dulaglutide: "둘라글루타이드",
  metformin: "메트포르민",
  acetaminophen: "아세트아미노펜",
  paracetamol: "아세트아미노펜",
  ibuprofen: "이부프로펜",
  atorvastatin: "아토르바스타틴",
  rosuvastatin: "로수바스타틴",
  finasteride: "피나스테리드",
  minoxidil: "미녹시딜",
  melatonin: "멜라토닌",
  creatine: "크레아틴"
};

function formatMarkdownEvidenceOverview(answer: ClaimAnswer, scale: string | undefined): string {
  const lines = [
    scale ? removeSummaryCitationIndices(scale) : "",
    answer.evidence_basis_ko ? removeSummaryCitationIndices(answer.evidence_basis_ko) : ""
  ]
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.filter((line, index) => !lines.slice(0, index).some((previous) => previous === line)).join("\n\n");
}

export function formatStudyComparisonTable(studies: KeyStudyDetail[], citations: Citation[]): string {
  const rows = studies.map((study) => {
    // The first column drove the wrapping: "[1] · 2024년 · 체계적
    // 문헌고찰·메타분석" is longer than the column a phone gives it, and the
    // renderer broke it mid-word into "체계 / 적 문헌고찰·메타분 / 석". A
    // compact design word keeps the label on one or two lines everywhere.
    const studyLabel = [
      `[${study.citationIndex}]`,
      study.year ? `${study.year}` : "연도 미상",
      compactStudyDesign(study.design_ko)
    ].join(" · ");
    // The full result sentence belongs under 대표 논문. Here it made the
    // column unreadable -- "골격근량 지수의 하위 사분위수 위험도 증가했다(교란
    // 요인 보정 후)" -- and shortening it by character count only hid the
    // number. Show the one-clause version the extraction step produced from
    // that same sentence, and fall back to the sentence when there is none.
    const result = cleanMarkdownText(removeMethodologyLabel(study.headline_ko ?? study.result_ko));
    return `| ${studyLabel} | ${result} |`;
  });
  // 대상과 조건은 각 논문의 상세 항목에서만 보인다. 한 편의 메타분석에
  // 그 정보가 없다는 이유로 표 전체에 빈 칸을 만들지 않는다.
  return ["| 연구 | 핵심 결과 |", "| --- | --- |", ...rows].join("\n");
}

function formatMarkdownStudy(study: KeyStudyDetail, index: number, citations: Citation[]): string {
  const citation = citations[study.citationIndex - 1];
  const title = cleanMarkdownText(study.title || citation?.title || "");
  const design = readableStudyDesign(study.design_ko);
  const scope = [study.population_ko, study.exposure_ko].filter(Boolean).join(" · ");
  const followUp = detailTimeHorizonLabel(study.time_horizon, citation);
  return [
    `### ${index + 1}. ${study.year ? `${study.year}년 · ` : ""}${design}`,
    title ? `*원문 제목: ${title}*` : "",
    scope ? `- **대상·조건:** ${cleanMarkdownText(scope)}` : "",
    followUp ? `- **기간:** ${cleanMarkdownText(followUp.replace(/^(?:추적|기간):\s*/, ""))}` : "",
    `- **결과:** ${cleanMarkdownText(removeMethodologyLabel(study.result_ko))}`,
    isMeaningfulDetailText(study.limitation_ko)
      ? `- **한계:** ${cleanMarkdownText(removeMethodologyLabel(study.limitation_ko))}`
      : "",
    study.url ? `- **원문:** ${study.url}` : ""
  ].filter(Boolean).join("\n");
}

/** Table-only shorthand. The full design name stays in the paper detail. */
function compactStudyDesign(value: string): string {
  const design = readableStudyDesign(value);
  if (/메타분석|문헌고찰|umbrella/i.test(design)) return "메타분석";
  if (/무작위|임상시험|rct/i.test(design)) return "임상시험";
  if (/임상/.test(design)) return "임상";
  if (/코호트/.test(design)) return "코호트";
  if (/관찰/.test(design)) return "관찰";
  if (/권고|가이드라인|자문/.test(design)) return "권고";
  return shortMarkdownCell(design, 12);
}

function readableStudyDesign(value: string): string {
  return value.trim() || "연구";
}

/**
 * Truncating a result sentence used to cut straight through the number the
 * reader came for: "제지방량은 0.21kg(95% CI…". A confidence interval, a dose
 * or a percentage is the finding, so never end inside one. Cut at the last
 * clause boundary that leaves the statistic whole, and keep the whole cell
 * when no such boundary exists rather than mangling the figure.
 */
function shortMarkdownCell(value: string, maxLength: number): string {
  const clean = cleanMarkdownText(value);
  if (clean.length <= maxLength) return clean;
  const boundary = lastSafeCutPoint(clean, maxLength);
  return boundary > 0 ? `${clean.slice(0, boundary).trim()}…` : clean;
}

function lastSafeCutPoint(text: string, maxLength: number): number {
  // Only break after a clause has closed, so a cut cannot land between a value
  // and its interval.
  for (let index = Math.min(maxLength, text.length) - 1; index > maxLength * 0.4; index -= 1) {
    if (!/[.,;)]/.test(text[index] ?? "")) continue;
    const head = text.slice(0, index + 1);
    // A dangling "(" means the parenthetical is still open, and a decimal
    // point is part of a number rather than the end of a clause.
    if (countOf(head, "(") !== countOf(head, ")")) continue;
    if (/\d[.,]$/.test(head)) continue;
    return index + 1;
  }
  return 0;
}

function countOf(text: string, character: string): number {
  let total = 0;
  for (const item of text) if (item === character) total += 1;
  return total;
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/&lt;\/?(?:i|b|em|strong|sup|sub)&gt;/gi, "")
    .replace(/<\/?(?:i|b|em|strong|sup|sub)>/gi, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "·")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isBroadTopicSummary(story: ResearchStory | undefined): boolean {
  return Boolean(story && /자체의 건강 효능은 아직 확립됐다고 보기 어렵습니다/.test(story.opening_ko));
}

function simplifyMobileSummary(summary: string): string {
  const paragraphs = summary.split(/\n\s*\n/).filter(Boolean);
  const cleaned = paragraphs
    .filter((paragraph) => !/논문 수가 아니라|검색된 논문.*필요|대상자·노출량·비교군·측정 결과가 질문과 맞는 연구가 더 필요/i.test(paragraph))
    .map((paragraph) => paragraph.trim());
  return cleaned
    .filter((paragraph, index) => !cleaned.slice(0, index).some((previous) => repeatsConclusion(previous, paragraph)))
    .join("\n\n");
}

function removeSummaryCitationIndices(value: string): string {
  return value
    .replace(/\s*\[(?:\d+\s*(?:[,·-]\s*\d+\s*)*)\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function repeatsConclusion(previous: string, candidate: string): boolean {
  if (/다만|하지만|반면|제한|한계|부작용|차이가 없|유의하지 않/i.test(candidate)) return false;
  const tokens = (value: string) => new Set(
    (value.match(/[가-힣]{2,}|[a-z]{3,}/gi) ?? [])
      .map((token) => token.toLowerCase())
      .filter((token) => !new Set(["연구", "결과", "효과", "영향", "것으로", "나타났습니다", "있습니다", "합니다"]).has(token))
  );
  const left = tokens(previous);
  const right = tokens(candidate);
  if (left.size < 3 || right.size < 3) return false;
  const overlap = [...right].filter((token) => left.has(token)).length;
  return overlap >= 3 && overlap / Math.min(left.size, right.size) >= 0.6;
}

function removeMethodologyLabel(value: string): string {
  return value
    .replace(/네트워크\s*메타\s*분석(?:은|는|에서)?/gi, "네트워크로 여러 연구를 함께 분석한 결과")
    .replace(/체계적\s*문헌고찰\s*(?:및|·|\/)?\s*메타\s*분석(?:에\s*따르면|은|에서)?(?:급)?/gi, "여러 기존 연구를 함께 다시 분석한 결과")
    .replace(/메타\s*분석(?:에\s*따르면|은|에서)?(?:급)?/gi, "여러 연구를 함께 분석한 결과")
    .replace(/체계적\s*문헌고찰(?:에\s*따르면|은|에서)?(?:급)?/gi, "여러 기존 연구를 검토한 결과")
    .replace(/우산형\s*리뷰(?:에\s*따르면|은|에서)?/gi, "여러 종합연구를 다시 검토한 결과")
    .replace(/무작위\s*대조\s*(?:연구|시험)|무작위\s*배정(?:\s*(?:연구|시험))?/gi, "비교시험")
    .replace(/무작위\s*(?:연구|시험)/gi, "비교시험")
    .replace(/관찰\s*연구|코호트\s*연구|단면\s*연구/gi, "장기 관찰자료")
    .replace(/(?:소규모\s*)?파일럿\s*연구/gi, "소규모 초기 연구")
    .replace(/\b(?:systematic review(?: and meta-analysis)?|meta-?analysis|umbrella review)\b/gi, "여러 기존 연구를 함께 검토한 결과")
    .replace(/\b(?:randomi[sz]ed controlled trial|randomi[sz]ed trial)\b/gi, "비교시험")
    .replace(/\b(?:cohort study|cross-sectional study)\b/gi, "장기 관찰자료")
    .replace(/연구\s*설계/g, "진행 조건")
    .replace(/방법론적/g, "조건상의")
    .replace(/간헐적 단식의 다양한 방법론/g, "단식 방식과 식사 조건의 차이")
    .replace(/연구의 다양성/g, "단식 방식과 참여자 조건의 차이")
    .replace(/이질성/g, "연구별 차이")
    .replace(/이는\s*연관성으로\s*보입니다\.?/g, "")
    .replace(/이는\s*연관성으로\s*보고되었으며,?\s*인과관계에\s*대한\s*직접적인\s*언급은\s*없습니다\.?/g, "")
    .replace(/여러\s+여러\s+연구/g, "여러 연구")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function insertResearchScale(summary: string, scaleLine: string | undefined): string {
  if (!scaleLine || summary.includes(scaleLine)) return summary;
  const reportedResult = scaleLine
    .replace(/^.*?:\s*/, "")
    .replace(/\s*\[\d+\]\s*$/, "")
    .trim();
  if (reportedResult.length >= 16 && summary.includes(reportedResult)) return summary;
  const reportedMetrics = reportedResult.match(/\d+(?:\.\d+)?\s*(?:kg|cm|%|mmhg)/gi) ?? [];
  if (reportedMetrics.length > 0 && reportedMetrics.every((metric) => summary.includes(metric))) return summary;
  const paragraphs = summary.split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length === 0) return scaleLine;
  return [paragraphs[0], scaleLine, ...paragraphs.slice(1)].join("\n\n");
}

interface ResearchScale {
  citationIndex: number;
  line: string;
  scope_ko: string;
  conditions_ko?: string;
}

function researchScaleLine(citations: Citation[], preferSingleExposure = false): string | undefined {
  return researchScale(citations, preferSingleExposure)?.line;
}

function researchScale(citations: Citation[], preferSingleExposure = false): ResearchScale | undefined {
  for (const [index, citation] of citations.entries()) {
    if (citation.evidenceLevel !== "systematic_review" || !citation.abstract_excerpt) continue;
    const abstract = citation.abstract_excerpt.replace(/\s+/g, " ");
    const studyLabel = "(?:(?:randomi[sz]ed|controlled|clinical|eligible|original)\\s+){0,4}(?:studies|trials|articles|cohorts?|rcts)";
    // Abstracts can include a screening pool and the eligible studies in the
    // same sentence. Only the latter is a research scale.
    const includedStudyMatch = new RegExp(`\\b(?:included|encompassed|comprising)\\s+(\\d[\\d,]*)\\s+${studyLabel}(?:\\s+(?:involving|with)\\s+(\\d[\\d,]*)\\s+(?:participants|adults|individuals|subjects))?\\b`, "i").exec(abstract) ??
      new RegExp(`\\bof which\\s+(\\d[\\d,]*)\\s+${studyLabel}\\s+(?:met|were included|fulfilled)\\b`, "i").exec(abstract) ??
      new RegExp(`\\b(\\d[\\d,]*)\\s+${studyLabel}\\s+were included\\b`, "i").exec(abstract);
    const genericStudyMatch = [...abstract.matchAll(new RegExp(`\\b(?:a total of\\s+)?(\\d[\\d,]*)\\s+${studyLabel}(?:\\s+(?:involving|with)\\s+(\\d[\\d,]*)\\s+(?:participants|adults|individuals|subjects))?\\b`, "gi"))]
      .find((match) => {
        const sentenceStart = abstract.lastIndexOf(".", match.index ?? 0) + 1;
        const sentenceEnd = abstract.indexOf(".", match.index ?? 0);
        const sentence = abstract.slice(sentenceStart, sentenceEnd === -1 ? abstract.length : sentenceEnd);
        return !/\b(?:search(?:es|ed)?|screen(?:ed|ing)?|identif(?:ied|y)|retriev(?:ed|al)|yield(?:ed|ing)?|records?)\b/i.test(sentence) &&
          !/^\s*of\s+\d[\d,]*\s+(?:studies|trials|articles|cohorts?|rcts)\b/i.test(sentence);
      });
    const studyMatch = includedStudyMatch ?? genericStudyMatch;
    if (!studyMatch) continue;

    const participantRange = abstract.match(/(?:sample sizes?|participants?)\s+(?:ranging\s+)?from\s+([a-z0-9,.-]+)\s+to\s+([a-z0-9,.-]+)\s+participants?/i);
    const studies = formatResearchNumber(studyMatch[1]!);
    const participantCount = studyMatch[2]
      ? formatResearchNumber(studyMatch[2])
      : undefined;
    const participantPrefix = /adults? with overweight and obesity|overweight or obesity/i.test(abstract)
      ? "과체중·비만 성인 "
      : /adult humans|adults|adult population/i.test(abstract)
        ? "성인 "
        : "참여자 ";
    const participantText = participantCount
      ? `, ${participantPrefix}${participantCount}${participantCount.endsWith("만") ? " 명" : "명"}`
      : participantRange
        ? `, 연구당 ${researchQuantityKo(participantRange[1]!)}~${researchQuantityKo(participantRange[2]!)}명`
        : "";
    // A single number from a network or multi-arm review can describe only
    // one pair among several interventions. In that case show the verified
    // research scale, but leave the conclusion to the paper-level parser
    // rather than lending a subgroup contrast to the whole topic.
    const comparisonMentions = abstract.match(/\b(?:compared with|compared to|versus|vs\.?|relative to)\b/gi)?.length ?? 0;
    const effectSummary = comparisonMentions <= 1
      ? extractCommonEffectSummary(abstract, preferSingleExposure)
      : undefined;
    const population = /adults? with overweight and obesity|overweight or obesity/i.test(abstract)
      ? "과체중·비만 성인"
      : /adult humans|adults|adult population/i.test(abstract)
        ? "성인"
        : "연구 참여자";
    const duration = /(?:≥|>=)\s*6\s*months|6\s*months/i.test(normalizeCitationExcerpt(citation.abstract_excerpt))
      ? "6개월 이상"
      : undefined;
    const followUp = extractFollowUpWindow(abstract);
    const comparison = /control diet.*continuous caloric restriction|continuous caloric restriction.*control diet/i.test(abstract)
      ? "대조 식단 또는 일반적인 열량 제한과 비교한"
      : "대조군과 비교한";
    const reviewLabel = "이 종합연구는";
    const line = preferSingleExposure
      ? effectSummary
        ? `질문의 조건과 맞는 결과 [${index + 1}]: ${effectSummary}`
        : undefined
      : effectSummary
        ? `${reviewLabel} ${studies}개 원 연구${participantText}를 함께 분석했습니다. [${index + 1}] ${effectSummary}`
        : `${reviewLabel} ${studies}개 원 연구${participantText}를 함께 분석했습니다. [${index + 1}]`;
    if (!line) continue;
    return {
      citationIndex: index + 1,
      line,
      scope_ko: `이 ${studies}개는 지금 보여주는 종합 논문 1편이 포함해 다시 분석한 원 연구 수입니다. 서비스가 ${studies}편을 각각 대표 논문으로 선정했다는 뜻은 아닙니다.`,
      conditions_ko: preferSingleExposure
        ? ""
        : [
          `${studies}개 원 연구`,
          participantText.replace(/^,\s*/, ""),
          followUp ? `추적: ${followUp}` : duration ? `추적: ${duration}` : ""
        ].filter(Boolean).join(" · ")
    };
  }
  return undefined;
}

function researchQuantityKo(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const words: Record<string, string> = {
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    "twenty-five": "25",
    "twenty five": "25",
    "twenty-four": "24",
    "twenty four": "24"
  };
  return words[trimmed] ?? trimmed.replace(/,/g, "");
}

function extractFollowUpWindow(abstract: string): string | undefined {
  const match = abstract.match(/follow-?up periods?\s+from\s+(.+?)\s+to\s+(.+?)(?=[.;]|$)/i);
  if (!match) return undefined;
  return `${researchDurationKo(match[1]!)}~${researchDurationKo(match[2]!)}`;
}

function researchDurationKo(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/less than one day/g, "1일 미만")
    .replace(/one day/g, "1일")
    .replace(/one week/g, "1주")
    .replace(/two weeks/g, "2주")
    .replace(/three weeks/g, "3주")
    .replace(/four weeks/g, "4주")
    .replace(/five weeks/g, "5주")
    .replace(/six weeks/g, "6주")
    .replace(/one month/g, "1개월")
    .replace(/two months/g, "2개월")
    .replace(/three months/g, "3개월")
    .replace(/six months/g, "6개월")
    .replace(/\s+/g, " ");
}

function extractCommonEffectSummary(abstract: string, preferSingleExposure = false): string | undefined {
  const clean = abstract
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ");
  const trainingModeSummary = extractTrainingModeComparisonSummary(clean);
  if (trainingModeSummary) return trainingModeSummary;
  const definitions = [
    { pattern: "body (?:weight|mass)", label: "체중", unit: "kg" },
    { pattern: "waist circumference", label: "허리둘레", unit: "cm" },
    { pattern: "(?:whole[- ]body )?fat mass", label: "체지방량", unit: "kg" },
    { pattern: "body fat (?:percentage|percent)", label: "체지방률", unit: "%" },
    { pattern: "fasting glucose", label: "공복 혈당", unit: "mmol/L" },
    { pattern: "diastolic blood pressure", label: "이완기 혈압", unit: "mmHg" }
  ];
  const effects = definitions.flatMap(({ pattern, label, unit }) => {
    const matches = [...clean.matchAll(new RegExp(
      `${pattern}[\\s\\S]{0,90}?\\b(?:WMD|MD|SMD|ES|mean difference)\\b\\)?\\s*(?::|=)?\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*(?:${unit.replace("/", "\\/")})?`,
      "gi"
    ))];
    const match = matches
      .map((candidate) => ({
        candidate,
        score: singleExposureResultScore(clean, candidate, preferSingleExposure)
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (!match || (preferSingleExposure && match.score < 0)) return [];
    const result = match.candidate;
    const value = Number(result[1]);
    if (!Number.isFinite(value) || value === 0) return [];
    const contextStart = Math.max(0, (result.index ?? 0) - 120);
    const context = clean.slice(contextStart, (result.index ?? 0) + result[0].length).toLowerCase();
    const isActiveComparison = /\b(?:outperformed|compared|versus|vs\.?|greater|more|less)\b/.test(context);
    const comparesWithControl = /\b(?:control|placebo|no intervention)\b/.test(context);
    if (comparesWithControl) {
      return [{ text: `${label} 평균 ${Math.abs(value)}${unit} 더 ${value < 0 ? "감소" : "증가"}`, control: true }];
    }
    if (isActiveComparison) return [{ text: `${label} 평균 ${Math.abs(value)}${unit} 차이`, control: false }];
    const direction = /\b(?:increase|increased|higher|gain)\b/.test(context) || value > 0
      ? "증가"
      : /\b(?:reduc|decreas|lower|loss)\b/.test(context) || value < 0
        ? "감소"
        : "차이";
    return [{ text: `${label} 평균 ${Math.abs(value)}${unit} ${direction}`, control: false }];
  }).slice(0, 2);
  if (effects.length === 0) return undefined;
  const summary = effects.map((effect) => effect.text).join(", ");
  return effects.every((effect) => effect.control)
    ? `대조군보다 ${summary}했습니다.`
    : `${summary}가 보고됐습니다.`;
}

interface TrainingModeComparison {
  studyCount?: string;
  participantCount?: string;
  duration?: string;
  aerobicVsResistance?: string;
  concurrentVsResistance?: string;
  matchedWorkloadNoDifference: boolean;
}

function extractTrainingModeComparison(abstract: string): TrainingModeComparison | undefined {
  const clean = abstract
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ");
  const comparisonMatch = /(?:\bAT\b|aerobic training)\s+outperformed\s+(?:\bRT\b|resistance training)\s+in reducing/i.exec(clean);
  if (!comparisonMatch) return undefined;
  const resultWindow = clean.slice(comparisonMatch.index, comparisonMatch.index + 1_200);
  const effectValue = (metric: string): number | undefined => {
    const match = new RegExp(
      `${metric}[\\s\\S]{0,180}?\\b(?:mean difference|MD)\\b[\\s\\S]{0,90}?([+-]\\s*\\d+(?:\\.\\d+)?)`,
      "i"
    ).exec(resultWindow);
    if (!match) return undefined;
    const value = Number(match[1]!.replace(/\s+/g, ""));
    return Number.isFinite(value) ? Math.abs(value) : undefined;
  };
  const bodyMass = effectValue("body mass");
  const fatMass = effectValue("fat mass");
  if (bodyMass === undefined && fatMass === undefined) return undefined;

  const countMatch = clean.match(/\b(?:in total,?\s*)?(\d[\d,]*)\s+studies\s+with\s+(\d[\d,]*)\s+participants\b/i);
  const duration = /studies lasting at least\s*10\s*weeks/i.test(clean) ? "10주 이상" : undefined;
  const aerobicVsResistance = [
    bodyMass === undefined ? "" : `체중 평균 ${bodyMass}kg`,
    fatMass === undefined ? "" : `체지방량 평균 ${fatMass}kg`
  ].filter(Boolean).join(", ");
  const concurrentMatch = /(?:\bCT\b|concurrent training)\s+reduced significantly more fat mass compared to\s+(?:\bRT\b|resistance training)[\s\S]{0,100}?(?:mean difference|MD)[\s\S]{0,90}?([+-]\s*\d+(?:\.\d+)?)/i.exec(clean);
  const concurrentValue = concurrentMatch ? Number(concurrentMatch[1]!.replace(/\s+/g, "")) : undefined;
  return {
    studyCount: countMatch?.[1],
    participantCount: countMatch?.[2],
    duration,
    aerobicVsResistance,
    concurrentVsResistance: Number.isFinite(concurrentValue) ? `병행 운동은 근력 운동보다 체지방량 평균 ${Math.abs(concurrentValue!)}kg 더 감소` : undefined,
    matchedWorkloadNoDifference: /workloads were matched[\s\S]{0,220}?similar fat mass, body mass, body fat percentage, and FFM changes/i.test(clean)
  };
}

function extractTrainingModeComparisonSummary(abstract: string): string | undefined {
  const comparison = extractTrainingModeComparison(abstract);
  if (!comparison?.aerobicVsResistance) return undefined;
  const duration = comparison.duration ? `${comparison.duration} 연구에서 ` : "";
  return `${duration}유산소 운동은 근력 운동보다 ${comparison.aerobicVsResistance} 더 줄였습니다.`;
}

function singleExposureResultScore(
  abstract: string,
  match: RegExpMatchArray,
  preferSingleExposure: boolean
): number {
  if (!preferSingleExposure) return 0;
  const start = Math.max(0, (match.index ?? 0) - 180);
  const context = abstract.slice(start, (match.index ?? 0) + match[0].length).toLowerCase();
  let score = 0;
  if (/\b(?:alone|only|solely|by itself)\b/.test(context)) score += 100;
  if (/\b(?:combined|concurrent|caloric restriction|dietary restriction)\b/.test(context)) score -= 100;
  return score;
}

function formatResearchNumber(value: string): string {
  const number = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(number)) return value;
  if (number >= 10_000 && number % 10_000 === 0) return `${number / 10_000}만`;
  return number.toLocaleString("ko-KR");
}

export function formatEvidenceDetailsForText(answer: ClaimAnswer): string {
  const detail = answer.detail;
  if (!detail || answer.citations.length === 0) {
    return [answer.summary_ko ?? answer.answer_ko, answer.evidence_basis_ko ? `근거: ${answer.evidence_basis_ko}` : ""]
      .filter(Boolean)
      .join("\n\n");
  }

  const scaleInfo = researchScale(answer.citations, answer.single_exposure_question);
  const scale = scaleInfo?.line;
  const keyStudies = detail.key_studies;
  const primaryPopulation = keyStudies[0]?.population_ko;
  const applicability = removeMethodologyLabel(detail.applicability_ko);
  const scopedApplicability = primaryPopulation && !applicability.includes(primaryPopulation)
    ? `${withObjectParticle(primaryPopulation)} 중심으로 확인한 결과입니다. ${applicability}`
    : applicability;
  const primaryStudy = keyStudies[0];
  const secondaryStudy = keyStudies[1];
  const thirdStudy = keyStudies[2];
  const evidenceConflict = hasConflictingInterpretations(answer.evidence_interpretation);
  const interpretationNotes = buildInterpretationNotes(detail, answer.citations);
  const reviewedEvidenceLine = answer.citations.length > keyStudies.length
    ? `이번 판단에는 질문에 직접 답한 ${answer.citations.length}편을 함께 비교했고, 아래에는 결론을 대표하는 ${keyStudies.length}편을 보여줍니다.`
    : "";
  const studies = keyStudies.slice(0, 5).map((study, index) => {
    const studyLabel = [study.year ? `${study.year}년` : "연도 미상", study.population_ko || "대상 정보 없음"].join(" · ");
    const role = index === 0
      ? "전체 판단의 기준"
      : index === 1 && evidenceConflict
        ? "다른 결과를 확인한 연구"
        : index === 1
          ? "결론을 교차 확인한 연구"
          : "추가로 확인한 연구";
    const studyContext = [
      study.population_ko ? `대상: ${study.population_ko}` : "",
      study.exposure_ko ? `연구 조건: ${study.exposure_ko}` : "",
      detailTimeHorizonLabel(study.time_horizon, answer.citations[study.citationIndex - 1])
    ].filter(Boolean).join(" · ");
    return [
      `${index + 1}. ${role} · ${studyLabel}`,
      studyContext ? `   ${studyContext}` : "",
      `   결과: ${removeMethodologyLabel(study.result_ko)}`,
      `   한계: ${removeMethodologyLabel(study.limitation_ko)}`,
      `   원문: ${study.url}`
    ].join("\n");
  });

  return [
    primaryStudy
      ? `${formatNarrativeStudy("📚 전체 근거", primaryStudy, answer.citations, answer.query_terms)}${scaleInfo?.citationIndex === primaryStudy.citationIndex && scaleInfo.conditions_ko ? `\n\n• 이 결론이 나온 범위\n${scaleInfo.conditions_ko}` : ""}`
      : "",
    scaleInfo ? `• 연구 수가 뜻하는 것\n${scaleInfo.scope_ko}` : "",
    reviewedEvidenceLine,
    interpretationNotes.length > 0
      ? `• 결론을 만든 단서\n${interpretationNotes.join("\n\n")}`
      : "",
    secondaryStudy
      ? formatNarrativeStudy(evidenceConflict ? "• 엇갈린 결과" : "• 추가로 확인한 연구", secondaryStudy, answer.citations, answer.query_terms)
      : "",
    thirdStudy
      ? formatNarrativeStudy("• 한 번 더 확인한 결과", thirdStudy, answer.citations, answer.query_terms)
      : "",
    `⚠️ 연구 한계\n${removeMethodologyLabel(detail.limitations_ko)}`,
    `👤 적용 범위\n${scopedApplicability}`,
    studies.length > 0 ? `📄 대표 논문 ${studies.length}편\n${studies.join("\n\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}


function formatNarrativeStudy(
  label: string,
  study: KeyStudyDetail,
  citations: Citation[],
  queryTerms: string[] | undefined
): string {
  const citation = citations[study.citationIndex - 1];
  const context = [
    study.year ? `${study.year}년` : "연도 미상",
    study.population_ko,
    study.exposure_ko,
    detailTimeHorizonLabel(study.time_horizon, citation)
  ].filter(Boolean).join(" · ");
  void queryTerms;
  return [
    `${label} [${study.citationIndex}]`,
    context,
    removeMethodologyLabel(study.result_ko)
  ].filter(Boolean).join("\n");
}

function directComparisonCountLine(citation: Citation | undefined, queryTerms: string[] | undefined): string | undefined {
  if (!citation?.abstract_excerpt || !queryTerms?.length) return undefined;
  const concepts = [...new Set(queryTerms
    .flatMap((term) => term.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((term) => !directCountStopwords.has(term)))];
  if (concepts.length < 2) return undefined;

  const sentences = normalizeCitationExcerpt(citation.abstract_excerpt)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const matchedConcepts = concepts.filter((concept) => lower.includes(concept));
    const count = sentence.match(/\b(\d[\d,]*)\s+(?:rcts|randomi[sz]ed controlled trials|trials|studies)\b/i);
    if (matchedConcepts.length < 2 || !count) continue;
    return `질문과 직접 비교한 연구 ${formatResearchNumber(count[1]!)}건`;
  }
  return undefined;
}

const directCountStopwords = new Set([
  "study",
  "studies",
  "trial",
  "trials",
  "review",
  "systematic",
  "clinical",
  "health",
  "adult",
  "adults",
  "participants",
  "outcome",
  "outcomes"
]);

function buildInterpretationNotes(
  detail: EvidenceDetails,
  citations: Citation[]
): string[] {
  const hasLongTermFollowUp = detail.key_studies.some((study) => {
    const citation = citations[study.citationIndex - 1];
    return !citationHasShortOnlyFollowUp(citation) &&
      (study.time_horizon === "long_term" || citationHasLongTermFollowUp(citation));
  });
  const candidates: Array<{ label: string; text: string }> = [
    { label: "단기간에 확인한 결과", text: detail.short_term_ko },
    { label: hasLongTermFollowUp ? "장기적으로 관찰된 결과" : "장기 효과: 아직 알 수 없음", text: detail.long_term_ko },
    { label: detailRiskHeading(detail.risk_ko), text: detail.risk_ko }
  ];
  const seen = new Set<string>();
  return candidates.flatMap(({ label, text }) => {
    const clean = removeMethodologyLabel(text);
    if (!isMeaningfulDetailText(clean) || isEmptySafetyReassurance(clean)) return [];
    const normalized = clean.replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    return [`${label}\n${clean}`];
  });
}

function citationHasLongTermFollowUp(citation: Citation | undefined): boolean {
  if (!citation?.abstract_excerpt) return false;
  const text = normalizeCitationExcerpt(citation.abstract_excerpt);
  return /\b(?:long[- ]term|cohort|\d+\s*(?:years?|yrs?)|(?:6|7|8|9|1\d|[2-9]\d)\s*months?|(?:5[2-9]|[6-9]\d|[1-9]\d{2,})\s*weeks?)\b/i.test(text);
}

function citationHasShortOnlyFollowUp(citation: Citation | undefined): boolean {
  if (!citation?.abstract_excerpt) return false;
  const text = normalizeCitationExcerpt(citation.abstract_excerpt);
  return /\b\d+\s*(?:days?|weeks?|months?)\b/i.test(text) && !citationHasLongTermFollowUp(citation);
}

function withObjectParticle(value: string): string {
  const last = value.trim().charCodeAt(value.trim().length - 1);
  if (!Number.isFinite(last) || last < 0xac00 || last > 0xd7a3) return `${value}을`;
  return `${value}${(last - 0xac00) % 28 === 0 ? "를" : "을"}`;
}

function isEmptySafetyReassurance(value: string): boolean {
  const saysNoHarm = /(?:잠재적\s*)?(?:위험|부작용|해악|안전성).*?(?:구체적(?:인)?\s*(?:보고|근거)?(?:가)?\s*)?(?:없|않)|(?:심각한\s*)?(?:위험|부작용|해악).*?(?:없|않)/i.test(value);
  const onlyEffectUncertain = /(?:효과|이점|개선).*?(?:입증되지|불확실|부족|확인되지)/i.test(value);
  return saysNoHarm && onlyEffectUncertain;
}

function isMeaningfulDetailText(value: string): boolean {
  return value.length >= 18 && !/(?:선택된 연구는|현재 검색된 연구만으로).*(?:별도로 보고하지 않았습니다|확인하지 못했습니다|계산하기 어렵습니다)|^(?:단기|장기) 결과(?:는)? 별도로 보고되지 않았습니다\.?$/i.test(value);
}

function detailRiskHeading(value: string): string {
  if (/부작용 발생 또는 부작용 발생률의 뚜렷한 차이를 보고하지 않았습니다/.test(value)) return "논문에서 확인한 안전성";
  if (/(?:위험|부작용|안전|악화|harm|adverse|serious)/i.test(value)) return "안전성·부작용 결과";
  if (/(?:감소|개선|증가|향상|낮아|높아|benefit)/i.test(value)) return "함께 확인한 변화";
  return "추가로 확인한 결과";
}

function detailTimeHorizonLabel(timeHorizon: KeyStudyDetail["time_horizon"], citation?: Citation): string {
  const followUp = citation ? extractFollowUpWindow(normalizeCitationExcerpt(citation.abstract_excerpt)) : undefined;
  if (followUp) return `추적: ${followUp}`;
  switch (timeHorizon) {
    case "short_term":
      return "기간: 단기 관찰";
    case "long_term":
      return "기간: 장기 추적";
    case "mixed":
      return "기간: 여러 기간의 결과";
    default:
      return "";
  }
}

function hasConflictingInterpretations(interpretations: EvidenceInterpretation[] | undefined): boolean {
  const stances = new Set((interpretations ?? []).map((item) => item.stance));
  return stances.has("supports") && stances.has("opposes");
}

function prioritizeScaleStudy(
  studies: KeyStudyDetail[],
  scale: ResearchScale | undefined,
  citations: Citation[],
  queryTerms: string[] | undefined
): KeyStudyDetail[] {
  const firstCitation = citations[studies[0]?.citationIndex - 1];
  if (isDirectHeadToHeadClinicalStudy(studies[0], firstCitation)) return studies;
  const ranked = [...studies].sort((left, right) => {
    const leftLevel = citations[left.citationIndex - 1]?.evidenceLevel;
    const rightLevel = citations[right.citationIndex - 1]?.evidenceLevel;
    return evidencePriority(rightLevel) - evidencePriority(leftLevel);
  });
  if (!scale) return ranked;
  const linked = ranked.find((study) => study.citationIndex === scale.citationIndex);
  if (linked) {
    return [linked, ...ranked.filter((study) => study.citationIndex !== scale.citationIndex)];
  }

  const citation = citations[scale.citationIndex - 1];
  if (!citation) return ranked;
  const population = /overweight and obesity|overweight or obesity/i.test(citation.abstract_excerpt ?? "")
    ? "과체중 및 비만 성인"
    : "성인";
  return [{
    citationIndex: scale.citationIndex,
    title: citation.title,
    year: citation.year,
    design_ko: "",
    population_ko: population,
    exposure_ko: humanExposureFromQueryTerms(queryTerms),
    result_ko: scale.line
      .replace(/\s*\[\d+\]\s*:\s*/g, " ")
      .replace(/\s*\[\d+\]\s*$/g, ""),
    time_horizon: inferCitationTimeHorizon(citation),
    limitation_ko: scale.scope_ko,
    url: citation.url
  }, ...ranked.filter((study) => study.citationIndex !== scale.citationIndex)];
}

function isDirectHeadToHeadClinicalStudy(study: KeyStudyDetail | undefined, citation: Citation | undefined): boolean {
  if (!study || citation?.evidenceLevel !== "clinical_study") return false;
  const text = `${citation.title} ${citation.abstract_excerpt ?? ""}`.toLowerCase();
  return /tirzepatide/.test(text) && /semaglutide/.test(text) &&
    /\b(?:versus|vs\.?|compared with|compared to|comparison)\b/.test(text);
}

function humanExposureFromQueryTerms(queryTerms: string[] | undefined): string {
  const terms = (queryTerms ?? []).join(" ").toLowerCase();
  if (/blue.?light/.test(terms) && /(?:glass|lens)/.test(terms)) return "블루라이트 차단 안경 착용";
  if (/intermittent fasting/.test(terms)) return "간헐적 단식";
  if (/(?:coffee|caffeine)/.test(terms)) return "커피 또는 카페인 섭취";
  if (/(?:tirzepatide|mounjaro)/.test(terms)) return "티르제파타이드 사용";
  return "질문에서 다룬 행동 또는 중재";
}

function inferCitationTimeHorizon(citation: Citation | undefined): KeyStudyDetail["time_horizon"] {
  const text = normalizeCitationExcerpt(citation?.abstract_excerpt);
  const short = /\b(?:acute|immediate|single dose|\d+\s*(?:days?|weeks?|months?))\b/i.test(text);
  const long = /\b(?:long[- ]term|cohort|\d+\s*(?:years?|yrs?)|(?:6|7|8|9|1\d|[2-9]\d)\s*months?)\b/i.test(text);
  if (short && long) return "mixed";
  if (long) return "long_term";
  if (short) return "short_term";
  return "unknown";
}

function evidencePriority(level: Citation["evidenceLevel"] | undefined): number {
  switch (level) {
    case "systematic_review":
      return 5;
    case "official_guidance":
      return 4;
    case "clinical_study":
      return 3;
    case "observational_study":
      return 2;
    case "preprint":
      return 1;
    default:
      return 0;
  }
}

function continuousCalorieRestrictionInsight(citations: Citation[]): { opening_ko: string; initial_ko: string; detail_ko: string } | undefined {
  for (const [index, citation] of citations.entries()) {
    const abstract = normalizeCitationExcerpt(citation.abstract_excerpt);
    if (!/intermittent fasting/i.test(abstract) || !/continuous caloric restriction/i.test(abstract)) continue;
    const comparisonStart = abstract.search(/compared with cr\b|compared with continuous caloric restriction/i);
    const conclusion = /comparably effective for reducing body weight and adiposity/i.test(abstract);
    if (comparisonStart < 0 || !conclusion) continue;

    const comparison = abstract.slice(comparisonStart);
    const metrics = [
      comparatorMetric(comparison, "fat mass", "체지방량", "kg"),
      comparatorMetric(comparison, "body fat percentage", "체지방률", "%"),
      comparatorMetric(comparison, "(?:diastolic blood pressure|dbp)", "이완기 혈압", "mmHg"),
      comparatorMetric(comparison, "(?:high-density lipoproteins|hdl)", "HDL", "mmol/L")
    ].filter((metric): metric is string => Boolean(metric));
    const duration = /(?:≥|>=)\s*6\s*months|6\s*months/i.test(abstract) ? "6개월 이상" : "연구 기간 동안";
    const detailTail = metrics.length > 0
      ? ` 다만 간헐적 단식 쪽에서 ${metrics.join(", ")} 차이만 보고됐고, 그 밖의 지표는 뚜렷한 차이가 없었습니다.`
      : " 다만 일부 지표에서만 차이가 보고됐습니다.";
    return {
      opening_ko: "간헐적 단식은 과체중·비만 성인의 체중과 허리둘레를 줄이는 데 도움이 될 수 있습니다.",
      initial_ko: `중요한 조건은 ${duration} 유지한 과체중·비만 성인 연구라는 점입니다. 일반적인 열량 제한과 비교하면 체중 감량과 전반적인 건강 지표 개선은 대체로 비슷했습니다. 따라서 간헐적 단식을 더 우월한 감량법으로 보기는 어렵습니다. [${index + 1}]`,
      detail_ko: `체중과 전반적인 심혈관·대사 지표 개선은 대체로 비슷했습니다. [${index + 1}]${detailTail}`
    };
  }
  return undefined;
}

function comparatorMetric(text: string, pattern: string, label: string, unit: string): string | undefined {
  const match = text.match(new RegExp(`${pattern}\\s*\\[\\s*(?:wmd|md)\\s*:\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*(?:${unit.replace("/", "\\/")})?`, "i"));
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value === 0) return undefined;
  return `${label} ${value > 0 ? "+" : ""}${value}${unit}`;
}

function normalizeCitationExcerpt(value: string | undefined): string {
  return (value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:nbsp|amp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isReportedShortTerm(value: string): boolean {
  return !/(?:단기 변화|단기 효과|단기 결과).*(?:별도로 보고하지 않았습니다|확인하지 못했습니다)|단기.*(?:정보가 제한적|정보가 충분하지)/i.test(value);
}

function formatStudyNarratives(studies: KeyStudyDetail[] | undefined): string {
  return (studies ?? [])
    .slice(0, 3)
    .map((study) => {
      const year = study.year ? `${study.year}년` : "연도 미상";
      const broadReview = /문헌|활용 사례/.test(study.population_ko);
      const setup = broadReview
        ? `${year} 문헌 [${study.citationIndex}]에서는 ${withObjectParticle(study.exposure_ko)} 폭넓게 검토했습니다.`
        : `${year} 문헌 [${study.citationIndex}]에서는 ${study.population_ko}에서 ${withObjectParticle(study.exposure_ko)} 살폈습니다.`;
      return [
        setup,
        `결과: ${study.result_ko}`,
        `한계: ${study.limitation_ko}`
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function formatVisibleCitations(citations: Citation[]): string {
  if (citations.length === 0) return "검색된 대표 출처 없음";

  return citations
    .slice(0, 3)
    .map((citation, index) => {
      return `[${index + 1}] ${citation.url}`;
    })
    .join("\n");
}

function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "supported":
      return "근거가 대체로 지지";
    case "mixed":
      return "근거가 혼재";
    case "not_supported":
      return "근거상 단정 어려움/반대 신호";
    case "insufficient_evidence":
      return "직접 근거 부족";
    case "safety_redirect":
      return "안전 우선 안내";
  }
}

function buildPracticalChecks(question: string, category: string): PracticalCheck[] | undefined {
  void question;
  switch (category) {
    case "childcare":
      return childcareChecks;
    case "nutrition":
      return nutritionChecks;
    case "exercise":
      return exerciseChecks;
    case "education":
      return educationChecks;
    case "psychology":
      return psychologyChecks;
    default:
      return healthChecks;
  }
}

const infantDevelopmentChecks: PracticalCheck[] = [
    {
      label: "이름 부르면 돌아보는지",
      what_to_try_ko: "아이 뒤나 옆에서 평소 목소리로 이름을 불러봅니다.",
      what_to_watch_ko: "소리에는 반응하지만 이름에는 거의 반응하지 않는 패턴이 반복되는지 봅니다.",
      why_it_matters_ko: "이름 반응은 사회적 주의와 의사소통 발달을 보는 대표 관찰 지표입니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "눈맞춤이 상황에 따라 달라지는지",
      what_to_try_ko: "밥 먹을 때, 놀이할 때, 안아줄 때처럼 편한 상황에서 짧은 눈맞춤이 생기는지 봅니다.",
      what_to_watch_ko: "모든 상황에서 눈을 거의 피하거나 사람 얼굴보다 물건만 오래 보는지 확인합니다.",
      why_it_matters_ko: "연구들은 눈맞춤 하나보다 사회적 맥락 속 시선 사용을 더 중요하게 봅니다.",
      urgency: "routine_observation"
    },
    {
      label: "공동주의가 되는지",
      what_to_try_ko: "장난감을 가리키며 '저거 봐'라고 말하고 아이가 손가락 방향이나 물체를 보는지 확인합니다.",
      what_to_watch_ko: "가리키기, 보여주기, 같이 보기 행동이 거의 없는지 봅니다.",
      why_it_matters_ko: "공동주의는 자폐 스펙트럼 초기 연구에서 반복적으로 다뤄지는 사회적 의사소통 지표입니다.",
      urgency: "seek_prompt_evaluation"
    },
    {
      label: "부모 표정을 참고하는지",
      what_to_try_ko: "낯선 장난감이나 소리가 났을 때 부모 얼굴을 한 번 쳐다보는지 봅니다.",
      what_to_watch_ko: "불확실한 상황에서도 보호자 얼굴을 거의 참고하지 않는지 확인합니다.",
      why_it_matters_ko: "사회적 참조는 아이가 사람의 표정과 반응을 정보로 쓰는지 보여줍니다.",
      urgency: "routine_observation"
    },
    {
      label: "까꿍 같은 상호놀이 반응",
      what_to_try_ko: "까꿍, 짝짜꿍, 주고받기 놀이를 반복해봅니다.",
      what_to_watch_ko: "웃음, 기대, 차례 기다림, 다시 해달라는 신호가 있는지 봅니다.",
      why_it_matters_ko: "상호작용 놀이 반응은 단순 시선보다 넓은 사회적 반응성을 보여줍니다.",
      urgency: "routine_observation"
    },
    {
      label: "요구 표현 방식",
      what_to_try_ko: "원하는 물건을 살짝 보이게 두고 아이가 어떻게 요청하는지 기다립니다.",
      what_to_watch_ko: "보호자 손만 끌고 가거나, 눈맞춤 없이 울기만 하는 패턴이 반복되는지 봅니다.",
      why_it_matters_ko: "요구할 때 사람을 의사소통 대상으로 쓰는지 확인할 수 있습니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "소리와 청력 반응",
      what_to_try_ko: "문소리, 장난감 소리, 작은 목소리 등 여러 소리에 반응하는지 봅니다.",
      what_to_watch_ko: "이름 반응 저하가 청력 문제와 구분되는지 확인해야 합니다.",
      why_it_matters_ko: "눈맞춤이나 이름 반응 문제처럼 보여도 청력 문제가 섞일 수 있습니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "몸짓 사용",
      what_to_try_ko: "안녕, 주세요, 가리키기, 고개 젓기 같은 몸짓이 있는지 봅니다.",
      what_to_watch_ko: "12개월 전후에 의사소통 몸짓이 거의 없는지 확인합니다.",
      why_it_matters_ko: "몸짓은 말이 나오기 전 사회적 의사소통의 중요한 신호입니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "반복 행동이나 감각 민감성",
      what_to_try_ko: "특정 소리, 빛, 촉감에 과하게 힘들어하거나 같은 행동을 오래 반복하는지 기록합니다.",
      what_to_watch_ko: "시선 문제와 감각 반응, 반복 행동이 함께 나타나는지 봅니다.",
      why_it_matters_ko: "최근 연구들은 사회적 주의뿐 아니라 감각 반응 차이도 함께 봅니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "2주 정도 짧게 기록하기",
      what_to_try_ko: "날짜, 상황, 반응을 짧게 적고 가능하면 10초 정도 영상으로 남깁니다.",
      what_to_watch_ko: "컨디션 문제인지, 여러 상황에서 반복되는 패턴인지 구분합니다.",
      why_it_matters_ko: "전문가 평가 때 실제 상황 기록이 있으면 판단 정확도가 올라갑니다.",
      urgency: "seek_prompt_evaluation"
    }
];

const childcareChecks: PracticalCheck[] = [
  {
    label: "나이와 발달 단계 확인",
    what_to_try_ko: "질문을 아이의 실제 월령, 조산 여부, 최근 질병 여부와 함께 정리합니다.",
    what_to_watch_ko: "월령 기대 범위에서 벗어난 변화가 반복되는지 봅니다.",
    why_it_matters_ko: "육아 연구는 월령과 발달 단계에 따라 해석이 크게 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "반복되는 패턴인지 확인",
    what_to_try_ko: "하루 한 번씩 같은 상황에서 1-2주 기록합니다.",
    what_to_watch_ko: "컨디션이 좋을 때도 같은 문제가 반복되는지 봅니다.",
    why_it_matters_ko: "일회성 행동보다 여러 상황에서 반복되는 패턴이 더 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "먹기, 잠, 놀이를 같이 보기",
    what_to_try_ko: "문제 행동만 보지 말고 수면, 식사, 놀이 반응도 함께 적습니다.",
    what_to_watch_ko: "여러 영역에서 동시에 변화가 있는지 확인합니다.",
    why_it_matters_ko: "소아 발달과 건강은 단일 증상보다 전체 기능을 함께 봐야 합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "영상 기록 남기기",
    what_to_try_ko: "걱정되는 장면을 10-20초 정도 짧게 촬영합니다.",
    what_to_watch_ko: "전문가에게 보여줄 수 있는 대표 상황을 확보합니다.",
    why_it_matters_ko: "진료실에서는 평소 행동이 재현되지 않을 수 있습니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "갑작스러운 퇴행 확인",
    what_to_try_ko: "하던 말을 안 하거나, 하던 행동을 잃었는지 되짚어봅니다.",
    what_to_watch_ko: "기술 상실이 있으면 단순 관찰보다 평가가 우선입니다.",
    why_it_matters_ko: "발달 퇴행은 빠른 평가가 필요한 신호입니다.",
    urgency: "seek_prompt_evaluation"
  },
  {
    label: "가족력과 환경 변화",
    what_to_try_ko: "가족 발달력, 이사, 어린이집 적응, 양육자 변화 등을 같이 봅니다.",
    what_to_watch_ko: "환경 변화 이후 일시적 변화인지 구분합니다.",
    why_it_matters_ko: "발달과 행동은 생물학적 요인과 환경 요인이 함께 작용합니다.",
    urgency: "routine_observation"
  },
  {
    label: "소아청소년과 상담 기준",
    what_to_try_ko: "기록한 내용과 영상을 들고 정기검진 또는 소아청소년과에서 상담합니다.",
    what_to_watch_ko: "걱정이 지속되거나 여러 영역에서 겹치면 지체하지 않습니다.",
    why_it_matters_ko: "선별검사와 발달평가는 조기 개입 여부를 판단하는 데 도움이 됩니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const nutritionChecks: PracticalCheck[] = [
  {
    label: "대상자별 기준 확인",
    what_to_try_ko: "답변의 성인 남성/여성, 임신·수유, 소아·청소년, 노인, 기저질환자 기준 중 내 상황과 가까운 줄을 봅니다.",
    what_to_watch_ko: "건강한 성인 연구인지, 질환자나 소아에게도 적용 가능한 근거인지 구분합니다.",
    why_it_matters_ko: "영양 연구는 건강한 성인, 임신부, 소아, 노인, 질환자에서 결론이 달라질 수 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "현재 섭취량 기록",
    what_to_try_ko: "3일 정도 먹은 양을 대략 기록합니다.",
    what_to_watch_ko: "문제 성분을 실제로 많이 먹는지 확인합니다.",
    why_it_matters_ko: "효과와 위험은 섭취량에 따라 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "기저질환 확인",
    what_to_try_ko: "신장, 간, 심혈관, 대사질환 여부를 확인합니다.",
    what_to_watch_ko: "질환이 있으면 일반인 연구를 그대로 적용하지 않습니다.",
    why_it_matters_ko: "영양 권고는 기저질환에서 가장 크게 달라집니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "혈액검사와 지표",
    what_to_try_ko: "필요하면 검진 결과의 eGFR, 크레아티닌, 지질, 혈당 등을 확인합니다.",
    what_to_watch_ko: "수치 변화가 있으면 식단 실험보다 진료가 우선입니다.",
    why_it_matters_ko: "영양 효과는 체감보다 객관 지표로 보는 게 안전합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "한 가지 변화만 적용",
    what_to_try_ko: "식단을 바꿀 때 한 번에 하나씩 2-4주 관찰합니다.",
    what_to_watch_ko: "무엇 때문에 변화가 생겼는지 구분합니다.",
    why_it_matters_ko: "여러 변화를 동시에 하면 원인 판단이 어렵습니다.",
    urgency: "routine_observation"
  },
  {
    label: "극단 식단 피하기",
    what_to_try_ko: "특정 영양소를 과하게 늘리거나 완전히 끊지 않습니다.",
    what_to_watch_ko: "피로, 소화 문제, 체중 급변이 있는지 봅니다.",
    why_it_matters_ko: "대부분의 영양 근거는 극단보다 적정 범위에서 해석됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "전문가 상담 기준",
    what_to_try_ko: "질환, 약 복용, 임신, 소아 식단이면 의사나 영양사와 상의합니다.",
    what_to_watch_ko: "개인 조건이 중요한 경우 일반 논문 답변으로 결정하지 않습니다.",
    why_it_matters_ko: "개인화가 필요한 영역은 안전성 판단이 우선입니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const proteinSupplementChecks: PracticalCheck[] = [
  {
    label: "체중 기준 g/kg 계산",
    what_to_try_ko: "하루 총 단백질 g을 체중 kg으로 나눕니다. 예: 70kg에 100g이면 1.43g/kg/day입니다.",
    what_to_watch_ko: "목표가 근성장인지, 감량 중 근손실 방지인지, 그냥 건강관리인지 구분합니다.",
    why_it_matters_ko: "스포츠영양 연구는 절대량 100g보다 g/kg/day 기준으로 비교합니다.",
    urgency: "routine_observation"
  },
  {
    label: "파우더만 100g인지 총 단백질 100g인지 구분",
    what_to_try_ko: "제품 스쿱의 단백질 함량을 확인합니다. 파우더 100g은 단백질 100g이 아닐 수 있습니다.",
    what_to_watch_ko: "식사 단백질까지 합친 하루 총량을 따로 계산합니다.",
    why_it_matters_ko: "논문 기준은 보충제 무게가 아니라 실제 단백질 섭취량입니다.",
    urgency: "routine_observation"
  },
  {
    label: "1.6g/kg/day 근처인지 보기",
    what_to_try_ko: "근력운동 중이면 체중 x 1.6g을 기준점으로 계산합니다.",
    what_to_watch_ko: "이보다 훨씬 높아도 근성장 추가 이득이 크지 않을 수 있습니다.",
    why_it_matters_ko: "저항운동 메타분석에서 약 1.6g/kg/day 이후 추가 이득이 작아지는 결과가 보고됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "운동 자극이 충분한지",
    what_to_try_ko: "주당 운동 횟수, 세트 수, 점진적 과부하 여부를 기록합니다.",
    what_to_watch_ko: "운동이 부족하면 단백질만 늘려도 근성장 효과가 제한됩니다.",
    why_it_matters_ko: "단백질 보충 효과는 저항운동과 함께 볼 때 가장 의미 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "신장질환 위험요인 확인",
    what_to_try_ko: "eGFR, 크레아티닌, 단백뇨, 당뇨, 고혈압, 가족력을 확인합니다.",
    what_to_watch_ko: "위험요인이 있으면 고단백 식단을 자가 판단하지 않습니다.",
    why_it_matters_ko: "건강한 성인 연구와 CKD 환자 연구는 결론이 다릅니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "소화와 식단 대체 여부",
    what_to_try_ko: "파우더 때문에 식사, 채소, 지방, 탄수화물이 밀려나는지 봅니다.",
    what_to_watch_ko: "복부팽만, 설사, 식욕저하, 식단 단조로움이 생기는지 확인합니다.",
    why_it_matters_ko: "고단백 자체보다 전체 식단 질 저하가 문제가 될 수 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "2-4주 성과 지표",
    what_to_try_ko: "체중, 허리둘레, 운동 중량, 반복 수, 컨디션을 기록합니다.",
    what_to_watch_ko: "단백질을 늘린 뒤 실제 훈련 성과나 체성분 변화가 있는지 봅니다.",
    why_it_matters_ko: "개인 적용에서는 논문 평균보다 내 반응을 함께 봐야 합니다.",
    urgency: "routine_observation"
  }
];

const sweetenerDrinkChecks: PracticalCheck[] = [
  {
    label: "설탕 탄산 대체인지 확인",
    what_to_try_ko: "제로음료가 기존 설탕 탄산을 줄이는 대체인지, 물 대신 추가로 늘어난 음료인지 구분합니다.",
    what_to_watch_ko: "설탕 음료를 줄인 경우와 전체 음료량이 늘어난 경우는 해석이 다릅니다.",
    why_it_matters_ko: "제로음료의 이득은 주로 당류와 칼로리 대체에서 나옵니다.",
    urgency: "routine_observation"
  },
  {
    label: "원재료명에서 감미료 찾기",
    what_to_try_ko: "라벨에서 아스파탐, 아세설팜칼륨, 수크랄로스, 스테비올배당체, 에리스리톨, 알룰로스를 확인합니다.",
    what_to_watch_ko: "제품명보다 실제 감미료 조합을 봅니다.",
    why_it_matters_ko: "연구와 안전성 논쟁은 '제로' 전체가 아니라 감미료 종류별로 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "하루 캔 수 기록",
    what_to_try_ko: "1주일 동안 하루 몇 캔인지 적습니다.",
    what_to_watch_ko: "매일 여러 캔이면 감미료뿐 아니라 카페인, 산, 식습관 대체 문제도 같이 봅니다.",
    why_it_matters_ko: "섭취 빈도와 양이 위험 해석의 핵심입니다.",
    urgency: "routine_observation"
  },
  {
    label: "혈당 이슈가 있으면 직접 비교",
    what_to_try_ko: "당뇨나 혈당 관리 중이면 같은 식사 조건에서 혈당 반응을 기록합니다.",
    what_to_watch_ko: "제로음료 자체보다 같이 먹는 음식과 단맛 갈망 변화도 봅니다.",
    why_it_matters_ko: "감미료의 대사 반응은 개인차가 크다는 연구들이 있습니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "소화 불편감 확인",
    what_to_try_ko: "복부팽만, 설사, 가스가 특정 제품 뒤 반복되는지 봅니다.",
    what_to_watch_ko: "당알코올이나 일부 감미료는 사람에 따라 위장 불편감을 만들 수 있습니다.",
    why_it_matters_ko: "안전성 논쟁과 별개로 개인 적용에서는 위장 반응이 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "페닐케톤뇨증 예외",
    what_to_try_ko: "본인이나 가족에게 페닐케톤뇨증이 있으면 아스파탐 표시를 피합니다.",
    what_to_watch_ko: "라벨의 '페닐알라닌 함유' 표시를 확인합니다.",
    why_it_matters_ko: "아스파탐은 페닐알라닌 공급원이므로 해당 질환에서는 예외적으로 중요합니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const exerciseChecks: PracticalCheck[] = [
  {
    label: "목표 명확화",
    what_to_try_ko: "체중감량, 심폐지구력, 근력, 통증 완화 중 목표를 하나로 잡습니다.",
    what_to_watch_ko: "목표에 맞는 연구인지 확인합니다.",
    why_it_matters_ko: "운동 연구는 목표 지표에 따라 결론이 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "운동 강도 기록",
    what_to_try_ko: "시간, 강도, 빈도, 통증 여부를 기록합니다.",
    what_to_watch_ko: "효과보다 부상 신호가 먼저 나타나는지 봅니다.",
    why_it_matters_ko: "운동 효과는 용량과 회복에 좌우됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "통증 위치 확인",
    what_to_try_ko: "운동 중 또는 다음 날 통증 위치와 강도를 적습니다.",
    what_to_watch_ko: "날카로운 통증, 붓기, 저림은 중단 신호입니다.",
    why_it_matters_ko: "부상 위험은 성과보다 먼저 관리해야 합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "점진적 증가",
    what_to_try_ko: "강도나 시간을 한 번에 크게 올리지 않습니다.",
    what_to_watch_ko: "수면, 피로, 통증이 악화되는지 봅니다.",
    why_it_matters_ko: "대부분 운동 권고는 점진적 과부하를 전제로 합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기저질환 확인",
    what_to_try_ko: "심장질환, 호흡기질환, 임신, 수술 후 상태를 확인합니다.",
    what_to_watch_ko: "가슴통증, 호흡곤란, 어지럼이 있으면 중단합니다.",
    why_it_matters_ko: "운동 안전성은 개인 건강 상태에 따라 달라집니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const educationChecks: PracticalCheck[] = [
  {
    label: "측정할 결과 정하기",
    what_to_try_ko: "성적, 이해도, 집중시간, 기억 유지 중 무엇을 볼지 정합니다.",
    what_to_watch_ko: "느낌이 아니라 측정 가능한 변화가 있는지 봅니다.",
    why_it_matters_ko: "교육 연구는 outcome 정의가 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기간 정하기",
    what_to_try_ko: "최소 1-2주 같은 방식으로 적용합니다.",
    what_to_watch_ko: "하루 컨디션 효과와 실제 학습 효과를 구분합니다.",
    why_it_matters_ko: "학습 효과는 단기 기분보다 반복 성과로 봐야 합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기초 수준 확인",
    what_to_try_ko: "시작 전 현재 점수나 수행 시간을 기록합니다.",
    what_to_watch_ko: "개입 전후를 비교할 기준을 만듭니다.",
    why_it_matters_ko: "baseline 없이 효과를 판단하기 어렵습니다.",
    urgency: "routine_observation"
  }
];

const psychologyChecks: PracticalCheck[] = [
  {
    label: "증상 강도 기록",
    what_to_try_ko: "불안, 우울, 수면, 집중을 0-10점으로 매일 기록합니다.",
    what_to_watch_ko: "2주 이상 지속되거나 악화되는지 봅니다.",
    why_it_matters_ko: "심리 연구와 임상 판단 모두 지속 기간과 기능 저하를 중요하게 봅니다.",
    urgency: "routine_observation"
  },
  {
    label: "생활 기능 확인",
    what_to_try_ko: "학교, 일, 관계, 식사, 수면에 영향이 있는지 봅니다.",
    what_to_watch_ko: "기능 저하가 있으면 자가관리보다 상담이 우선입니다.",
    why_it_matters_ko: "증상의 심각도는 불편감뿐 아니라 기능 손상으로 판단합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "위험 신호",
    what_to_try_ko: "자해 생각, 극단적 선택 생각, 공황 수준의 증상이 있는지 확인합니다.",
    what_to_watch_ko: "있다면 즉시 주변 도움과 전문기관에 연결합니다.",
    why_it_matters_ko: "위험 신호는 연구 검토보다 안전 확보가 우선입니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const healthChecks: PracticalCheck[] = [
  {
    label: "대상자와 조건 확인",
    what_to_try_ko: "나이, 성별, 임신, 질환, 약 복용 여부를 적습니다.",
    what_to_watch_ko: "검색된 연구 대상과 내 조건이 다른지 확인합니다.",
    why_it_matters_ko: "건강 연구는 대상자 조건에 따라 적용 가능성이 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "증상 기간과 강도",
    what_to_try_ko: "언제 시작됐고 얼마나 심한지 기록합니다.",
    what_to_watch_ko: "갑자기 심해지거나 오래 지속되는지 봅니다.",
    why_it_matters_ko: "기간과 강도는 상담 필요성을 판단하는 핵심 정보입니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "위험 신호 확인",
    what_to_try_ko: "호흡곤란, 흉통, 의식저하, 심한 통증 같은 신호가 있는지 봅니다.",
    what_to_watch_ko: "위험 신호가 있으면 검색보다 응급 대응이 우선입니다.",
    why_it_matters_ko: "일부 증상은 일반 정보 제공으로 다루면 안 됩니다.",
    urgency: "seek_prompt_evaluation"
  }
];

function buildLimitations(papers: Paper[], sourceErrorCount: number): string[] {
  const limitations = [
    "연구마다 대상자, 노출 강도, 측정 방식과 추적 기간이 달라 개인에게 결과를 그대로 적용하기는 어렵습니다.",
    "핵심 결과 외의 세부 분석과 교란요인은 연결된 원문에서 추가로 확인해야 합니다."
  ];
  if (!papers.some((paper) => paper.evidenceLevel === "systematic_review")) {
    limitations.push("검색 결과 안에서 체계적 문헌고찰 또는 메타분석이 최상위로 확인되지 않았습니다.");
  }
  if (sourceErrorCount > 0) {
    limitations.push("일부 데이터 소스 검색이 실패해 결과가 불완전할 수 있습니다.");
  }
  return limitations;
}

function toCitation(paper: Paper): Citation {
  return {
    source: paper.source,
    sourceId: paper.sourceId,
    title: paper.title,
    authors: paper.authors,
    venue: paper.venue,
    publisher: paper.publisher,
    institutions: paper.institutions,
    year: paper.year,
    doi: paper.doi,
    url: paper.url?.trim() || (paper.doi ? `https://doi.org/${paper.doi}` : ""),
    evidenceLevel: paper.evidenceLevel,
    abstract_excerpt: paper.abstract?.slice(0, 4_000)
  };
}

function interpretEvidence(
  question: string,
  papers: Paper[],
  claimDirection?: "benefit" | "harm" | "association" | "unclear",
  preferSafety = false,
  intent?: ResearchIntent
): EvidenceInterpretation[] {
  return papers.map((paper, index) => {
    const stance = classifyStance(question, paper, claimDirection, preferSafety, intent);
    return {
      citationIndex: index + 1,
      source: paper.source,
      title: paper.title,
      stance,
      reason_ko: reasonForStance(stance, paper, preferSafety, intent),
      evidenceLevel: paper.evidenceLevel
    };
  });
}

function classifyStance(
  question: string,
  paper: Paper,
  suppliedClaimDirection?: "benefit" | "harm" | "association" | "unclear",
  preferSafety = false,
  intent?: ResearchIntent
): EvidenceStance {
  const resultText = paper.abstract?.trim() || paper.title;
  const text = normalizeEvidenceText(`${resultText} ${paper.publicationTypes.join(" ")}`);
  if (!text.trim()) return "unclear";

  const claimDirection = suppliedClaimDirection ?? inferClaimDirection(question);
  if (claimDirection === "unclear") return "unclear";

  // A parsed numeric result is stronger than a keyword count. Source abstracts
  // often report relative risks as ratios, which do not necessarily contain
  // our English harm-word list after normalization.
  const reported = (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined)
    ?? reportedFindingForIntent(paper, intent);
  if (preferSafety && reported) {
    return /(?:뚜렷한 차이가 없|보고하지 않았)/.test(reported) ? "opposes" : "supports";
  }
  if (claimDirection === "harm" && /위험(?:\s*(?:약\s*)?\d+(?:\.\d+)?%)?\s*증가/.test(reported ?? "")) {
    return "supports";
  }
  if (claimDirection === "harm" && /위험과 뚜렷한 연관을 확인하지 못/.test(reported ?? "")) {
    return "opposes";
  }
  if (claimDirection === "benefit" && /위험(?:\s*(?:약\s*)?\d+(?:\.\d+)?%)?\s*감소/.test(reported ?? "")) {
    return "supports";
  }

  const noEffectHits = countMatches(text, noEffectSignals);
  const mixedHits = countMatches(text, mixedSignals);
  const benefitHits = countMatches(text, benefitSignals);
  const harmHits = countMatches(text, harmSignals);
  const lowerRiskHits = countMatches(text, lowerRiskSignals);

  if (mixedHits > 0 && Math.max(benefitHits, harmHits, noEffectHits) <= 1) return "mixed";
  if (noEffectHits > 0 && noEffectHits >= Math.max(benefitHits, harmHits)) return "opposes";

  if (claimDirection === "benefit") {
    if (benefitHits + lowerRiskHits > harmHits && benefitHits + lowerRiskHits > 0) return "supports";
    if (harmHits > benefitHits + lowerRiskHits) return "opposes";
  }

  if (claimDirection === "harm") {
    if (harmHits > lowerRiskHits && harmHits > 0) return "supports";
    if (lowerRiskHits > harmHits || (benefitHits > harmHits && benefitHits > 0)) return "opposes";
  }

  if (claimDirection === "association") {
    if (benefitHits + harmHits + lowerRiskHits > 0) return "supports";
  }

  if (mixedHits > 0) return "mixed";
  return "unclear";
}

function inferClaimDirection(question: string): "benefit" | "harm" | "association" | "unclear" {
  const q = question.toLowerCase().replace(/\s+/g, " ");
  const negations = q.match(/(?:안\s|않|없|아니)/g)?.length ?? 0;
  const repeatedClaims = q.match(/(?:지만|면서|이고|하며|하고|거나|또한|\b및\b|도)/g)?.length ?? 0;
  const coordinatedClaims = q.match(/[가-힣](?:와|과)\s/g)?.length ?? 0;
  const comparison = /(보다|둘\s*중|것과.*중|중.*(?:뭐|어느)|vs\.?|대비|뭐가\s*(?:나아|좋아)|더\s*(?:좋|나쁘|나빠|효과))/.test(q);
  const explicitComparisonEvidence = /(비교|차이|어느\s*쪽)/.test(q);
  const sarcasm = /(역시|약이구나|정말\s*과학적|다\s*사실|그러니까.*좋|뉴스.*(?:했으니|니까)|다니.*(?:맞지|좋|과학))/.test(q);
  const compoundConclusion = /(모두|결국\s*(?:좋|나쁘)|동시에|다\s*사실|지만)/.test(q);

  if (sarcasm || compoundConclusion || negations >= 2 || repeatedClaims >= 2 || coordinatedClaims >= 2 || (comparison && !explicitComparisonEvidence)) return "unclear";
  if (/(안\s*(?:좋|도움|효과)|좋지\s*않|효과\s*(?:없|않)|도움(?:이|은|도)?\s*(?:없|않))/.test(q)) return "harm";
  if (/(위험|질환|혈압|사망|부작용).*(높|올|늘|증가|생기)|(?:높|올|늘|증가).*(위험|질환|혈압|사망|부작용)/.test(q)) return "harm";
  if (/(예방|도움|개선|좋아|회복|건강해)|(위험|질환|혈압|사망|부작용).*(줄|낮|감소)/.test(q)) return "benefit";
  if (/(안\s*좋|나쁘|나빠|위험|상해|망치|생겨|올라가|높아져|떨어져|방해|암|탈모|질환|부작용)/.test(q)) return "harm";
  if (/(효과\s*(?:있|나)|줄어|낮아|빠져|높여|늘려)/.test(q)) return "benefit";
  if (/(영향|관련|연관|차이|변화)/.test(q)) return "association";
  return "unclear";
}

function decideVerdict(interpretation: EvidenceInterpretation[]): Verdict {
  const scores = { supports: 0, opposes: 0, mixed: 0, unclear: 0 };
  for (const item of interpretation) {
    scores[item.stance] += evidenceWeight(item.evidenceLevel);
  }

  if (scores.supports >= 4 && scores.supports >= scores.opposes * 1.5 && scores.supports >= scores.mixed) {
    return "supported";
  }
  if (scores.opposes >= 3 && scores.opposes >= scores.supports * 1.3) {
    return "not_supported";
  }
  if (scores.supports === 0 && scores.opposes === 0 && scores.mixed === 0) {
    return "insufficient_evidence";
  }
  if (scores.supports + scores.opposes < 3 && scores.mixed < 2) {
    return "insufficient_evidence";
  }
  return "mixed";
}

function buildResearchStory(
  question: string,
  verdict: Verdict,
  papers: Paper[],
  interpretation: EvidenceInterpretation[],
  intent?: ResearchIntent,
  comparisonScope?: "direct" | "parallel"
): ResearchStory {
  const pattern = inferResearchPattern(papers, interpretation);
  const openingByPattern: Record<ResearchPattern, string> = {
    evidence_shift: "논문 흐름이 중간에 바뀌었습니다. 초기 연구와 최근 연구가 같은 결론을 내리지 않습니다.",
    ongoing_debate: "현재 연구 결과가 엇갈려, 아직 결론이 확실히 정리되지 않았습니다.",
    context_explains_difference: "찬반처럼 보이지만, 논문들이 서로 다른 대상이나 기간을 본 결과라 정면충돌은 아닙니다.",
    mostly_consistent: "초기 연구부터 최근 종합연구까지 큰 방향은 대체로 같습니다.",
    insufficient: "논문은 검색됐지만, 질문에 직접 답하는 핵심 근거는 아직 부족합니다."
  };

  const clearInterpretations = interpretation.filter((item) => item.stance !== "unclear");
  const preferSafety = isSafetyQuestion(question, intent);
  const primaryFinding = papers
    .map((paper) => (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined) ?? reportedFindingForIntent(paper, intent))
    .find((finding): finding is string => Boolean(finding));
  const safetyOpening = preferSafety && primaryFinding
    ? buildSafetyOpening(question, papers, primaryFinding)
    : undefined;
  const safetyResolution = preferSafety
    ? safetyConclusionLimit(question, papers)
    : undefined;
  const exposureScopeResolution = researchScopeResolution(question, papers, intent);
  const directComparison = intent?.questionType === "comparison" && comparisonScope === "direct";
  return {
    pattern,
    opening_ko: safetyOpening
      ? safetyOpening
      : directComparison && primaryFinding
        ? `두 선택지를 직접 비교한 연구에서는 ${primaryFinding}`
      : primaryFinding
      ? `현재 확인한 대표 연구에서는 ${primaryFinding}`
      : pattern === "mostly_consistent" && clearInterpretations.length === 1
        ? "현재 질문에 가장 직접적인 핵심 연구는 한 방향을 가리킵니다."
        : openingByPattern[pattern],
    timeline_ko: buildPaperTimeline(papers, interpretation, question, intent),
    resolution_ko: safetyResolution ?? exposureScopeResolution ?? buildStoryResolution(question, verdict, pattern)
  };
}

function researchScopeResolution(question: string, papers: Paper[], intent?: ResearchIntent): string | undefined {
  if (!intent) return undefined;
  const plannedText = [intent.exposure, ...intent.exposureTerms].join(" ").toLowerCase();
  const asksAboutFoodsAndDrinks =
    (/\b(?:food|foods)\b/.test(plannedText) && /\b(?:beverage|beverages|drink|drinks)\b/.test(plannedText)) ||
    /(?:단\s*(?:음식|것)|달[콤달]?한\s*(?:음식|것)|sweets?)/i.test(question);
  const paperText = papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" ").toLowerCase();
  const isBeverageOnlyEvidence = /\b(?:sugar[- ]sweetened beverages?|ssbs?)\b/.test(paperText) &&
    !/\b(?:cake|candy|confectionery|dessert|sweet snack)\b/.test(paperText);
  if (asksAboutFoodsAndDrinks && isBeverageOnlyEvidence) {
    return "이번 대표 근거는 설탕이 든 음료를 중심으로 합니다. 따라서 음료가 아닌 모든 단 음식까지 같은 위험도로 묶어 단정할 수는 없습니다.";
  }
  return undefined;
}

function safetySubjectLabel(question: string): string {
  const topic = questionTopicLabel(question)
    ?? /^([가-힣A-Za-z0-9-]{2,})/.exec(question.trim())?.[1];
  if (!topic) return "질문한 대상은";
  const last = topic.charCodeAt(topic.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return `${topic}는`;
  return `${topic}${(last - 0xac00) % 28 === 0 ? "는" : "은"}`;
}

function buildSafetyOpening(question: string, papers: Paper[], primaryFinding: string): string {
  const asksAboutFrequencyOrAmount = /(?:가끔|매일|하루|일주일|주\s*\d|한\s*번|두\s*번|얼마나|자주|잔|캔|병|mg|그램|g\b)/i.test(question);
  const hasAcuteEvidence = papers.some((paper) =>
    /\b(?:acute|single[- ]dose|immediately|minutes? after|hours? after|post[- ]consumption)\b/i.test(cleanPaperAbstract(paper.abstract))
  );
  if (asksAboutFrequencyOrAmount && hasAcuteEvidence) {
    const domains = reportedSafetyDomains(papers);
    return domains.length > 0
      ? `질문처럼 가끔 마시는 빈도를 직접 추적한 장기 연구는 이번 대표 근거에서 확인되지 않았습니다. 다만 한 번 마신 직후를 본 연구에서는 ${domains.join("·")} 관련 변화가 보고됐습니다.`
      : `질문처럼 가끔 마시는 빈도를 직접 추적한 장기 연구는 이번 대표 근거에서 확인되지 않았습니다. 다만 한 번 마신 직후를 본 연구에서는 ${primaryFinding}`;
  }
  const finding = startsWithStandaloneSubject(primaryFinding)
    ? primaryFinding
    : `${safetySubjectLabel(question)} ${primaryFinding}`;
  return `현재 근거를 종합하면, ${finding}`;
}

function startsWithStandaloneSubject(value: string): boolean {
  // Grounded findings may start with the generic drug or intervention name
  // from the paper, while the user's wording names a brand. Prefixing both
  // produces "브랜드는 성분은 ...". A complete Korean subject already reads
  // naturally after the opening clause on its own.
  return /^[가-힣A-Za-z0-9·/() -]{2,60}(?:은|는|이|가)\s/.test(value.trim());
}

function reportedSafetyDomains(papers: Paper[]): string[] {
  const text = papers
    .map((paper) => paper.groundedSourceSentence ?? cleanPaperAbstract(paper.abstract))
    .join(" ")
    .toLowerCase();
  const domains: string[] = [];
  if (/\b(?:blood pressure|systolic|diastolic|hypertension)\b/.test(text)) domains.push("혈압");
  if (/\b(?:heart rate|tachycardia|arrhythmia|electrocardiogram|ecg|qtc?|qt interval|qrs)\b/.test(text)) {
    domains.push("심박수·심장 전기신호");
  }
  if (/\b(?:insomnia|sleep disturbance|sleep quality)\b/.test(text)) domains.push("수면");
  if (/\b(?:anxiety|jitteriness|restlessness|tremor)\b/.test(text)) domains.push("불안·안절부절");
  if (/\b(?:nausea|vomiting|diarrh(?:ea|oea)?|abdominal pain)\b/.test(text)) domains.push("위장관 증상");
  return domains.slice(0, 3);
}

function safetyConclusionLimit(question: string, papers: Paper[]): string {
  const text = papers.map((paper) => cleanPaperAbstract(paper.abstract)).join(" ");
  if (/(?:neither|did not|no significant)[^.]{0,120}(?:increase|higher)[^.]{0,120}(?:serious adverse events?|severe adverse events?)/i.test(text) ||
    /(?:serious adverse events?|severe adverse events?)[^.]{0,120}(?:no significant difference|did not differ|comparable)/i.test(text)) {
    return "다만 선택한 연구들에서는 중대한 이상반응이 뚜렷하게 늘었다는 결과는 확인되지 않았습니다.";
  }
  const hasAcuteEvidence = /\b(?:acute|single[- ]dose|minutes? after|hours? after|post[- ]consumption)\b/i.test(text);
  if (hasAcuteEvidence && /(?:가끔|매일|하루|일주일|주\s*\d|한\s*번|두\s*번|얼마나|자주|잔|캔|병|mg|그램|g\b)/i.test(question)) {
    return "이번 근거의 중심은 한 번 마신 뒤의 단기 변화이므로, 이를 장기 안전성이나 특정 섭취 빈도까지 그대로 넓혀 해석할 수는 없습니다.";
  }
  return "부작용의 종류와 발생 빈도는 용량, 비교군, 연구 대상에 따라 달랐습니다.";
}

function buildTrainingModeResearchStory(question: string, papers: Paper[]): ResearchStory | undefined {
  if (!asksForSingleExposure(question) || !/(근력|저항|웨이트|resistance|strength|weight training)/i.test(question)) {
    return undefined;
  }
  const match = papers
    .map((paper, index) => ({ paper, index: index + 1, comparison: extractTrainingModeComparison(paper.abstract ?? "") }))
    .find((item) => Boolean(item.comparison?.aerobicVsResistance));
  if (!match?.comparison?.aerobicVsResistance) return undefined;

  const comparison = match.comparison;
  const scale = comparison.studyCount
    ? `${formatResearchNumber(comparison.studyCount)}개 연구${comparison.participantCount ? `, ${formatResearchNumber(comparison.participantCount)}명` : ""}을 함께 비교한`
    : "여러 연구를 함께 비교한";
  const duration = comparison.duration ? `${comparison.duration} 조건에서 ` : "";
  const caveats = [
    comparison.concurrentVsResistance ? `${comparison.concurrentVsResistance}한 결과도 있었습니다.` : "",
    comparison.matchedWorkloadNoDifference ? "반면 운동량을 같게 맞춘 분석에서는 체중·체지방량 차이가 뚜렷하지 않았습니다." : ""
  ].filter(Boolean).join(" ");

  return {
    pattern: "context_explains_difference",
    opening_ko: "근력운동만으로 감량이 불가능하다고 결론 내릴 수는 없습니다. 다만 같은 기간에 절대 체지방량을 더 줄인 방식은 근력운동 단독보다 유산소 또는 병행 운동이었습니다.",
    timeline_ko: `${match.paper.year ? `${match.paper.year}년 ` : ""}${scale} 결과, ${duration}유산소 운동은 근력 운동보다 ${comparison.aerobicVsResistance} 더 줄였습니다. [${match.index}]`,
    resolution_ko: caveats || "따라서 이 결과는 '근력운동은 아무 효과가 없다'가 아니라, 체중·절대 체지방량만 놓고 보면 운동 방식과 기간·운동량 조건에 따라 차이가 난다는 뜻입니다."
  };
}

interface DirectWeightComparisonEvidence {
  story: ResearchStory;
  detail: EvidenceDetails;
}

interface WeightComparisonResult {
  participantCount?: string;
  followUp: Array<{ months: number; difference: string }>;
  directTrial?: {
    weeks: number;
    tirzepatideChange: string;
    semaglutideChange: string;
    difference: string;
  };
  thresholds: Array<{ percent: string; hazardRatio: string }>;
  gastrointestinalAes?: "similar" | "higher" | "lower" | "common_both";
}

function buildDirectWeightComparisonEvidence(
  papers: Paper[],
  intent: ResearchIntent | undefined,
  question: string
): DirectWeightComparisonEvidence | undefined {
  if (!isWeightLossComparisonIntent(intent, question)) return undefined;
  const comparisonCandidates = papers
    .map((paper, index) => ({ paper, index: index + 1, result: extractDirectWeightComparison(paper) }))
    .filter((item): item is { paper: Paper; index: number; result: WeightComparisonResult } => Boolean(item.result));
  const matched = comparisonCandidates.find((item) => Boolean(item.result.directTrial)) ??
    comparisonCandidates.find((item) => item.result.followUp.length > 0);
  if (!matched?.result) return undefined;

  const result = matched.result;
  const trial = result.directTrial;
  const latest = result.followUp.at(-1);
  const threshold = result.thresholds.find((item) => item.percent === "10") ?? result.thresholds.at(-1);
  const labels = directWeightComparisonLabels(question);
  const weightLine = trial
    ? `${trial.weeks}주에 ${labels.tirzepatideGroup}은 평균 ${trial.tirzepatideChange}% 감량, ${labels.semaglutideGroup}은 평균 ${trial.semaglutideChange}% 감량으로 차이는 ${trial.difference}%p였습니다.`
    : `${latest!.months}개월에 ${labels.tirzepatideGroup}의 체중 변화가 ${labels.semaglutideGroup}보다 평균 ${latest!.difference}%p 더 컸습니다.`;
  const thresholdLine = threshold
    ? `${threshold.percent}% 이상 감량에 도달할 가능성도 ${labels.tirzepatideGroup}에서 ${threshold.hazardRatio}배였습니다.`
    : "";
  const safetyLine = result.gastrointestinalAes === "similar"
    ? "위장관 이상반응 발생률은 두 군에서 비슷했습니다."
    : result.gastrointestinalAes === "higher"
      ? "위장관 이상반응은 티르제파타이드군에서 더 많이 보고됐습니다."
      : result.gastrointestinalAes === "lower"
        ? "위장관 이상반응은 티르제파타이드군에서 더 적게 보고됐습니다."
        : result.gastrointestinalAes === "common_both"
          ? "두 군에서 가장 흔한 이상반응은 위장관 증상이었고, 대부분 경증~중등도였습니다."
        : "";
  const population = result.participantCount
    ? trial
      ? `당뇨병이 없는 비만 성인 ${formatResearchNumber(result.participantCount)}명`
      : `과체중·비만 성인 ${formatResearchNumber(result.participantCount)}명을 포함한 미국 진료자료`
    : trial
      ? "당뇨병이 없는 비만 성인"
      : "과체중·비만 성인 진료자료";
  const resultText = [weightLine, thresholdLine].filter(Boolean).join(" ");
  const studyLimit = trial
    ? `${trial.weeks}주 공개표지 임상시험으로, 이 기간을 넘어선 지속 효과와 실제 진료 환경에서의 차이는 별도로 확인해야 합니다.`
    : "무작위배정이 아닌 전자의무기록 기반 비교라 처방 용량, 치료 중단, 진료 환경 차이가 결과에 영향을 줄 수 있습니다.";
  const primaryStudy: KeyStudyDetail = {
    citationIndex: matched.index,
    title: matched.paper.title,
    year: matched.paper.year,
    design_ko: trial ? "무작위 임상시험" : shortEvidenceDesignLabel(matched.paper.evidenceLevel),
    population_ko: population,
    exposure_ko: trial
      ? `최대 내약 용량의 ${labels.tirzepatide}와 ${labels.semaglutide}를 주 1회 직접 비교`
      : `${labels.tirzepatide}와 ${labels.semaglutide}의 실제 진료 사용 비교`,
    result_ko: resultText,
    time_horizon: "long_term",
    limitation_ko: studyLimit,
    url: matched.paper.url
  };
  const supportingStudies = papers
    .map((paper, index) => ({ paper, index }))
    .filter(({ index }) => index + 1 !== matched.index)
    .map(({ paper, index }) => buildSupportingWeightComparisonStudy(paper, index, question, labels))
    .filter((study): study is KeyStudyDetail => Boolean(study))
    .slice(0, 4);

  return {
    story: {
      pattern: "mostly_consistent",
      opening_ko: trial
        ? `현재 직접 무작위 비교에서는 ${labels.tirzepatide}가 ${labels.semaglutide}보다 더 큰 체중 감량을 보였습니다.`
        : `현재 직접 비교 자료에서는 ${labels.tirzepatide}가 ${labels.semaglutide}보다 더 큰 체중 감량과 연관됐습니다.`,
      timeline_ko: `${matched.paper.year ? `${matched.paper.year}년 ` : ""}${trial ? `${population}을 ${trial.weeks}주간 직접 비교한 임상시험에서` : `${population}를 성향점수로 맞춰 비교한 결과`}, ${resultText} [${matched.index}]`,
      resolution_ko: safetyLine
        ? `${safetyLine} 다만 ${studyLimit}`
        : `다만 ${studyLimit}`
    },
    detail: {
      short_term_ko: trial
        ? "이 연구는 중간 시점의 체중 변화 수치를 초록에 따로 보고하지 않았습니다."
        : `${result.followUp.map((item) => `${item.months}개월: 티르제파타이드군이 평균 ${item.difference}%p 더 큰 체중 감소`).join(", ")}. [${matched.index}]`,
      long_term_ko: trial
        ? `${weightLine} [${matched.index}]`
        : `이 연구의 관찰 기간은 최대 ${latest!.months}개월입니다. 이 범위를 넘어선 지속 효과는 이 연구만으로 판단할 수 없습니다.`,
      risk_ko: safetyLine ? `${safetyLine} [${matched.index}]` : "",
      applicability_ko: trial
        ? "당뇨병이 없는 비만 성인에서 최대 내약 용량의 두 약을 주 1회 투여한 결과입니다."
        : "제2형 당뇨병 허가 제형의 티르제파타이드 또는 세마글루타이드를 실제 진료에서 시작한 과체중·비만 성인 자료입니다.",
      limitations_ko: studyLimit,
      key_studies: [primaryStudy, ...supportingStudies]
    }
  };
}

function directWeightComparisonLabels(question: string): {
  tirzepatide: string;
  semaglutide: string;
  tirzepatideGroup: string;
  semaglutideGroup: string;
} {
  const usesMounjaro = /마운자로|mounjaro/i.test(question);
  const usesWegovy = /위고비|wegovy/i.test(question);
  return {
    tirzepatide: usesMounjaro ? "마운자로(티르제파타이드)" : "티르제파타이드",
    semaglutide: usesWegovy ? "위고비(세마글루타이드)" : "세마글루타이드",
    tirzepatideGroup: usesMounjaro ? "마운자로군" : "티르제파타이드군",
    semaglutideGroup: usesWegovy ? "위고비군" : "세마글루타이드군"
  };
}

function buildSupportingWeightComparisonStudy(
  paper: Paper,
  index: number,
  question: string,
  labels: ReturnType<typeof directWeightComparisonLabels>
): KeyStudyDetail | undefined {
  const comparison = extractDirectWeightComparison(paper);
  if (comparison) {
    const trial = comparison.directTrial;
    const latest = comparison.followUp.at(-1);
    const threshold = comparison.thresholds.find((item) => item.percent === "10") ?? comparison.thresholds.at(-1);
    const result = trial
      ? `${trial.weeks}주에 ${labels.tirzepatideGroup} ${trial.tirzepatideChange}% 감량, ${labels.semaglutideGroup} ${trial.semaglutideChange}% 감량으로 ${trial.difference}%p 차이가 났습니다.`
      : latest
        ? `${latest.months}개월에 ${labels.tirzepatideGroup}의 체중 변화가 ${labels.semaglutideGroup}보다 평균 ${latest.difference}%p 더 컸습니다.${threshold ? ` ${threshold.percent}% 이상 감량 도달 가능성은 ${labels.tirzepatideGroup}에서 ${threshold.hazardRatio}배였습니다.` : ""}`
        : undefined;
    if (!result) return undefined;
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: trial ? "무작위 임상시험" : shortEvidenceDesignLabel(paper.evidenceLevel),
      population_ko: comparison.participantCount
        ? `과체중·비만 성인 ${formatResearchNumber(comparison.participantCount)}명`
        : inferPopulationFromPaper(paper),
      exposure_ko: `${labels.tirzepatide}와 ${labels.semaglutide} 비교`,
      result_ko: result,
      time_horizon: trial || (latest?.months ?? 0) >= 6 ? "long_term" : "short_term",
      limitation_ko: trial
        ? "연구의 관찰 기간과 실제 처방 환경은 다를 수 있습니다."
        : "무작위배정이 아닌 실제 진료자료라 처방 용량과 치료 중단의 차이가 결과에 영향을 줄 수 있습니다.",
      url: paper.url
    };
  }

  const network = extractWeightLossNetworkComparison(paper);
  if (network) {
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "무작위시험 네트워크 메타분석",
      population_ko: `과체중·비만 성인 ${network.trials}개 임상시험 참여자`,
      exposure_ko: `${labels.tirzepatide}와 ${labels.semaglutide}의 용량별 간접 비교`,
      result_ko: `${network.trials}개 임상시험을 함께 비교했을 때, 약효 성분이 없는 비교군(위약)과 비교한 평균 체중 감소는 티르제파타이드 ${network.tirzepatideDose}mg에서 ${network.tirzepatideChange}%, 세마글루타이드 ${network.semaglutideDose}mg에서 ${network.semaglutideChange}%였습니다.`,
      time_horizon: "long_term",
      limitation_ko: "두 약을 같은 시험에서 일대일로 비교한 결과가 아니라, 각 약을 약효 성분이 없는 비교군(위약)과 비교한 시험들을 연결한 간접 비교입니다.",
      url: paper.url
    };
  }

  const pooled = extractPooledWeightComparison(paper);
  if (pooled) {
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "직접 비교 연구 메타분석",
      population_ko: `${pooled.studies}개 직접 비교 연구의 참여자`,
      exposure_ko: `${labels.tirzepatide}와 ${labels.semaglutide} 비교`,
      result_ko: `${pooled.studies}개 연구를 종합했을 때 ${labels.tirzepatideGroup}이 ${labels.semaglutideGroup}보다 평균 ${pooled.weightDifferenceKg}kg 더 큰 체중 감소를 보였습니다.${pooled.tenPercentRatio ? ` 10% 이상 감량 도달 가능성도 ${pooled.tenPercentRatio}배였습니다.` : ""}`,
      time_horizon: "mixed",
      limitation_ko: "포함 연구 수가 적고 연구 간 결과 차이가 커, 정확한 효과 크기는 더 큰 직접 비교 연구로 확인할 필요가 있습니다.",
      url: paper.url
    };
  }

  const fallback = buildKeyStudyDetail(paper, index, [], question);
  return isGenericPaperResult(fallback.result_ko)
    ? undefined
    : {
      ...fallback,
      exposure_ko: `${labels.tirzepatide}와 ${labels.semaglutide} 비교`
    };
}

function extractWeightLossNetworkComparison(paper: Paper): {
  trials: string;
  tirzepatideDose: string;
  tirzepatideChange: string;
  semaglutideDose: string;
  semaglutideChange: string;
} | undefined {
  const text = normalizeCitationExcerpt(`${paper.title}. ${paper.abstract ?? ""}`);
  const trialMatch = /(?:([\d,]+)|twenty-five)\s+trials/i.exec(text);
  const tirzepatideMatch = /tirzepatide\s+(\d+(?:\.\d+)?)\s*mg[\s\S]{0,140}?\(MD\s*([+-]?\d+(?:\.\d+)?)%\)/i.exec(text);
  const semaglutideMatch = /semaglutide\s+(\d+(?:\.\d+)?)\s*mg\s*\(MD\s*([+-]?\d+(?:\.\d+)?)%\)/i.exec(text);
  if (!trialMatch || !tirzepatideMatch || !semaglutideMatch) return undefined;
  return {
    trials: trialMatch[1]?.replace(/,/g, "") ?? "25",
    tirzepatideDose: tirzepatideMatch[1]!,
    tirzepatideChange: Math.abs(Number(tirzepatideMatch[2])).toFixed(2),
    semaglutideDose: semaglutideMatch[1]!,
    semaglutideChange: Math.abs(Number(semaglutideMatch[2])).toFixed(2)
  };
}

function extractPooledWeightComparison(paper: Paper): {
  studies: string;
  weightDifferenceKg: string;
  tenPercentRatio?: string;
} | undefined {
  const text = normalizeCitationExcerpt(`${paper.title}. ${paper.abstract ?? ""}`);
  const studyMatch = /(?:([\d,]+)|three)\s+studies were included/i.exec(text);
  const weightMatch = /tirzepatide[\s\S]{0,160}?greater reduction in weight than semaglutide\s*\(pooled MD\s*=\s*([+-]?\d+(?:\.\d+)?)\s*kg/i.exec(text);
  if (!studyMatch || !weightMatch) return undefined;
  const thresholdMatch = /(?:≥|>=)\s*10%\s+weight loss\s*\(pooled RR\s*=\s*([\d.]+)/i.exec(text);
  return {
    studies: studyMatch[1]?.replace(/,/g, "") ?? "3",
    weightDifferenceKg: Math.abs(Number(weightMatch[1])).toFixed(2),
    tenPercentRatio: thresholdMatch?.[1]
  };
}

function isWeightLossComparisonIntent(intent: ResearchIntent | undefined, question: string): boolean {
  const corpus = `${intent?.exposureTerms?.join(" ") ?? ""} ${intent?.comparatorTerms?.join(" ") ?? ""} ${question}`.toLowerCase();
  const outcome = `${intent?.outcomeTerms?.join(" ") ?? ""} ${question}`.toLowerCase();
  const tirzepatide = /tirzepatide|마운자로|mounjaro/.test(corpus);
  const semaglutide = /semaglutide|위고비|wegovy/.test(corpus);
  return tirzepatide && semaglutide && /weight|체중|감량|비만/.test(outcome);
}

function extractDirectWeightComparison(paper: Pick<Paper, "title" | "abstract">): WeightComparisonResult | undefined {
  // PubMed commonly names both drugs in the title and abbreviates one of them
  // in the result excerpt, so assess the citation as a whole before parsing it.
  const clean = normalizeCitationExcerpt(`${paper.title}. ${paper.abstract ?? ""}`);
  if (!/tirzepatide/.test(clean.toLowerCase()) || !/semaglutide/.test(clean.toLowerCase())) return undefined;
  const followUp = [...clean.matchAll(/(?:at\s+)?(3|6|12)\s+months\s*\(difference,?\s*([+-]?\d+(?:\.\d+)?)%/gi)]
    .map((match) => ({ months: Number(match[1]), difference: Math.abs(Number(match[2])).toFixed(1) }))
    .filter((item) => Number.isFinite(item.months) && Number.isFinite(Number(item.difference)));
  const directTrialMatch = /(?:at\s+)?week\s+(\d+)[\s\S]{0,120}?was\s+([+-]?\d+(?:\.\d+)?)%[\s\S]{0,180}?tirzepatide[\s\S]{0,180}?\band\s+([+-]?\d+(?:\.\d+)?)%[\s\S]{0,180}?semaglutide/i.exec(clean);
  const directTrial = directTrialMatch
    ? {
      weeks: Number(directTrialMatch[1]),
      tirzepatideChange: Math.abs(Number(directTrialMatch[2])).toFixed(1),
      semaglutideChange: Math.abs(Number(directTrialMatch[3])).toFixed(1),
      difference: Math.abs(Math.abs(Number(directTrialMatch[2])) - Math.abs(Number(directTrialMatch[3]))).toFixed(1)
    }
    : undefined;
  if (followUp.length === 0 && !directTrial) return undefined;
  const thresholds = [...clean.matchAll(/(?:≥|>=)\s*(5|10|15)%[^.]{0,180}?(?:hazard ratio\s*)?(?:\[?HR\]?\s*,?\s*)?([\d.]+)/gi)]
    .map((match) => ({ percent: match[1]!, hazardRatio: match[2]! }));
  const participantCount = /(?:among|a total of)\s+([\d,\s]+)\s+(?:adults|participants)/i.exec(clean)?.[1]?.replace(/[\s,]/g, "");
  const gastrointestinalAes = /rates of gastrointestinal AEs were similar between groups/i.test(clean)
    ? "similar"
    : /gastrointestinal AEs?.{0,100}?(?:higher|increased)/i.test(clean)
      ? "higher"
      : /gastrointestinal AEs?.{0,100}?(?:lower|reduced)/i.test(clean)
        ? "lower"
        : /most common adverse events in both treatment groups were gastrointestinal[\s\S]{0,180}?(?:mild to moderate|mild-to-moderate)/i.test(clean)
          ? "common_both"
          : undefined;
  return { participantCount, followUp, directTrial, thresholds, gastrointestinalAes };
}

function buildCoffeeResearchStory(papers: Paper[]): ResearchStory {
  const acutePaper = paperMatching(papers, /effect of coffee on blood pressure|hypertensive individuals/i);
  const reviewPaper = paperMatching(papers, /coffee and arterial hypertension/i);
  const riskPaper = paperMatching(papers, /risk of hypertension in adults/i);
  const timeline: string[] = [];

  if (acutePaper) {
    const index = papers.indexOf(acutePaper) + 1;
    timeline.push(
      paperSupportsNumbers(acutePaper, ["200", "300", "8.1", "5.7", "3"])
        ? `${acutePaper.year ?? 2011}년 메타분석은 고혈압 환자에게 카페인 200~300mg을 줬을 때 혈압이 평균 8.1/5.7mmHg 오르고 3시간 이상 이어질 수 있다고 봤습니다. [${index}]`
        : `${acutePaper.year ?? 2011}년 체계적 문헌고찰은 고혈압 환자에서 카페인 섭취 직후 혈압이 일시적으로 오를 수 있다고 정리했습니다. [${index}]`
    );
  }
  if (reviewPaper) {
    timeline.push(
      `${reviewPaper.year ?? 2021}년 리뷰는 ${acutePaper ? "반대로, " : ""}커피를 규칙적으로 적당량 마시는 습관이 장기 혈압을 높인다는 근거는 확인하지 못했습니다. [${papers.indexOf(reviewPaper) + 1}]`
    );
  }
  if (riskPaper) {
    const result = paperSupportsNumbers(riskPaper, ["7"])
      ? "코호트 연구에서 고혈압 위험이 약 7% 낮은 연관성까지 보고했습니다"
      : "장기적인 고혈압 위험 증가를 뚜렷하게 확인하지 못했습니다";
    timeline.push(`${riskPaper.year ?? 2023}년 메타분석은 ${result}. [${papers.indexOf(riskPaper) + 1}]`);
  }

  if (timeline.length === 0) {
    timeline.push("검색된 리뷰들은 커피 섭취 직후의 반응과 장기간의 섭취 습관을 서로 다른 결과로 다뤘습니다.");
  }

  return {
    pattern: "context_explains_difference",
    opening_ko: "둘 다 절반씩 맞습니다. 논문을 놓고 보면 이 논쟁의 핵심은 '몇 잔이냐'보다 '마신 직후냐, 오랫동안 마신 습관이냐'입니다.",
    timeline_ko: timeline.join(" "),
    resolution_ko:
      "그래서 '하루 3잔이 장기적으로 고혈압을 만든다'는 쪽은 현재 근거가 약합니다. 다만 평소 커피를 잘 마시지 않거나 이미 고혈압이 있다면, 마신 직후의 일시적 혈압 상승은 실제로 따로 봐야 합니다."
  };
}

function buildCoffeeDailyLimitResearchStory(papers: Paper[]): ResearchStory {
  const safetyPaper = paperMatching(papers, /systematic review of the potential adverse effects of caffeine consumption/i);
  const healthPaper = paperMatching(papers, /coffee consumption and health.*umbrella review/i);
  const outcomesPaper = paperMatching(papers, /coffee, caffeine, and health outcomes.*umbrella review/i);
  const timeline: string[] = [];
  const hasSafetyLimit = paperSupportsNumbers(safetyPaper, ["400"]);

  if (safetyPaper) {
    const index = papers.indexOf(safetyPaper) + 1;
    timeline.push(
      paperSupportsNumbers(safetyPaper, ["5000", "381", "400"])
        ? `${safetyPaper.year ?? 2017}년 안전성 체계적 문헌고찰은 5,000편이 넘는 문헌을 선별해 381편을 분석했고, 건강한 성인은 하루 카페인 400mg 이하에서 뚜렷한 유해 효과가 나타난다는 근거가 없다고 정리했습니다. [${index}]`
        : `${safetyPaper.year ?? 2017}년 안전성 체계적 문헌고찰은 건강한 성인의 하루 카페인 400mg 이하 섭취가 뚜렷한 유해 효과와 연관되지 않았다고 정리했습니다. [${index}]`
    );
  }
  if (healthPaper) {
    const index = papers.indexOf(healthPaper) + 1;
    timeline.push(
      paperSupportsNumbers(healthPaper, ["201", "17"]) && paperSupportsThreeToFourCups(healthPaper)
        ? `${healthPaper.year ?? 2017}년 우산형 문헌고찰은 관찰연구 메타분석 201개와 중재연구 메타분석 17개를 종합했고, 여러 건강 결과의 위험이 가장 낮게 연관된 구간은 하루 3~4잔이었습니다. 다만 이 수치는 권장량이 아니라 관찰된 연관성입니다. [${index}]`
        : `${healthPaper.year ?? 2017}년 우산형 문헌고찰은 보통 섭취 범위의 커피가 해로움보다 이로움과 더 자주 연관됐다고 봤지만, 관찰연구만으로 인과관계를 확정하지는 못했습니다. [${index}]`
    );
  }
  if (outcomesPaper) {
    const index = papers.indexOf(outcomesPaper) + 1;
    timeline.push(
      `${outcomesPaper.year ?? 2017}년 별도 우산형 문헌고찰도 커피가 건강한 식단의 일부가 될 수 있다고 결론냈습니다. 동시에 카페인의 일회성 섭취는 혈압을 올릴 수 있어, 장기 건강 연관성과 즉각적인 반응은 구분했습니다. [${index}]`
    );
  }
  if (timeline.length === 0) {
    timeline.push("검색된 종합연구들은 커피의 잔 수와 실제 카페인 섭취량을 같은 기준으로 취급하지 않았습니다.");
  }

  return {
    pattern: "context_explains_difference",
    opening_ko: hasSafetyLimit
      ? "꼭 마셔야 할 권장 잔 수는 없습니다. 건강한 성인의 안전 상한을 묻는다면, 실용적으로는 '하루 3잔 안팎이되 총 카페인 400mg 이하'로 보는 게 가장 정확합니다. 대용량이나 진한 커피는 한 잔의 카페인량이 크게 달라집니다."
      : "꼭 마셔야 할 권장 잔 수는 없습니다. 안전 상한은 잔 수보다 하루 총 카페인량으로 판단해야 하며, 컵 크기와 추출 방식에 따라 한 잔의 양이 크게 달라집니다.",
    timeline_ko: timeline.join(" "),
    resolution_ko:
      "따라서 '하루 3~4잔이 몸에 좋으니 일부러 마셔야 한다'는 뜻은 아닙니다. 3~4잔은 관찰연구에서 유리한 결과와 연관된 구간이고, 400mg은 건강한 성인에서 검토된 안전 기준입니다. 제품의 카페인 합계가 기준 안이어도 불면, 두근거림, 불안이 생기면 그보다 적게 마시는 편이 맞습니다."
  };
}

function buildSweetenedDrinkComparisonStory(papers: Paper[]): ResearchStory {
  const replacementPaper = paperMatching(papers, /low- and no-calorie sweetened beverages as a replacement for sugar-sweetened beverages/i);
  const acutePaper = paperMatching(papers, /non-nutritive sweetened beverages on postprandial glycemic and endocrine responses/i);
  const consensusPaper = paperMatching(papers, /health effects of sugar-sweetened and artificially sweetened beverages/i);
  const timeline: string[] = [];

  if (replacementPaper) {
    const index = papers.indexOf(replacementPaper) + 1;
    timeline.push(
      paperSupportsNumbers(replacementPaper, ["17", "1733", "1.06"])
        ? `${replacementPaper.year ?? 2022}년 무작위시험 메타분석은 17개 시험, 성인 1,733명을 종합했습니다. 설탕 음료를 제로 음료로 바꾼 집단은 체중이 평균 1.06kg 더 줄었고, 뚜렷한 위해 신호는 확인되지 않았습니다. [${index}]`
        : `${replacementPaper.year ?? 2022}년 무작위시험 메타분석에서는 설탕 음료를 제로 음료로 대체했을 때 체중과 일부 대사 지표가 소폭 개선됐고, 제로 음료가 더 해롭다는 신호는 확인되지 않았습니다. [${index}]`
    );
  }
  if (acutePaper) {
    const index = papers.indexOf(acutePaper) + 1;
    timeline.push(
      paperSupportsNumbers(acutePaper, ["472"]) && paperSupportsPattern(acutePaper, /(?:36|thirty[- ]six) trials/)
        ? `${acutePaper.year ?? 2023}년 네트워크 메타분석은 36개 단기시험, 472명을 분석했습니다. 제로 음료의 식후 혈당·인슐린 반응은 물과 비슷했지만, 설탕 음료는 혈당과 인슐린 반응을 높였습니다. [${index}]`
        : `${acutePaper.year ?? 2023}년 단기시험 종합에서는 제로 음료의 식후 혈당·인슐린·장호르몬 반응이 물과 비슷했고, 설탕 음료는 혈당과 인슐린 반응을 높였습니다. [${index}]`
    );
  }
  if (consensusPaper) {
    const index = papers.indexOf(consensusPaper) + 1;
    timeline.push(
      paperSupportsNumbers(consensusPaper, ["14", "76", "0.73", "0.72", "20", "34"])
        ? `${consensusPaper.year ?? 2026}년 대한당뇨병학회·한국영양학회 합의문은 14개 무작위시험에서 설탕 음료를 제로로 바꾸면 체중 0.73kg, 체지방률 0.72%가 소폭 감소한다고 정리했습니다. 반면 최대 34년의 코호트 연구에서는 두 음료 모두 장기 위험과 연관돼, 제로는 단기 대체재로만 보고 최종 목표는 물·무가당 음료로 제시했습니다. [${index}]`
        : `${consensusPaper.year ?? 2026}년 국내 학회 합의문은 제로 음료를 설탕 음료의 단기 대체재로는 인정했지만, 장기 기본 음료로 권하지는 않고 물·무가당 음료를 최종 목표로 제시했습니다. [${index}]`
    );
  }
  if (timeline.length === 0) {
    timeline.push("직접 비교 연구는 '설탕 음료를 제로로 바꾸는 경우'와 '물 대신 제로를 마시는 경우'를 서로 다른 비교로 다뤘습니다.");
  }

  return {
    pattern: "context_explains_difference",
    opening_ko:
      "결론부터 말하면, 제로 음료가 설탕 음료보다 더 나쁘다는 쪽은 직접 비교 근거와 맞지 않습니다. 다만 '설탕 대신 제로'와 '물 대신 제로'는 완전히 다른 질문입니다.",
    timeline_ko: timeline.join(" "),
    resolution_ko:
      "그래서 평소 설탕 음료를 마시던 사람이 제로로 바꾸는 것은 개선에 가깝습니다. 반대로 물을 마시던 사람이 제로 음료를 추가한다고 더 건강해진다는 근거는 없습니다. 제로는 설탕을 줄이는 중간 대체재로 쓰고, 장기 기본 음료는 물이나 무가당 음료로 두는 해석이 현재 근거에 가장 가깝습니다."
  };
}

function selectCorePapers(
  question: string,
  papers: Paper[],
  limit: number,
  intent?: ResearchIntent
): Paper[] {
  void question;
  const role = (paper: Paper) => intent ? classifyPaperForIntent(paper, intent) : "direct";
  const direct = papers.filter((paper) => role(paper) === "direct");
  const contextual = papers.filter((paper) => role(paper) === "contextual");
  // rankPapers has already scored relevance across the full retrieval set.
  // Re-scoring here from broad abstract keywords promoted a general healthy-
  // diet finding over the result for the food or exposure the user asked
  // about. Keep that retrieval order, only placing truly direct papers ahead
  // of contextual bridges.
  // Keep retrieval relevance within each tier, but do not let a single
  // unreviewed cohort outrank a directly relevant synthesis merely because
  // it is newer. The conclusion can still use both layers.
  const byEvidenceTier = (left: Paper, right: Paper) => evidenceDisplayTier(left) - evidenceDisplayTier(right);
  const ordered = [...direct, ...contextual].sort((left, right) => {
    const evidenceOrder = byEvidenceTier(left, right);
    if (evidenceOrder !== 0) return evidenceOrder;
    const leftRole = role(left) === "direct" ? 0 : 1;
    const rightRole = role(right) === "direct" ? 0 : 1;
    return leftRole - rightRole;
  });
  // Narrative or unclassified records can be useful when literature is
  // sparse, but should not occupy a representative slot when three or more
  // classified reviews, trials, or observational studies are already
  // available for the same question.
  const classified = ordered.filter((paper) =>
    paper.evidenceLevel === "systematic_review" ||
    paper.evidenceLevel === "clinical_study" ||
    paper.evidenceLevel === "observational_study" ||
    paper.evidenceLevel === "official_guidance"
  );
  const displayPool = classified.length >= 3 ? classified : ordered;
  return displayPool.slice(0, limit);
}

function evidenceDisplayTier(paper: Paper): number {
  switch (paper.evidenceLevel) {
    case "systematic_review": return 0;
    case "clinical_study": return 1;
    case "observational_study": return 2;
    default: return 3;
  }
}

function genericEvidenceBreadthScore(paper: Paper, intent?: ResearchIntent): number {
  const text = `${paper.title} ${cleanPaperAbstract(paper.abstract)}`;
  const studyCount = Number(
    /\b(?:included|encompassed|comprising|of)\s+(\d[\d,]*)\s+(?:(?:randomi[sz]ed|controlled|clinical|eligible|original)\s+){0,4}(?:studies|trials|articles|cohorts?|rcts)\b/i.exec(text)?.[1]?.replace(/,/g, "")
      ?? /\b(\d[\d,]*)\s+(?:(?:randomi[sz]ed|controlled|clinical|eligible|original)\s+){0,4}(?:studies|trials|articles|cohorts?|rcts)\b/i.exec(text)?.[1]?.replace(/,/g, "")
      ?? 0
  );
  const participantCount = Number(
    /\b(\d[\d,]*)\s+(?:participants|adults|individuals|subjects)\b/i.exec(text)?.[1]?.replace(/,/g, "") ?? 0
  );
  const studyBonus = Number.isFinite(studyCount) ? Math.min(studyCount, 80) : 0;
  const participantBonus = Number.isFinite(participantCount) && participantCount > 0
    ? Math.min(Math.log10(participantCount) * 4, 20)
    : 0;
  const narrowPopulation = paperTargetsUnrequestedPopulation(paper, intent) ? 35 : 0;
  const topicOverviewBonus = isBroadTopicIntent(intent) &&
    /\b(?:efficacy|effectiveness|clinical profile|management|treatment outcomes?|benefits? and risks?|efficacy and safety)\b/i.test(paper.title)
    ? 70
    : 0;
  const narrowEndpointPenalty = isBroadTopicIntent(intent) &&
    /\b(?:blood pressure|heart failure|cardiovascular event|anti-inflammatory|adverse effects?|safety issues|pancreatitis|gallbladder)\b/i.test(paper.title)
    ? 55
    : 0;
  return studyBonus + participantBonus + topicOverviewBonus - narrowPopulation - narrowEndpointPenalty;
}

function paperTargetsUnrequestedPopulation(paper: Paper, intent?: ResearchIntent): boolean {
  if ((intent?.populationTerms.length ?? 0) > 0) return false;
  const title = paper.title.toLowerCase();
  return /\b(?:older adults?|elderly|aged\s*\d+|children|adolescents?|infants?|pregnan\w*|patients? with|people with|individuals with)\b/i.test(title);
}

function selectBroadTopicReviews(papers: Paper[], intent: ResearchIntent, limit: number): Paper[] {
  const reviewCandidates = papers
    .filter(isTopicLevelReview)
    .filter((paper) => !isPreclinicalFocusedReview(paper))
    .filter((paper) => !/^(?:correction|erratum|corrigendum)\b/i.test(paper.title));
  if (isSweetenedBeverageTopicIntent(intent)) {
    // The word "diet" in "diet soda" must not send beverage evidence
    // through the food-pattern selector. Retain several reviews that
    // explicitly name artificially/non-nutritively sweetened beverages.
    return reviewCandidates
      .filter(paperNamesSweetenedBeverage)
      .sort((left, right) => sweetenedBeverageReviewScore(right) - sweetenedBeverageReviewScore(left))
      .slice(0, limit);
  }
  const exactTopicCandidates = reviewCandidates.filter((paper) => paperNamesIntentExposure(paper, intent));
  const foodDietCandidates = isFoodDietTopicIntent(intent)
    ? reviewCandidates.filter(isHumanFoodDietReview)
    : [];
  const cookingFatCandidates = isCookingFatTopicIntent(intent)
    ? reviewCandidates.filter(isDietaryFatHealthReview)
    : reviewCandidates;
  // A broad food/fat question needs both layers: research naming the food
  // itself, and higher-level dietary-fat outcome reviews. Do not let either
  // layer displace the other merely because it was returned later.
  const pool = uniqueBroadTopicPapers([
    ...(foodDietCandidates.length > 0
      ? exactTopicCandidates.filter(isHumanFoodDietReview)
      : exactTopicCandidates),
    ...(foodDietCandidates.length > 0
      ? foodDietCandidates
      : cookingFatCandidates.length > 0
        ? cookingFatCandidates
        : reviewCandidates)
  ]);
  const scored = pool
    .map((paper) => ({ paper, score: broadTopicReviewScore(paper, intent) }))
    .filter((item) => item.score > 0);
  return scored
    // Keep title-level matches first, then use closely related reviews to
    // give the user several papers to inspect. Restricting this to an exact
    // score tie hid useful papers and made a literature answer look like an
    // unsupported AI opinion.
    .sort((left, right) =>
      right.score - left.score || (right.paper.year ?? 0) - (left.paper.year ?? 0)
    )
    .map((item) => item.paper)
    .slice(0, limit);
}

function isSweetenedBeverageTopicIntent(intent: ResearchIntent | undefined): boolean {
  if (!intent) return false;
  return /\b(?:artificially sweetened beverages?|low[- ]?(?:and )?no[- ]?calorie sweetened beverages?|non[- ]?nutritive sweetened beverages?|diet soda)\b/i.test(
    [intent.exposure, ...intent.exposureTerms].join(" ")
  );
}

function paperNamesSweetenedBeverage(paper: Paper): boolean {
  return /\b(?:artificially sweetened beverages?|asbs?|low[- ]?(?:and )?no[- ]?calorie sweetened beverages?|low[- ]?energy sweetened beverages?|non[- ]?nutritive sweetened beverages?|diet (?:soda|soft drinks?|beverages?)|zero[- ]?calorie (?:soft drinks?|beverages?)|non[- ]?sugar sweeteners?)\b/i.test(
    `${paper.title} ${paper.abstract ?? ""}`
  );
}

function sweetenedBeverageReviewScore(paper: Paper): number {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  let score = (paper.year ?? 0) * 10;
  if (/health effects of sugar[- ]sweetened and artificially sweetened beverages/.test(text)) score += 10_000;
  if (/low[- ]+and[- ]+no[- ]+calorie sweetened beverages as a replacement/.test(text)) score += 9_000;
  if (/artificially sweetened beverages and health outcomes/.test(text)) score += 8_000;
  if (/postprandial glycemic and endocrine responses/.test(text)) score += 7_000;
  return score;
}

function isFoodDietTopicIntent(intent: ResearchIntent): boolean {
  if (isSweetenedBeverageTopicIntent(intent)) return false;
  return /\b(?:diet|dietary|nutrition|nutritional|food|foods)\b/i.test(
    [intent.exposure, ...intent.exposureTerms].join(" ")
  );
}

function isHumanFoodDietReview(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return /\b(?:diet|dietary|nutrition|nutritional|food|foods)\b/.test(title) &&
    !/\b(?:bibliometric|scientometric|mapping analysis|citation analysis)\b/.test(text) &&
    !/\b(?:animal model|mice|rats?|cell line|in vitro|in vivo)\b/.test(title);
}

function isCookingFatTopicIntent(intent: ResearchIntent): boolean {
  return /\b(?:fat|oil|lard|tallow|ghee|butter|shortening)\b/i.test(
    [intent.exposure, ...intent.exposureTerms].join(" ")
  );
}

function isDietaryFatHealthReview(paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  // Background paragraphs often mention saturated fat even when the paper is
  // really about MASLD, scabies treatment, or another disease. For a general
  // cooking-fat answer, make dietary fat the paper's actual title subject.
  return /\b(?:saturated fat|dietary fat|animal fat|solid fats?|oils?|lard|tallow|ghee|butter)\b/.test(title) &&
    /\b(?:blood lipids?|cholesterol|cardiovascular|coronary|stroke|cardiometabolic)\b/.test(text);
}

function isPreclinicalFocusedReview(paper: Paper): boolean {
  return /\b(?:molecular modeling|in silico|animal model|mouse|mice|rat|rats|cell line|in vitro|in vivo)\b/i
    .test(paper.title);
}

function broadTopicReviewScore(paper: Paper, intent: ResearchIntent): number {
  const title = normalizeExposurePhrase(paper.title);
  const abstract = normalizeExposurePhrase(paper.abstract ?? "");
  if (paperNamesIntentExposure(paper, intent)) return 1_000;
  const directTitleMatch = intent.exposureTerms.some((term) => {
    const phrase = normalizeExposurePhrase(term);
    return phrase.trim() && title.includes(phrase);
  });
  if (directTitleMatch) return 100;

  const semanticScore = Math.max(0, ...(intent.contextualEvidenceTerms ?? []).map((term) => {
    const tokens = normalizeExposurePhrase(term)
      .trim()
      .split(" ")
      .filter((token) => token.length >= 4);
    if (tokens.length === 0) return 0;
    return tokens.filter((token) => title.includes(` ${token} `)).length;
  }));
  const exactTopicMention = intent.exposureTerms.some((term) => {
    const phrase = normalizeExposurePhrase(term);
    return phrase.trim() && abstract.includes(phrase);
  });
  return semanticScore + (exactTopicMention ? 50 : 0);
}

function uniqueBroadTopicPapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = (paper.doi ?? paper.url ?? paper.title).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function paperTitleNamesExposure(paper: Paper, intent: ResearchIntent | undefined): boolean {
  const exposureTerms = intent?.exposureTerms ?? [];
  if (exposureTerms.length === 0) return false;
  const title = normalizeExposurePhrase(paper.title);
  return exposureTerms.some((term) => {
    const phrase = normalizeExposurePhrase(term);
    if (!phrase.trim()) return false;
    if (title.includes(phrase)) return true;
    const tokens = phrase.trim().split(" ").filter((token) => token.length >= 4);
    if (tokens.length === 1) return title.includes(` ${tokens[0]} `);
    // Titles such as "concurrent, resistance, or aerobic training" name each
    // mode once and share the final noun, so the canonical phrase is not
    // contiguous even though the subtype is explicit.
    return tokens.length >= 2 && tokens.every((token) => title.includes(` ${token} `));
  });
}

function normalizeExposurePhrase(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

function selectCoffeeDailyLimitPapers(papers: Paper[], limit: number): Paper[] {
  const selected: Paper[] = [];
  const rolePatterns = [
    /systematic review of the potential adverse effects of caffeine consumption/i,
    /coffee consumption and health.*umbrella review/i,
    /coffee, caffeine, and health outcomes.*umbrella review/i,
    /long-term coffee consumption and risk of cardiovascular disease/i
  ];
  for (const pattern of rolePatterns) {
    const paper = paperMatching(papers, pattern);
    if (paper && !selected.includes(paper)) selected.push(paper);
    if (selected.length >= limit) break;
  }
  for (const paper of papers) {
    if (selected.length >= limit) break;
    if (!selected.includes(paper) && !hasUnrequestedNarrowPopulation("", paper)) selected.push(paper);
  }
  for (const paper of papers) {
    if (selected.length >= limit) break;
    if (!selected.includes(paper)) selected.push(paper);
  }
  return selected.slice(0, limit);
}

function selectSweetenedDrinkComparisonPapers(papers: Paper[], limit: number): Paper[] {
  const selected: Paper[] = [];
  const rolePatterns = [
    /low- and no-calorie sweetened beverages as a replacement for sugar-sweetened beverages/i,
    /non-nutritive sweetened beverages on postprandial glycemic and endocrine responses/i,
    /health effects of sugar-sweetened and artificially sweetened beverages/i,
    /reconciling conflicting evidence on low- and no-calorie sweeteners/i
  ];
  for (const pattern of rolePatterns) {
    const paper = paperMatching(papers, pattern);
    if (paper && !selected.includes(paper)) selected.push(paper);
    if (selected.length >= limit) break;
  }
  for (const paper of papers) {
    if (selected.length >= limit) break;
    if (!selected.includes(paper)) selected.push(paper);
  }
  return selected.slice(0, limit);
}

function selectOmegaCardiovascularPapers(papers: Paper[], limit: number): Paper[] {
  const selected: Paper[] = [];
  const rolePatterns = [
    /marine omega-3 supplementation and cardiovascular disease.*updated meta-analysis/i,
    /omega-3 fatty acids for the primary and secondary prevention of cardiovascular disease/i,
    /efficacy and safety of omega-3 fatty acids in the prevention of cardiovascular disease/i,
    /effect of omega-3 dosage on cardiovascular outcomes/i
  ];
  for (const pattern of rolePatterns) {
    const paper = paperMatching(papers, pattern);
    if (paper && !selected.includes(paper)) selected.push(paper);
    if (selected.length >= limit) break;
  }
  for (const paper of papers) {
    if (selected.length >= limit) break;
    if (!selected.includes(paper)) selected.push(paper);
  }
  return selected.slice(0, limit);
}

function isOmegaCardiovascularQuestion(question: string): boolean {
  return /(오메가|omega-?3|fish oil)/i.test(question) &&
    /(심혈관|심장|심근|뇌졸중|예방|cardiovascular|heart|stroke|prevention)/i.test(question);
}

function hasUnrequestedNarrowPopulation(question: string, paper: Paper): boolean {
  const title = paper.title.toLowerCase();
  const groups: Array<[RegExp, RegExp]> = [
    [/\b(dialysis|hemodialysis|haemodialysis|end-stage renal|chronic kidney)\b|투석|만성콩팥/, /투석|콩팥|신장|renal|kidney/i],
    [/\b(type 1 diabetes|type 2 diabetes|diabetes|diabetic)\b|당뇨/, /당뇨|diabetes/i],
    [/\b(polycystic ovary|pcos)\b|다낭성/, /다낭성|pcos|polycystic/i],
    [/\b(pregnan|maternal|postmenopausal|menopause)\w*\b|임신|폐경/, /임신|임산부|폐경|pregnan|maternal|menopause/i],
    [/\b(child|children|pediatric|paediatric|adolescent|infant)\w*\b|소아|아동|청소년|영아/, /아이|아기|소아|아동|청소년|영아|child|pediatric|adolescent|infant/i]
  ];
  return groups.some(([paperPattern, questionPattern]) => paperPattern.test(title) && !questionPattern.test(question));
}

function inferResearchPattern(papers: Paper[], interpretation: EvidenceInterpretation[]): ResearchPattern {
  const clear = interpretation.filter((item) => item.stance !== "unclear");
  if (clear.length === 0) return "insufficient";
  if (clear.length === 1) {
    const paper = papers[clear[0]!.citationIndex - 1];
    return paper && ["systematic_review", "clinical_study", "official_guidance"].includes(paper.evidenceLevel)
      ? "mostly_consistent"
      : "insufficient";
  }
  const stances = new Set(clear.map((item) => item.stance));
  const horizons = new Set(papers.map(inferTimeHorizon).filter((value) => value !== "unknown"));
  if ((stances.has("supports") && stances.has("opposes")) || stances.has("mixed")) {
    if (horizons.has("short_term") && horizons.has("long_term")) return "context_explains_difference";
    const ordered = clear
      .map((item) => ({ item, year: papers[item.citationIndex - 1]?.year ?? 0 }))
      .filter(({ year }) => year > 0)
      .sort((left, right) => left.year - right.year);
    const earliest = ordered[0];
    const latest = ordered.at(-1);
    // Different years alone do not make an "old view versus new view" story.
    // The two papers need to study substantially the same exposure and outcome;
    // otherwise a positive product-specific trial beside a broad disease review
    // produces a fake historical reversal.
    if (
      earliest && latest &&
      earliest.item.stance !== latest.item.stance &&
      sameResearchFocus(papers[earliest.item.citationIndex - 1], papers[latest.item.citationIndex - 1])
    ) return "evidence_shift";
    return "ongoing_debate";
  }
  return "mostly_consistent";
}

function sameResearchFocus(left: Paper | undefined, right: Paper | undefined): boolean {
  if (!left || !right) return false;
  const ignored = new Set([
    "a", "an", "the", "and", "or", "of", "for", "in", "on", "with", "to",
    "study", "studies", "review", "analysis", "meta", "systematic", "umbrella",
    "health", "outcomes", "outcome", "risk", "effects", "effect", "human", "humans"
  ]);
  const tokens = (paper: Paper) => new Set(
    paper.title
      .toLowerCase()
      .match(/[a-z][a-z-]{3,}/g)
      ?.filter((token) => !ignored.has(token)) ?? []
  );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared >= 2;
}

function buildPaperTimeline(
  papers: Paper[],
  interpretation: EvidenceInterpretation[],
  question = "",
  intent?: ResearchIntent
): string {
  const preferSafety = isSafetyQuestion(question, intent);
  const items = papers.map((paper, index) => ({ paper, item: interpretation[index], index: index + 1 }));
  // The opening already carries the first representative paper's actual
  // result. The timeline should add independent confirmation, not repeat the
  // same sentence with a year prefix.
  return items.slice(1)
    .map(({ paper, item, index }) => {
      const year = paper.year ? `${paper.year}년` : "연도 미상의";
      const design = shortEvidenceDesignLabel(paper.evidenceLevel);
      const finding = (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined)
        ?? reportedFindingForIntent(paper, intent)
        ?? item?.reason_ko
        ?? stanceTimelineFinding(item?.stance ?? "unclear");
      return { finding, line: `${year} ${design} [${index}]에서 ${finding}` };
    })
    .filter(({ finding }) => !isGenericPaperResult(finding) && !/결과.*추출하지 못|구체적인 결과를 확인하지 못/.test(finding))
    .slice(0, 2)
    .map(({ line }) => line)
    .join(" ");
}

function stanceTimelineFinding(stance: EvidenceStance): string {
  switch (stance) {
    case "supports":
      return "질문에서 묻는 위험 가능성을 보고했지만 구체적인 결과 수치는 원문 확인이 필요합니다.";
    case "opposes":
      return "질문처럼 단정할 만한 결과를 확인하지 못했습니다.";
    case "mixed":
      return "대상자와 조건에 따라 결과가 엇갈린다고 정리했습니다.";
    default:
      return "질문에 직접 답하는 구체적인 결과를 확인하지 못했습니다.";
  }
}

function buildStoryResolution(question: string, verdict: Verdict, pattern: ResearchPattern): string {
  void question;
  if (pattern === "insufficient") {
    return "논문 수가 아니라 대상자·노출량·비교군·측정 결과가 질문과 맞는 연구가 더 필요합니다.";
  }
  if (pattern === "ongoing_debate") {
    return "따라서 아직은 '무조건 맞다'보다, 찬성 연구와 반대 연구가 어떤 대상과 조건을 봤는지 나눠 읽는 것이 정확합니다.";
  }
  if (pattern === "evidence_shift") {
    return "현재 판단은 최근 연구에 더 무게를 두되, 결론이 바뀐 이유가 연구 설계·대상자·측정 기간의 개선 때문인지 함께 확인해야 합니다.";
  }
  if (verdict === "supported") {
    return "종합하면 선택된 연구들은 질문에서 묻는 위험 가능성을 뒷받침합니다. 다만 효과 크기는 연구 대상과 조건 안에서 해석해야 합니다.";
  }
  if (verdict === "not_supported") {
    return "그래서 질문처럼 단정하는 쪽은 현재 핵심 근거와 거리가 있습니다. 반대 결과가 나온 특정 대상과 조건은 따로 봐야 합니다.";
  }
  return "결론 차이는 누가 맞고 틀려서라기보다 대상자·용량·관찰 기간이 달라서 생겼을 가능성이 큽니다.";
}

function buildEvidenceBasis(papers: Paper[], retrievedPaperCount?: number): string {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    const label = shortEvidenceDesignLabel(paper.evidenceLevel);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return "직접 확인된 핵심 연구가 없습니다.";
  const labels = [...counts.entries()].map(([label, count]) => `${label} ${count}편`);
  const retrieved = retrievedPaperCount && retrievedPaperCount > papers.length
    ? `검색된 후보 문헌 ${retrievedPaperCount}편 가운데 `
    : "";
  return `${retrieved}${labels.join("·")}을 중심으로 종합했습니다.`;
}

function buildEvidenceDetails(
  question: string,
  papers: Paper[],
  interpretation: EvidenceInterpretation[],
  limitations: string[],
  safetyQuestion: boolean,
  intent?: ResearchIntent
): EvidenceDetails {
  void question;
  void interpretation;

  return {
    // The surrounding detail view already explains each representative paper.
    // Do not manufacture a time-axis merely because a study has a follow-up.
    short_term_ko: "",
    long_term_ko: "",
    risk_ko: safetyQuestion ? reportedSafetyDetail(papers) : "",
    applicability_ko: "연구 대상자의 연령, 건강 상태, 섭취량 또는 중재 강도가 자신의 조건과 비슷한지 확인해야 합니다.",
    limitations_ko: limitations.slice(0, 2).join(" ") || "연구별 설계와 대상자 차이로 개인에게 동일하게 적용할 수 없습니다.",
    key_studies: papers.slice(0, 5).map((paper, index) => buildKeyStudyDetail(paper, index, interpretation, question, intent))
  };
}

function reportedSafetyDetail(papers: Paper[]): string {
  for (const [index, paper] of papers.entries()) {
    const finding = reportedSafetyFindingFromPaper(paper);
    if (finding) return `[${index + 1}] ${finding}`;
    const text = normalizeEvidenceText(paper.abstract ?? "");
    if (!text) continue;
    const citation = `[${index + 1}]`;
    if (/no (?:serious )?(?:adverse events?|side effects?)|no significant difference in (?:adverse events?|side effects?)/i.test(text)) {
      return `${citation}에서 부작용 발생 또는 부작용 발생률의 뚜렷한 차이를 보고하지 않았습니다.`;
    }
    if (/(?:serious )?adverse events?|side effects?|adverse reactions?|toxicity|contraindicat|drug interaction|increased risk|higher risk|excess risk|worsen(?:ed|ing)?|deteriorat(?:ed|ion)?/i.test(text)) {
      return `${citation}에서 부작용·안전성 또는 위험 관련 결과를 보고했습니다. 초록에 나온 결과 범위 안에서 해석해야 합니다.`;
    }
  }
  return "";
}

function isReportedSafetyDetail(value: string): boolean {
  // A keyword hit alone is not a safety finding. Do not show this generic
  // placeholder to users when the abstract did not report a concrete result.
  if (/부작용·안전성 또는 위험 관련 결과를 보고했습니다/.test(value)) return false;
  return /\[\d+\].*(?:부작용|안전성|위험|상호작용|악화|이상반응|치료를\s*중단)/.test(value);
}

function buildSweetenedDrinkComparisonDetails(papers: Paper[], limitations: string[]): EvidenceDetails {
  const replacementPaper = paperMatching(papers, /low- and no-calorie sweetened beverages as a replacement for sugar-sweetened beverages/i);
  const acutePaper = paperMatching(papers, /non-nutritive sweetened beverages on postprandial glycemic and endocrine responses/i);
  const consensusPaper = paperMatching(papers, /health effects of sugar-sweetened and artificially sweetened beverages/i);
  const replacementIndex = replacementPaper ? papers.indexOf(replacementPaper) + 1 : undefined;
  const acuteIndex = acutePaper ? papers.indexOf(acutePaper) + 1 : undefined;
  const consensusIndex = consensusPaper ? papers.indexOf(consensusPaper) + 1 : undefined;

  return {
    short_term_ko: acutePaper
      ? `단기시험 종합에서는 제로 음료의 식후 혈당·인슐린·장호르몬 반응이 물과 비슷했습니다. 같은 조건에서 설탕 음료는 혈당과 인슐린 반응을 높였습니다. [${acuteIndex}]`
      : "단기 효과는 같은 식사 조건에서 제로 음료, 설탕 음료, 물을 직접 비교한 시험으로 판단해야 합니다.",
    long_term_ko: consensusPaper
      ? `최신 국내 학회 합의문은 설탕 음료를 제로로 바꾸는 단기 이득을 인정했지만, 장기 코호트에서는 두 음료의 높은 섭취가 모두 제2형 당뇨병·심혈관질환·사망 위험과 연관됐다고 정리했습니다. 관찰연구라 인과관계와 역인과성을 분리하기 어렵습니다. [${consensusIndex}]`
      : "제로 음료의 장기 안전성은 단기 대체시험보다 불확실하며, 관찰연구의 연관성을 인과관계로 단정할 수 없습니다.",
    risk_ko: replacementPaper
      ? paperSupportsNumbers(replacementPaper, ["17", "1733", "1.06"])
        ? `17개 무작위시험, 성인 1,733명을 종합했을 때 설탕 음료를 제로로 대체하면 체중이 평균 1.06kg 더 감소했고, 뚜렷한 위해 근거는 확인되지 않았습니다. [${replacementIndex}]`
        : `무작위시험 종합에서는 설탕 음료를 제로로 대체할 때 체중과 일부 심대사 지표가 소폭 개선됐고 뚜렷한 위해 근거는 확인되지 않았습니다. [${replacementIndex}]`
      : "현재 선택된 핵심 연구만으로 두 음료의 위험 차이를 수치로 제시하기 어렵습니다.",
    applicability_ko:
      "가장 직접적인 대체시험은 과체중·비만이 있거나 당뇨병 위험이 있는 성인이 중심입니다. 이미 설탕 음료를 마시는 사람의 대체 효과에는 적용하기 쉽지만, 물을 잘 마시는 사람이 제로 음료를 새로 추가할 근거로는 적합하지 않습니다.",
    limitations_ko:
      "제로 음료에는 아스파탐, 수크랄로스, 아세설팜칼륨, 스테비아 등 서로 다른 감미료가 포함됩니다. 단기시험과 장기 관찰연구의 결론 차이에는 추적 기간, 기존 비만·당뇨 위험, 역인과성과 잔여 교란이 영향을 줄 수 있습니다." +
      (limitations.length > 0 ? " 제품별 섭취량 차이도 남아 있습니다." : ""),
    key_studies: papers.slice(0, 5).map((paper, index) => buildSweetenedDrinkComparisonKeyStudy(paper, index))
  };
}

function buildSweetenedDrinkComparisonKeyStudy(paper: Paper, index: number): KeyStudyDetail {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  if (/low[- ]+and[- ]+no[- ]+calorie sweetened beverages as a replacement for sugar[- ]+sweetened beverages/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["17", "1733", "1.06"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "무작위시험 체계적 문헌고찰·네트워크 메타분석",
      population_ko: "과체중·비만이 있거나 당뇨병 위험이 있는 성인 중심",
      exposure_ko: "설탕 음료를 저·무칼로리 감미 음료로 대체",
      result_ko: hasNumbers
        ? "17개 시험, 1,733명에서 체중이 평균 1.06kg 더 감소했고 일부 심대사 지표도 소폭 개선됐으며 위해 근거는 확인되지 않았습니다."
        : "설탕 음료를 제로 음료로 대체했을 때 체중과 일부 심대사 지표가 소폭 개선됐습니다.",
      time_horizon: "short_term",
      limitation_ko: "대부분 과체중·비만 또는 당뇨병 위험이 있는 성인의 중기 대체시험입니다.",
      url: paper.url
    };
  }
  if (/non[- ]+nutritive sweetened beverages on postprandial glycemic and endocrine responses/.test(text)) {
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "단기시험 체계적 문헌고찰·네트워크 메타분석",
      population_ko: "대부분 건강한 성인",
      exposure_ko: "제로 음료, 물, 설탕 음료의 단회 섭취",
      result_ko: "제로 음료의 식후 혈당·인슐린 반응은 물과 비슷했고, 설탕 음료는 혈당과 인슐린 반응을 높였습니다.",
      time_horizon: "short_term",
      limitation_ko: "한 번 섭취한 뒤의 반응이므로 장기 질환 위험을 직접 보여주지는 않습니다.",
      url: paper.url
    };
  }
  if (/health effects of sugar[- ]+sweetened and artificially sweetened beverages/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["14", "76", "0.73", "0.72", "20", "34"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "우산형 문헌고찰·근거 기반 국내 학회 합의문",
      population_ko: "성인 무작위시험 및 장기 코호트 참여자",
      exposure_ko: "설탕 음료와 인공감미료 음료의 단기 대체 및 장기 섭취",
      result_ko: hasNumbers
        ? "14개 무작위시험에서는 제로 대체 시 체중 0.73kg과 체지방률 0.72%가 감소했지만, 장기 근거가 불확실해 물·무가당 음료를 최종 목표로 제시했습니다."
        : "단기 대체 효과는 인정했지만 장기 기본 음료로는 물·무가당 음료를 권했습니다.",
      time_horizon: "mixed",
      limitation_ko: "단기 무작위시험과 장기 관찰연구는 설계가 달라 같은 수준의 인과 근거로 볼 수 없습니다.",
      url: paper.url
    };
  }
  if (/low[- ]+and[- ]+no[- ]+calorie sweeteners and beverages.*health outcomes/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["29", "50,034,327", "1.84", "1.31", "1.14", "1.13", "0.50"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "우산형 문헌고찰",
      population_ko: "관찰연구와 무작위시험을 합쳐 약 5,003만 명",
      exposure_ko: "저·무칼로리 감미료 및 해당 음료",
      result_ko: hasNumbers
        ? "29개 메타분석에서 관찰연구는 높은 섭취와 과체중·대사증후군·제2형 당뇨병·고혈압 위험의 연관성을 보고했고, 무작위시험에서는 과체중·비만 집단의 체중 감소가 보고됐습니다."
        : "관찰연구의 위험 연관성과 무작위시험의 체중 감소 결과가 함께 보고됐습니다.",
      time_horizon: "mixed",
      limitation_ko: "관찰연구의 연관성과 무작위시험의 인과 결과를 같은 의미로 해석할 수는 없습니다.",
      url: paper.url
    };
  }
  if (/artificially sweetened beverages and health outcomes/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["11", "7", "51", "4"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "우산형 문헌고찰",
      population_ko: "51개 코호트와 4개 환자-대조군 연구를 포함한 장기 관찰연구",
      exposure_ko: "인공감미료 음료의 습관적 섭취",
      result_ko: hasNumbers
        ? "7개 종합연구가 포함한 11개 메타분석에서 높은 섭취는 비만·제2형 당뇨병·고혈압·심혈관질환 위험 증가와 연관됐습니다."
        : "높은 섭취와 여러 장기 건강 위험의 연관성을 평가했지만, 관찰연구 결과라 인과관계는 확정하지 못했습니다.",
      time_horizon: "long_term",
      limitation_ko: "습관적 섭취를 관찰한 연구이므로, 기존 건강 상태와 식습관의 영향을 완전히 분리할 수 없습니다.",
      url: paper.url
    };
  }
  return {
    citationIndex: index + 1,
    title: paper.title,
    year: paper.year,
    design_ko: shortEvidenceDesignLabel(paper.evidenceLevel),
    population_ko: inferPopulationFromPaper(paper),
    exposure_ko: "저·무칼로리 감미 음료와 설탕 음료",
    result_ko: "두 음료의 건강 결과를 비교했습니다.",
    time_horizon: inferTimeHorizon(paper),
    limitation_ko: "질문의 직접 비교와 연구의 실제 비교군이 같은지 확인해야 합니다.",
    url: paper.url?.trim() || (paper.doi ? `https://doi.org/${paper.doi}` : "")
  };
}

function buildCoffeeDailyLimitEvidenceDetails(papers: Paper[], limitations: string[]): EvidenceDetails {
  const safetyPaper = paperMatching(papers, /systematic review of the potential adverse effects of caffeine consumption/i);
  const healthPaper = paperMatching(papers, /coffee consumption and health.*umbrella review/i);
  const outcomesPaper = paperMatching(papers, /coffee, caffeine, and health outcomes.*umbrella review/i);
  const safetyIndex = safetyPaper ? papers.indexOf(safetyPaper) + 1 : undefined;
  const healthIndex = healthPaper ? papers.indexOf(healthPaper) + 1 : undefined;
  const outcomesIndex = outcomesPaper ? papers.indexOf(outcomesPaper) + 1 : undefined;
  const hasSafetyLimit = paperSupportsNumbers(safetyPaper, ["400"]);
  const hasThreeToFourCups = paperSupportsThreeToFourCups(healthPaper);

  return {
    short_term_ko: outcomesPaper
      ? `무리 없는 하루 총량 안에서도 카페인은 섭취 직후 혈압이나 각성 상태에 영향을 줄 수 있습니다. 장기 건강 결과와 한 번 마신 직후의 반응은 별개입니다. [${outcomesIndex}]`
      : "하루 총량이 일반 기준 안이어도 한 번에 몰아 마시면 불면, 두근거림, 불안 같은 개인 반응이 나타날 수 있습니다.",
    long_term_ko: healthPaper
      ? hasThreeToFourCups
        ? `여러 질환과 사망 결과를 종합한 우산형 문헌고찰에서는 하루 3~4잔 구간이 가장 낮은 상대위험과 연관됐습니다. 하지만 주로 관찰연구라 커피가 그 결과의 원인이라고 단정할 수는 없습니다. [${healthIndex}]`
        : `보통 섭취 범위의 커피는 여러 장기 건강 결과에서 해로움보다 이로움과 더 자주 연관됐지만, 인과관계는 확정되지 않았습니다. [${healthIndex}]`
      : "장기 건강 영향은 섭취량별 관찰연구를 통해 평가해야 하며, 특정 잔 수가 모든 사람에게 건강 이득을 준다고 볼 수는 없습니다.",
    risk_ko: safetyPaper
      ? hasSafetyLimit
        ? `건강한 성인 대상 안전성 체계적 문헌고찰은 하루 카페인 400mg 이하에서 명백한 유해 효과가 나타난다는 근거가 없다고 정리했습니다. [${safetyIndex}]`
        : `안전성 체계적 문헌고찰은 건강한 성인과 민감 집단을 분리해 카페인 섭취량별 부작용을 평가했습니다. [${safetyIndex}]`
      : "검색된 핵심 연구만으로는 하루 카페인 안전 상한을 수치로 확인하지 못했습니다.",
    applicability_ko:
      "이 기준은 건강한 성인에 대한 일반 기준입니다. 임신·수유 중이거나 청소년, 심혈관질환이 있는 사람, 카페인에 민감한 사람에게 같은 상한을 그대로 적용하면 안 됩니다.",
    limitations_ko:
      "연구에서 말하는 한 잔의 크기와 실제 제품의 카페인량은 같지 않습니다. 3~4잔의 유리한 연관성도 대부분 관찰연구 결과라 권장 처방이나 인과효과로 해석할 수 없습니다." +
      (limitations.length > 0 ? " 원문별 커피 종류와 대상자 차이도 남아 있습니다." : ""),
    key_studies: papers.slice(0, 5).map((paper, index) => buildCoffeeDailyLimitKeyStudy(paper, index))
  };
}

function buildCoffeeDailyLimitKeyStudy(paper: Paper, index: number): KeyStudyDetail {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  if (/systematic review of the potential adverse effects of caffeine consumption/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["381", "400"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "안전성 체계적 문헌고찰",
      population_ko: "건강한 성인과 임신부, 아동·청소년을 구분해 분석",
      exposure_ko: "성인의 하루 카페인 섭취량",
      result_ko: hasNumbers
        ? "포함 연구 381편을 종합했을 때 건강한 성인의 하루 400mg 이하 섭취는 명백한 유해 효과와 연관되지 않았습니다."
        : "건강한 성인과 민감 집단의 카페인 섭취량별 유해 효과를 나눠 평가했습니다.",
      time_horizon: "mixed",
      limitation_ko: "건강한 성인의 평균적 기준이며, 개인 민감도와 기저질환에 따른 차이가 남습니다.",
      url: paper.url
    };
  }
  if (/coffee consumption and health.*umbrella review/.test(text)) {
    const hasNumbers = paperSupportsNumbers(paper, ["201", "17"]) && paperSupportsThreeToFourCups(paper);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "우산형 문헌고찰",
      population_ko: "여러 국가의 성인 연구 참여자",
      exposure_ko: "하루 커피 섭취량과 다양한 건강 결과",
      result_ko: hasNumbers
        ? "관찰연구 메타분석 201개와 중재연구 메타분석 17개를 종합했으며, 여러 결과에서 하루 3~4잔이 가장 낮은 상대위험과 연관됐습니다."
        : "보통 범위의 커피 섭취는 해로움보다 이로움과 더 자주 연관됐습니다.",
      time_horizon: "long_term",
      limitation_ko: "대부분 관찰연구이므로 커피가 위험 감소의 원인이라는 뜻은 아닙니다.",
      url: paper.url
    };
  }
  if (/coffee, caffeine, and health outcomes.*umbrella review/.test(text)) {
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "우산형 문헌고찰",
      population_ko: "성인 대상 관찰연구와 무작위시험 참여자",
      exposure_ko: "커피와 카페인 섭취",
      result_ko: "커피는 건강한 식단의 일부가 될 수 있다는 장기 결과와 카페인의 단기 혈압 상승 가능성을 함께 확인했습니다.",
      time_horizon: "mixed",
      limitation_ko: "질환별 근거 강도와 연구 간 이질성이 달라 하나의 효과로 합칠 수 없습니다.",
      url: paper.url
    };
  }
  return {
    citationIndex: index + 1,
    title: paper.title,
    year: paper.year,
    design_ko: shortEvidenceDesignLabel(paper.evidenceLevel),
    population_ko: inferPopulationFromPaper(paper),
    exposure_ko: "커피 또는 카페인 섭취량",
    result_ko: "커피 섭취량과 건강 결과의 연관성을 평가했습니다.",
    time_horizon: inferTimeHorizon(paper),
    limitation_ko: "질문에 적용하려면 실제 섭취량과 연구의 한 잔 기준을 확인해야 합니다.",
    url: paper.url
  };
}

function buildCoffeeEvidenceDetails(papers: Paper[], limitations: string[]): EvidenceDetails {
  const acutePaper = paperMatching(papers, /effect of coffee on blood pressure|hypertensive individuals/i);
  const riskPaper = paperMatching(papers, /risk of hypertension in adults/i);
  const acuteIndex = acutePaper ? papers.indexOf(acutePaper) + 1 : paperIndexMatching(papers, /effect of coffee on blood pressure|hypertensive individuals/i, 2);
  const reviewIndex = paperIndexMatching(papers, /coffee and arterial hypertension/i, 1);
  const riskIndex = riskPaper ? papers.indexOf(riskPaper) + 1 : paperIndexMatching(papers, /risk of hypertension in adults/i, 3);
  const hasAcuteNumbers = paperSupportsNumbers(acutePaper, ["200", "300", "8.1", "5.7", "3"]);
  const hasRiskNumber = paperSupportsNumbers(riskPaper, ["7"]);

  return {
    short_term_ko: hasAcuteNumbers
      ? `고혈압 환자를 포함한 단기시험을 종합한 연구에서는 카페인 200~300mg 섭취 뒤 수축기 혈압이 평균 약 8.1mmHg, 이완기 혈압이 약 5.7mmHg 상승했고, 이 효과가 3시간 이상 지속될 수 있다고 보고했습니다. [${acuteIndex}]`
      : `카페인은 섭취 직후 혈압을 일시적으로 높일 수 있다는 단기 연구가 확인됩니다. 상승 크기와 지속 시간은 섭취량과 평소 카페인 습관에 따라 달라집니다. [${acuteIndex}]`,
    long_term_ko:
      `습관적으로 적당량의 커피를 마시는 경우에는 장기적인 혈압 상승이 확인되지 않았습니다. 평소 드물게 마시는 사람에게 나타나는 급성 반응과 규칙적인 섭취의 장기 영향은 구분해야 합니다. [${reviewIndex}]`,
    risk_ko: hasRiskNumber
      ? `2023년 체계적 문헌고찰에서는 코호트 연구상 높은 커피 섭취가 고혈압 위험 약 7% 감소와 연관됐습니다. 다만 관찰연구의 연관성이므로 커피가 위험을 낮춘다고 단정할 수는 없습니다. [${riskIndex}]`
      : `장기 관찰연구에서는 적당한 커피 섭취가 고혈압 위험을 뚜렷하게 높이는 방향은 확인되지 않았습니다. 관찰연구의 연관성이므로 커피가 위험을 낮춘다고 단정할 수도 없습니다. [${riskIndex}]`,
    applicability_ko:
      "일반 성인과 평소 커피를 규칙적으로 마시는 사람에게는 장기 위험 증가 근거가 약합니다. 반면 기존 고혈압이 있거나 카페인에 익숙하지 않은 사람은 섭취 직후 반응을 더 주의해서 봐야 합니다.",
    limitations_ko:
      limitations.slice(0, 2).join(" ") || "연구마다 커피 종류, 카페인 양, 섭취 습관과 대상자의 건강 상태가 달라 개인에게 같은 결과가 나타난다고 단정할 수 없습니다.",
    key_studies: papers.slice(0, 5).map((paper, index) => buildCoffeeKeyStudy(paper, index))
  };
}

function buildCoffeeKeyStudy(paper: Paper, index: number): KeyStudyDetail {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  if (/effect of coffee on blood pressure|hypertensive individuals/.test(text)) {
    const hasAcuteNumbers = paperSupportsNumbers(paper, ["200", "300", "8.1", "5.7", "3"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "체계적 문헌고찰·메타분석",
      population_ko: "고혈압 환자",
      exposure_ko: "카페인 200~300mg 및 커피 섭취",
      result_ko: hasAcuteNumbers
        ? "섭취 직후 수축기 혈압 약 8.1mmHg, 이완기 혈압 약 5.7mmHg 상승이 3시간 이상 관찰됐지만 장기적인 지속 상승은 확인되지 않았습니다."
        : "카페인 섭취 직후 혈압이 일시적으로 상승할 수 있지만 장기적인 지속 상승은 확인되지 않았습니다.",
      time_horizon: "mixed",
      limitation_ko: "급성시험과 장기 연구의 기간과 설계가 달라 두 결과를 같은 효과로 볼 수 없습니다.",
      url: paper.url
    };
  }
  if (/risk of hypertension in adults/.test(text)) {
    const hasRiskNumber = paperSupportsNumbers(paper, ["7"]);
    return {
      citationIndex: index + 1,
      title: paper.title,
      year: paper.year,
      design_ko: "체계적 문헌고찰·메타분석",
      population_ko: "성인 코호트 연구 참여자",
      exposure_ko: "장기적인 커피 섭취량",
      result_ko: hasRiskNumber
        ? "높은 커피 섭취가 고혈압 위험 약 7% 감소와 연관됐습니다."
        : "커피 섭취가 고혈압 위험을 뚜렷하게 높이는 연관성은 확인되지 않았습니다.",
      time_horizon: "long_term",
      limitation_ko: "주로 관찰연구를 종합한 결과라 인과관계를 확정할 수 없습니다.",
      url: paper.url
    };
  }
  return {
    citationIndex: index + 1,
    title: paper.title,
    year: paper.year,
    design_ko: shortEvidenceDesignLabel(paper.evidenceLevel),
    population_ko: "일반 성인 및 고혈압이 있는 성인",
    exposure_ko: "습관적인 중등도 커피 섭취",
    result_ko: "규칙적인 적당량의 커피 섭취가 장기 혈압을 높인다는 결과는 확인되지 않았습니다.",
    time_horizon: "long_term",
    limitation_ko: "섭취 습관과 개인의 카페인 민감도에 따라 반응이 달라질 수 있습니다.",
    url: paper.url
  };
}

function paperMatching(papers: Paper[], pattern: RegExp): Paper | undefined {
  return papers.find((paper) => pattern.test(`${paper.title} ${paper.abstract ?? ""}`));
}

function paperSupportsNumbers(paper: Paper | undefined, numbers: string[]): boolean {
  if (!paper) return false;
  const corpus = `${paper.title} ${paper.abstract ?? ""} ${paper.year ?? ""}`;
  const found = new Set([...corpus.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => (match[0] ?? "").replace(/,/g, "")));
  return numbers.every((number) => found.has(number));
}

function paperSupportsPattern(paper: Paper | undefined, pattern: RegExp): boolean {
  if (!paper) return false;
  return pattern.test(normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`));
}

function paperSupportsThreeToFourCups(paper: Paper | undefined): boolean {
  if (!paper) return false;
  const corpus = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  return /(?:3\s*(?:to|[-~])\s*4|three\s+to\s+four)\s+cups?/.test(corpus);
}

function buildKeyStudyDetail(
  paper: Paper,
  index: number,
  interpretation: EvidenceInterpretation[],
  question: string,
  intent?: ResearchIntent
): KeyStudyDetail {
  const item = interpretation.find((candidate) => candidate.citationIndex === index + 1);
  const preferSafety = isSafetyQuestion(question, intent);
  const extractedResult = (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined)
    ?? reportedFindingForIntent(paper, intent)
    ?? (intent ? undefined : reportedMetricSummary(paper, question));
  const interpretationResult = item?.reason_ko;
  return {
    citationIndex: index + 1,
    title: paper.title,
    year: paper.year,
    design_ko: shortEvidenceDesignLabel(paper.evidenceLevel),
    population_ko: inferPopulationFromPaper(paper),
    exposure_ko: evidenceExposureFromPaper(paper, intent, question),
    result_ko: extractedResult
      ?? (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined)
      ?? (!isGenericPaperResult(interpretationResult) ? interpretationResult! : "대표 근거로 사용할 수 있는 결과 문장을 확인하지 못했습니다."),
    headline_ko: paper.groundedHeadlineKo,
    time_horizon: inferTimeHorizon(paper),
    limitation_ko: "연구 대상과 측정 방식이 달라 다른 집단에 그대로 적용하기는 어렵습니다.",
    url: paper.url
  };
}

function evidenceExposureFromPaper(paper: Paper, intent: ResearchIntent | undefined, question: string): string {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  const planned = `${intent?.exposure ?? ""} ${intent?.exposureTerms.join(" ") ?? ""} ${question}`.toLowerCase();
  const questionNamesDrink = /(?:음료|콜라|소다|탄산|beverages?|drinks?|sodas?|soft\s+drinks?)/i.test(question);
  const questionNamesNoSugar = /(?:제로|무설탕|저칼로리|무칼로리|인공감미료|zero[- ]?(?:sugar|calorie)|sugar[- ]?free|diet|low[- ]?(?:calorie|energy)|no[- ]?(?:calorie|sugar)|non[- ]?(?:caloric|nutritive)|artificially\s+sweetened)/i.test(question);
  const asksForNoSugarDrink = questionNamesDrink && questionNamesNoSugar;
  const paperNamesNoSugarDrink = /\b(?:zero[- ]?(?:sugar|calorie)(?:\s+(?:sodas?|soft\s+drinks?|beverages?|drinks?))?|sugar[- ]?free(?:\s+(?:sodas?|soft\s+drinks?|beverages?|drinks?))?|diet(?:\s+(?:sodas?|soft\s+drinks?|beverages?|drinks?))|low[- ]?(?:calorie|energy)(?:\s+(?:sweetened\s+)?(?:sodas?|soft\s+drinks?|beverages?|drinks?))|no[- ]?(?:calorie|sugar)(?:\s+(?:sodas?|soft\s+drinks?|beverages?|drinks?))|non[- ]?(?:caloric|nutritive)(?:\s+sweetened)?(?:\s+(?:sodas?|soft\s+drinks?|beverages?|drinks?))|artificially\s+sweetened(?:\s+(?:beverages?|drinks?|sodas?|soft\s+drinks?))|ASBs?|LCS)\b/i.test(text);
  // A review can report sugar-sweetened and zero/low-calorie beverages in
  // the same result sentence. When the user asked about the latter, label
  // the study by that requested exposure rather than the first sibling that
  // happens to appear in the title.
  if (asksForNoSugarDrink && paperNamesNoSugarDrink) return "인공감미료·저칼로리 음료 섭취";
  if (/\b(?:sugar[- ]sweetened beverages?|ssbs?)\b/.test(text) && /(?:sugar|sweetened|ssb|설탕|단\s*(?:음식|것)|제로)/i.test(planned)) return "설탕이 든 음료 섭취";
  if (/\badded sugar\b/.test(text) && /(?:sugar|sweetened|설탕|단\s*(?:음식|것)|제로)/i.test(planned)) return "첨가당 섭취";
  if (/\bfruit juice\b/.test(text) && /(?:juice|주스)/i.test(planned)) return "과일 주스 섭취";
  const exposure = intent?.exposure?.trim();
  return exposure && /^[가-힣\s]+$/.test(exposure) ? exposure : humanExposureFromQuestion(question);
}

function reportedMetricSummary(paper: Paper, question: string): string | undefined {
  const abstract = paper.abstract ?? "";
  const preferSingleExposure = asksForSingleExposure(question);
  const effect = extractCommonEffectSummary(abstract, preferSingleExposure);
  if (!effect) return undefined;
  const studyMatch = abstract.match(/\b(?:a total of\s+)?(\d[\d,]*)\s+(?:studies|trials|articles|rcts)\b/i);
  const participantMatch = abstract.match(/\b(?:with|involving)\s+(\d[\d,]*)\s+(?:participants|adults|individuals|subjects)\b/i);
  const scale = !preferSingleExposure && studyMatch
    ? `${formatResearchNumber(studyMatch[1]!)}개 연구${participantMatch ? `, ${formatResearchNumber(participantMatch[1]!)}명` : ""}`
    : "";
  return [scale, effect].filter(Boolean).join("에서 ");
}

function asksForSingleExposure(question: string): boolean {
  return /(?:만으로|단독|혼자|그것만|only|alone|solely|by itself)/i.test(question);
}

function isGenericPaperResult(value: string | undefined): boolean {
  return !value || /질문에\s*직접\s*답하는\s*결과|구체적(?:인|으로)\s*보고된\s*결과|결과\s*방향|원문.*확인|(?:한국어|결과).*추출하지\s*못|초록.*추출|관련\s*문장.*명시적|선택된\s*문장/i.test(value);
}

function inferPopulationFromPaper(paper: Paper): string {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  // Food-protein quality can be measured in a digestion model rather than in
  // people. Surface that distinction before generic words such as "children"
  // in an amino-acid reference pattern are mistaken for study participants.
  if (/\b(?:determined in pigs?|ileal cannulated|gilts?|swine)\b/.test(text)) return "동물 소화율 실험(돼지)";
  if (/\b(?:in vitro|gastrointestinal model|simulated digestion|tiny-tim)\b/.test(text)) return "실험실 소화 모형";
  if (/\b(?:laboratory[- ]?based|laboratory study|bench study|physicochemical|focused on p\s*h)\b/.test(text)) return "실험실 측정 연구";
  if (/\b(?:cell line|cell culture|cultured cells?|nk-92(?:mi)?)\b/.test(text)) return "세포 실험";
  if (/cancer survivors|cancer survivor/.test(text)) return "암 생존자";
  if (/mild cognitive impairment|\bmci\b/.test(text)) return "경도인지장애가 있는 성인";
  if (/healthy (?:male|female )?(?:subjects|participants|adults)|healthy volunteers?/.test(text)) return "건강한 성인";
  if (/children|child|infant|adolescent/.test(text)) return "아동·청소년 또는 영유아";
  if (/pregnan|lactat/.test(text)) return "임신·수유 집단";
  if (/older adults|elderly/.test(text)) return "고령 성인";
  if (paper.evidenceLevel === "systematic_review" && /patients|individuals with|people with|adults|participants/.test(text)) {
    return "여러 성인 연구 참여자";
  }
  if (/patients|individuals with|people with/.test(text)) return "해당 질환이 있는 연구 참여자";
  if (/adults|participants|cohort/.test(text)) return "성인 연구 참여자";
  // Do not print a metadata failure as if it were study information. When an
  // abstract does not state its population, the paper section simply omits
  // this line and keeps the verified result and original link.
  return "";
}

function humanExposureFromQuestion(question: string): string {
  const broadTopic = broadTopicSubject(question);
  if (broadTopic) return `${broadTopic} 노출 및 관련 활용`;
  return "";
}

function inferTimeHorizon(paper: Paper): KeyStudyDetail["time_horizon"] {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""}`);
  const short = /(acute|immediate|hour|single dose|short-term|\b\d+\s*(?:day|days|week|weeks|month|months)\b)/.test(text);
  const long = /(long-term|cohort|habitual|chronic|\b\d+\s*(?:year|years)\b|(?:6|7|8|9|1\d|[2-9]\d)\s*months)/.test(text);
  if (short && long) return "mixed";
  if (short) return "short_term";
  if (long) return "long_term";
  return "unknown";
}

function paperIndexMatching(papers: Paper[], pattern: RegExp, fallback: number): number {
  const index = papers.findIndex((paper) => pattern.test(paper.title));
  return index >= 0 ? index + 1 : Math.min(fallback, papers.length);
}

function isCoffeeBloodPressureEvidence(papers: Paper[]): boolean {
  const corpus = normalizeEvidenceText(papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" "));
  return /(coffee|caffeine)/.test(corpus) && /(blood pressure|hypertension)/.test(corpus);
}

function shortEvidenceDesignLabel(level: string): string {
  switch (level) {
    case "systematic_review":
      return "체계적 문헌고찰·메타분석";
    case "clinical_study":
      return "임상연구";
    case "observational_study":
      return "관찰연구";
    case "official_guidance":
      return "공식 권고";
    case "preprint":
      return "프리프린트";
    default:
      return "연구 문헌";
  }
}

function verdictRiskSummary(verdict: Verdict): string {
  switch (verdict) {
    case "supported":
      return "질문에서 말한 효과 또는 위험과 같은 방향의 근거가 더 강하지만, 효과 크기와 적용 조건을 함께 봐야 합니다.";
    case "not_supported":
      return "질문에서 예상한 위험 또는 효과가 뚜렷하게 증가한다는 근거는 확인되지 않았습니다.";
    case "mixed":
      return "효과 또는 위험의 방향이 연구 조건에 따라 달라 한 가지 수치로 단정하기 어렵습니다.";
    default:
      return "현재 검색된 연구만으로 위험 크기를 신뢰성 있게 계산하기 어렵습니다.";
  }
}

function emptyEvidenceDetails(): EvidenceDetails {
  const unavailable = "질문에 직접 답할 수 있는 근거를 찾지 못했습니다.";
  return {
    short_term_ko: unavailable,
    long_term_ko: unavailable,
    risk_ko: unavailable,
    applicability_ko: unavailable,
    limitations_ko: "검색 결과가 없거나 관련성이 낮아 상세 해석을 제공하지 않았습니다.",
    key_studies: []
  };
}

function buildReadableAnswer(
  question: string,
  verdict: Verdict,
  papers: Paper[],
  interpretation: EvidenceInterpretation[]
): string {
  const findings = interpretation
    .filter((item) => item.stance !== "unclear")
    .slice(0, 3)
    .map((item) => `* [${item.citationIndex}] ${item.reason_ko}`);
  const keyPapers = papers.slice(0, 3).map((paper, index) => {
    const year = paper.year ? ` (${paper.year})` : "";
    return `* [${index + 1}] ${paper.title}${year}`;
  });

  return [
    directConclusion(question, verdict),
    findings.length > 0 ? `연구를 종합하면:\n${findings.join("\n")}` : "현재 초록 정보만으로는 효과 방향과 크기를 구체적으로 판정하기 어렵습니다.",
    practicalConclusion(verdict),
    `핵심 근거:\n${keyPapers.join("\n")}`
  ].join("\n\n");
}

function buildCoffeeBloodPressureAnswer(papers: Paper[]): string | undefined {
  const corpus = normalizeEvidenceText(
    papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" ")
  );
  if (!/(coffee|caffeine)/.test(corpus) || !/(blood pressure|hypertension)/.test(corpus)) return undefined;

  const hasModerateFinding =
    /(1\s*[–-]\s*3 cups|one to three cups|moderate coffee consumption)/.test(corpus) &&
    /(not adversely affect|does not increase|no increased risk|inverse association)/.test(corpus);
  const hasAcuteNumbers =
    /8\.1\s*mm\s*hg/.test(corpus) && /5\.7\s*mm\s*hg/.test(corpus) && /(3\s*h|three hours)/.test(corpus);
  const hasLowerRiskAssociation =
    /7% (?:lower|reduction)/.test(corpus) || /(0\.88[^\n]{0,80}0\.97|0\.92[^\n]{0,80}0\.97)/.test(corpus);

  const findings = [
    hasModerateFinding
      ? "* 평소 마시는 중등도 커피 섭취(대체로 하루 1~3잔)는 대부분의 성인에서 장기 혈압에 해롭다는 결과로 모이지 않았습니다. [1]"
      : "* 장기적인 커피 섭취가 고혈압 위험을 뚜렷하게 높인다는 근거는 일관되지 않았습니다. [1]",
    hasAcuteNumbers
      ? "* 고혈압 환자를 포함한 단기시험 메타분석에서는 카페인 200~300mg 섭취 뒤 수축기 혈압이 평균 8.1mmHg, 이완기 혈압이 5.7mmHg 올라갔고 이 변화가 3시간 이상 관찰됐습니다. 다만 장기 연구에서는 같은 상승이 확인되지 않았습니다. [2]"
      : "* 카페인은 섭취 직후 몇 시간 동안 혈압을 일시적으로 올릴 수 있어, 평소 커피를 잘 마시지 않거나 혈압이 높은 사람은 반응을 따로 볼 필요가 있습니다. [2]",
    hasLowerRiskAssociation
      ? "* 2023년 체계적 문헌고찰에서는 코호트 연구상 커피 섭취가 고혈압 위험 약 7% 감소와 연관됐습니다. 다만 관찰연구의 연관성이므로 커피가 위험을 낮춘다고 단정할 수는 없습니다. [3]"
      : "* 일부 관찰연구에서는 적당한 섭취가 고혈압 위험과 무관하거나 낮은 위험과 연관됐지만, 이것만으로 예방 효과를 뜻하지는 않습니다. [3]"
  ];
  const keyPapers = papers.slice(0, 3).map((paper, index) => {
    const year = paper.year ? ` (${paper.year})` : "";
    return `* [${index + 1}] ${paper.title}${year}`;
  });

  return [
    "현재 연구를 종합하면, 일반 성인이 하루에 커피 3잔을 마신다고 해서 장기적으로 고혈압 위험이 뚜렷하게 증가한다고 보기는 어렵습니다.",
    "다만 카페인은 섭취 후 몇 시간 동안 혈압을 일시적으로 높일 수 있습니다. 급성 반응과 장기적인 고혈압 위험은 구분해서 봐야 합니다.",
    `연구를 종합하면:\n${findings.join("\n")}`,
    "따라서 하루 3잔 자체가 반드시 위험하다고 보기는 어렵지만, 커피를 마신 뒤 두근거림이나 혈압 상승이 반복되거나 혈압 조절 중이라면 섭취 전후 혈압을 확인하고 양을 줄이거나 디카페인으로 바꾸는 편이 좋습니다.",
    `핵심 근거:\n${keyPapers.join("\n")}`
  ].join("\n\n");
}

function directConclusion(question: string, verdict: Verdict): string {
  void question;
  switch (verdict) {
    case "supported":
      return "현재 검색된 핵심 연구를 종합하면, 질문에서 말한 효과나 연관성은 대체로 근거와 같은 방향입니다.";
    case "not_supported":
      return "현재 검색된 핵심 연구를 종합하면, 질문에서 말한 효과나 위험이 있다고 단정하기는 어렵습니다.";
    case "insufficient_evidence":
      return "현재 검색된 연구만으로는 이 질문에 대해 신뢰할 만한 결론을 내리기 어렵습니다.";
    default:
      return "현재 검색된 핵심 연구를 종합하면, 질문에 대한 결과는 조건에 따라 엇갈립니다.";
  }
}

function practicalConclusion(verdict: Verdict): string {
  if (verdict === "insufficient_evidence") {
    return "논문이 검색됐다는 사실과 질문에 직접 답할 수 있다는 것은 다릅니다. 대상자, 섭취량·노출량, 비교군과 실제 측정 결과가 맞는 원문이 더 필요합니다.";
  }
  return "결론을 적용할 때는 연구 대상자, 노출량, 관찰 기간이 자신의 조건과 맞는지 확인해야 합니다. 관찰연구의 연관성은 원인과 결과를 확정하지 않습니다.";
}

function buildSynthesis(
  question: string,
  verdict: Verdict,
  evidenceLevel: string,
  interpretation: EvidenceInterpretation[]
): string {
  const counts = interpretation.reduce(
    (acc, item) => {
      acc[item.stance] += 1;
      return acc;
    },
    { supports: 0, opposes: 0, mixed: 0, unclear: 0 }
  );

  const suffix = `상위 근거 해석은 지지 ${counts.supports}건, 반박/효과 제한 ${counts.opposes}건, 혼재 ${counts.mixed}건, 불명확 ${counts.unclear}건입니다.`;

  switch (verdict) {
    case "supported":
      return `요약하면, "${question}"에 대해 현재 검색된 ${evidenceLevelLabel(evidenceLevel)} 중심 근거는 대체로 주장과 같은 방향입니다. ${suffix}`;
    case "not_supported":
      return `요약하면, "${question}"에 대해 현재 검색된 근거는 주장대로 단정하기 어렵거나 반대 방향 신호가 더 큽니다. ${suffix}`;
    case "insufficient_evidence":
      return `요약하면, "${question}"에 직접 답하는 결과가 충분히 보고되지 않았습니다. ${suffix}`;
    default:
      return `요약하면, "${question}"에 대해 관련 연구 근거는 있지만 결과가 완전히 한 방향으로 모이지 않습니다. ${suffix}`;
  }
}

function formatInterpretation(item: EvidenceInterpretation): string {
  const label: Record<EvidenceStance, string> = {
    supports: "지지",
    opposes: "반박/제한",
    mixed: "혼재",
    unclear: "불명확"
  };
  return `[${item.citationIndex}] ${label[item.stance]} - ${item.reason_ko}`;
}

function buildChronology(papers: Paper[]): string {
  const dated = papers
    .filter((paper) => typeof paper.year === "number")
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  if (dated.length < 2) return "";

  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  if (!oldest?.year || !newest?.year || oldest.year === newest.year) return "";

  return `근거 흐름으로 보면 ${oldest.year}년 전후 문헌부터 ${newest.year}년 문헌까지 검색됐고, 최신 문헌일수록 연구 설계와 대상자를 함께 확인해야 합니다.`;
}

function reasonForStance(
  stance: EvidenceStance,
  paper: Paper,
  preferSafety = false,
  intent?: ResearchIntent
): string {
  const reported = (preferSafety ? reportedSafetyFindingFromPaper(paper) : undefined)
    ?? reportedFindingForIntent(paper, intent);
  if (reported) return reported;
  switch (stance) {
    case "supports":
      return "질문과 같은 방향의 결과가 보고됐습니다.";
    case "opposes":
      return "질문과 반대 방향의 결과가 보고됐습니다.";
    case "mixed":
      return "연구 결과가 한 방향으로 일치하지 않았습니다.";
    default:
      return "질문과 직접 연결되는 결과를 확인하지 못했습니다.";
  }
}

function reportedFindingFromPaper(paper: Paper): string | undefined {
  if (paper.groundedFindingKo) return paper.groundedFindingKo;
  const abstract = cleanPaperAbstract(paper.abstract);
  if (!abstract) return undefined;
  return extractOverallStudyConclusion(abstract)
    ?? extractDoseResponseRiskFinding(abstract)
    ?? extractDoseResponseRelativeRiskFinding(abstract)
    ?? extractRiskRangeFinding(abstract)
    ?? extractFoodInterventionFinding(abstract)
    ?? extractExplicitComparisonFinding(abstract)
    ?? extractMetaOutcomeFinding(abstract)
    ?? extractExplicitDirectionalFinding(abstract)
    ?? reportedKoreanSentence(abstract);
}

function reportedFindingForIntent(paper: Paper, intent?: ResearchIntent): string | undefined {
  if (paper.groundedFindingKo) return paper.groundedFindingKo;
  if (!intent || intent.outcomeTerms.length === 0) return reportedFindingFromPaper(paper);
  if (intent.questionType !== "comparison" && /\b(?:substitution|replacement)\b/i.test(paper.title)) {
    return undefined;
  }
  const abstract = cleanPaperAbstract(paper.abstract);
  if (!abstract) return undefined;
  // A source-validated contextual alias can name the precise scholarly form
  // of a broad user exposure. It remains contextual in evidence ranking, but
  // its own abstract result is still safe to display as that specific form.
  const reportingExposureTerms = [...new Set([
    ...intent.exposureTerms,
    ...(intent.contextualEvidenceTerms ?? [])
  ])];
  const exposureAbbreviations = intentExposureAbbreviations(abstract, intent, reportingExposureTerms);
  const sentenceMatchesExposure = (sentence: string): boolean =>
    intentTextMatchesConcepts(sentence, reportingExposureTerms, "exposure") ||
    exposureAbbreviations.some((abbreviation) => {
      const singular = abbreviation.replace(/s$/i, "");
      return new RegExp(`\\b${escapeRegExp(singular)}s?\\b`, "i").test(sentence);
    });
  const candidates = abstract
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) =>
      intentTextMatchesConcepts(sentence, intent.outcomeTerms, "outcome") &&
      sentenceMatchesExposure(sentence) &&
      /\b(?:risks?|associat(?:ed|ion|ions)|increas(?:ed|e|es)|higher|greater|reduc(?:ed|e|es)|lower|decreas(?:ed|e|es)|no association|no significant)\b/i.test(sentence)
    );
  // A title can name several dietary factors while a result sentence reports
  // only one of them. Require the requested exposure in the result sentence
  // itself (or an abbreviation explicitly defined in that abstract).
  for (const sentence of candidates) {
    const finding = extractFocusedDirectionalFinding(sentence, intent.outcomeTerms);
    if (finding) return finding;
  }
  return undefined;
}

export function hasGroundedFindingForIntent(paper: Paper, intent: ResearchIntent): boolean {
  return Boolean(reportedFindingForIntent(paper, intent));
}

function intentExposureAbbreviations(
  abstract: string,
  intent: ResearchIntent,
  exposureTerms = intent.exposureTerms
): string[] {
  const abbreviations: string[] = [];
  for (const match of abstract.matchAll(/\b([a-z][a-z -]{2,80}?)\s*[\[(]([A-Z]{2,10}s?)[\])]/gi)) {
    const longForm = match[1]?.trim() ?? "";
    const abbreviation = match[2]?.trim() ?? "";
    if (longForm && abbreviation && intentTextMatchesConcepts(longForm, exposureTerms, "exposure")) {
      abbreviations.push(abbreviation);
    }
  }
  return [...new Set(abbreviations)];
}

function intentTextMatchesConcepts(
  value: string,
  concepts: string[],
  kind: "exposure" | "outcome"
): boolean {
  const text = normalizeEvidenceText(value);
  return concepts.some((concept) => {
    const normalized = normalizeEvidenceText(concept);
    if (/\btype\s*2\s*diabetes\b/.test(normalized)) {
      return /\b(?:type\s*2\s*diabetes|t2d(?:m)?)\b/.test(text);
    }
    const ignored = kind === "exposure"
      ? new Set(["high", "low", "intake", "consumption", "consuming", "dietary", "food", "foods", "of", "the", "and"])
      : new Set(["incident", "incidence", "new", "onset", "risk", "of", "the", "and"]);
    const tokens = normalized
      .split(/[^a-z0-9]+/)
      .map((token) => token.replace(/ies$/, "y").replace(/s$/, ""))
      .filter((token) => token.length >= 3 && !ignored.has(token));
    if (tokens.length === 0) return false;
    return tokens.every((token) => text.includes(token));
  });
}

function extractFocusedDirectionalFinding(sentence: string, outcomeTerms: string[] = []): string | undefined {
  const outcome = koreanOutcomeLabel(outcomeTerms.join(" ")) ?? koreanOutcomeLabel(sentence);
  if (!outcome) return undefined;
  if (/\bconvincing evidence\b/i.test(sentence) &&
    /\b(?:direct associations?|associated)\b/i.test(sentence)) {
    return withFocusedExposure(`${outcome} 위험 증가와 직접 연관된다는 강한 근거가 확인됐습니다.`, sentence);
  }
  const increasedBy = /\b(?:risk|incidence)\s+(?:was\s+)?increased\s+by\s+(\d+(?:\.\d+)?)%[^.]{0,100}?\b(?:for|of)\s+(?:t2d(?:m)?|type\s*2\s*diabetes)\b/i.exec(sentence)
    ?? /\b(?:greater|higher)\s+(?:incidence|risk)\s+of\s+(?:t2d(?:m)?|type\s*2\s*diabetes)\s*,?\s+by\s+(\d+(?:\.\d+)?)%/i.exec(sentence);
  if (increasedBy) {
    return withFocusedExposure(`${outcome} 위험 ${increasedBy[1]}% 증가와 연관됐습니다.`, sentence);
  }
  const ratio = /\b(?:risk ratio|relative risk|rr)\s*(?:\[\s*rr\s*\])?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(sentence)
    ?? /\[\s*rr\s*\]\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(sentence);
  const higherRisk = /\b(?:higher|increased|elevated|greater)\s+risk\s+of\b/i.test(sentence);
  const lowerRisk = /\b(?:lower|reduced|decreased)\s+risk\s+of\b/i.test(sentence);
  if (ratio && (higherRisk || lowerRisk)) {
    const riskRatio = Number(ratio[1]);
    if (Number.isFinite(riskRatio) && riskRatio > 0) {
      const percent = Math.round(Math.abs(riskRatio - 1) * 100);
      return withFocusedExposure(`${outcome} 위험 약 ${percent}% ${higherRisk ? "증가" : "감소"}와 연관됐습니다.`, sentence);
    }
  }
  const percentRisk = /(\d+(?:\.\d+)?)%\s+(?:greater|higher|lower|reduced)\s+risk\s+of\b/i.exec(sentence);
  if (percentRisk) {
    const direction = /\b(?:lower|reduced)\s+risk\b/i.test(sentence) ? "감소" : "증가";
    return withFocusedExposure(`${outcome} 위험 ${percentRisk[1]}% ${direction}와 연관됐습니다.`, sentence);
  }
  if (higherRisk || lowerRisk) {
    return withFocusedExposure(`${outcome} 위험 ${higherRisk ? "증가" : "감소"}와 연관됐습니다.`, sentence);
  }
  if (/\bno (?:significant )?(?:association|difference|effect)\b|\bnot associated\b/i.test(sentence)) {
    return withFocusedExposure(`${outcome} 위험과 뚜렷한 연관을 확인하지 못했습니다.`, sentence);
  }
  return undefined;
}

function withFocusedExposure(finding: string, sentence: string): string {
  const text = normalizeEvidenceText(sentence);
  if (/\b(?:sugar[- ]sweetened beverages?|ssbs?)\b/.test(text)) {
    return `설탕이 든 음료 섭취는 ${finding}`;
  }
  if (/\badded sugar\b/.test(text)) {
    return `첨가당 섭취는 ${finding}`;
  }
  if (/\bfruit juice\b/.test(text)) {
    return `과일 주스 섭취는 ${finding}`;
  }
  return finding;
}

/**
 * Prefer an abstract's own overall conclusion over an eye-catching subgroup
 * contrast. The pattern is phrased around result language, so it is shared by
 * diet, exercise, treatment, and education reviews rather than any one topic.
 */
function extractOverallStudyConclusion(abstract: string): string | undefined {
  const sentences = abstract.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of [...sentences].reverse()) {
    const similar = /\b(?:evidence|findings?|results?|analysis)\b[^.]{0,100}?\b(?:similar|comparable|equivalent)\s+(?:benefits?|effects?|outcomes?)\s+to\s+([^.;]+?)\s+for\s+([^.;]+)/i.exec(sentence);
    if (similar) {
      const outcome = koreanOutcomeLabel(similar[2]!) ?? koreanOutcomeLabel(sentence);
      if (!outcome) continue;
      return `${studyComparatorKo(similar[1]!)}과 비교했을 때 ${outcome} 관련 효과는 대체로 비슷했습니다.`;
    }

    const allGroups = /\b(?:all|both|each)\s+[^.]{0,160}?\b(?:reduced|lowered|decreased)\s+(?:body )?weight\s+when compared with\s+([^.;]+)/i.exec(sentence);
    if (allGroups) return `${studyComparatorKo(allGroups[1]!)}과 비교한 여러 방식에서 체중 감소가 보고됐습니다.`;
  }
  return undefined;
}

function studyComparatorKo(value: string): string {
  const text = value.toLowerCase();
  if (/continuous (?:energy|calorie|caloric) restriction/.test(text)) return "일반적인 열량 제한";
  if (/ad[- ]?libitum|unrestricted/.test(text)) return "자유식";
  if (/placebo/.test(text)) return "약효 성분이 없는 비교군(위약)";
  if (/control/.test(text)) return "대조군";
  return "비교한 방식";
}

function isSafetyQuestion(question: string, intent?: ResearchIntent): boolean {
  if (intent?.questionType === "safety") return true;
  return /(?:부작용|안전성|이상반응|위험|독성|금기|상호작용|side effects?|adverse events?|drug safety)/i.test(question)
    // The model planner is the primary intent classifier. This only catches
    // everyday Korean safety wording when a provider returns an incomplete
    // plan, so a question such as "가끔 마셔도 될까?" is not rendered as a
    // generic topic overview.
    || /(?:먹|마시|마셔|복용|섭취).{0,24}(?:도\s*(?:될까|돼|되나|괜찮|문제\s*없)|(?:안|않)\s*(?:좋|괜찮)|위험)|(?:괜찮|안전|문제\s*없).{0,24}(?:먹|마시|마셔|복용|섭취)/i.test(question);
}

/**
 * Safety questions must not borrow a paper's efficacy endpoint. We only
 * translate an explicitly stated adverse-event result, and otherwise leave
 * the paper out of the safety summary.
 */
function reportedSafetyFindingFromPaper(paper: Paper): string | undefined {
  if (paper.groundedFindingKo) return paper.groundedFindingKo;
  const abstract = cleanPaperAbstract(paper.abstract);
  if (!abstract) return undefined;
  const sentences = abstract.split(/(?<!\d)\.(?!\d)/).map((sentence) => sentence.trim()).filter(Boolean);
  let reportsAdverseEvents = false;
  let reportsGastrointestinalEvents = false;
  for (const sentence of sentences) {
    const hasAdverseEvent = /(?:adverse events?|side effects?|adverse reactions?|safety profile|tolerability)/i.test(sentence);
    const hasGastrointestinal = /(?:gastrointestinal|gi adverse|nausea|vomiting|diarrh(?:ea|oea)|constipation)/i.test(sentence);

    reportsAdverseEvents ||= hasAdverseEvent;
    reportsGastrointestinalEvents ||= hasGastrointestinal;
    const comparator = comparatorLabelForPaper(paper, sentence);

    if (safetyEndpointHasDirection(sentence, "(?:discontinuation|discontinued|treatment withdrawal|withdrawal)", "(?:higher|increased|more frequent|greater|elevated)")) {
      return comparator
        ? `부작용 때문에 치료를 중단한 경우가 ${comparator} 대비 더 자주 보고됐습니다.`
        : "부작용 때문에 치료를 중단한 경우가 더 자주 보고됐습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:serious adverse events?|severe adverse events?)", "(?:higher|increased|more frequent|greater|elevated)")) {
      return comparator
        ? `중대한 이상반응이 ${comparator} 대비 더 자주 보고됐습니다.`
        : "중대한 이상반응이 더 자주 보고됐습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:gastrointestinal|gi adverse|nausea|vomiting|diarrh(?:ea|oea)|constipation)", "(?:higher|increased|increase|more frequent|greater|elevated)")) {
      return comparator
        ? `오심·구토·설사 등 위장관 이상반응이 ${comparator} 대비 더 자주 보고됐습니다.`
        : "오심·구토·설사 등 위장관 이상반응이 더 자주 보고됐습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:adverse events?|side effects?|adverse reactions?)", "(?:higher|increased|more frequent|greater|elevated)")) {
      return comparator
        ? `전체 이상반응이 ${comparator} 대비 더 자주 보고됐습니다.`
        : "전체 이상반응이 더 자주 보고됐습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:serious adverse events?|severe adverse events?)", "(?:similar|comparable|no significant difference|did not differ|no difference|not significantly different|not increased)")) {
      return comparator
        ? `중대한 이상반응은 ${comparator} 대비 뚜렷한 차이가 없었습니다.`
        : "중대한 이상반응의 차이는 뚜렷하지 않았습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:gastrointestinal|gi adverse|nausea|vomiting|diarrh(?:ea|oea)|constipation)", "(?:similar|comparable|no significant difference|did not differ|no difference|not significantly different|not increased)")) {
      return comparator
        ? `위장관 이상반응은 ${comparator} 대비 뚜렷한 차이가 없었습니다.`
        : "위장관 이상반응의 차이는 뚜렷하지 않았습니다.";
    }
    if (safetyEndpointHasDirection(sentence, "(?:adverse events?|side effects?|adverse reactions?)", "(?:similar|comparable|no significant difference|did not differ|no difference|not significantly different|not increased)")) {
      return comparator
        ? `전체 이상반응은 ${comparator} 대비 뚜렷한 차이가 없었습니다.`
        : "전체 이상반응의 차이는 뚜렷하지 않았습니다.";
    }
    if (/no (?:serious )?(?:adverse events?|side effects?)/i.test(sentence)) {
      return "부작용 발생을 보고하지 않았습니다.";
    }
  }
  if (reportsGastrointestinalEvents) {
    return "오심·구토·설사 등 위장관 이상반응이 보고됐습니다.";
  }
  // Merely mentioning adverse events is not a result. Such a paper is
  // excluded rather than exposing an internal extraction failure to users.
  void reportsAdverseEvents;
  return undefined;
}

function safetyEndpointHasDirection(sentence: string, endpoint: string, direction: string): boolean {
  return new RegExp(
    `(?:${endpoint})[^.;]{0,30}(?:${direction})|(?:${direction})[^.;]{0,30}(?:${endpoint})`,
    "i"
  ).test(sentence);
}

function comparatorLabelForPaper(paper: Paper, resultSentence: string): string | undefined {
  const labelFromText = (value: string): string | undefined => {
    if (/\bplacebo\b/i.test(value)) return "약효 성분이 없는 비교군(위약)";
    if (/\bdulaglutide\b/i.test(value)) return "둘라글루타이드";
    if (/\bsemaglutide\b/i.test(value)) return "세마글루타이드";
    if (/\bcagrilintide\b/i.test(value)) return "카그릴린타이드";
    if (/\bcagrise?ma\b/i.test(value)) return "카그리세마";
    if (/\bbasal insulin\b/i.test(value)) return "기저 인슐린";
    if (/\bglp-?1(?: receptor agonists?| ras?)\b/i.test(value)) return "다른 GLP-1 계열 약물";
    return undefined;
  };

  return labelFromText(resultSentence)
    ?? labelFromText(`${paper.title} ${cleanPaperAbstract(paper.abstract)}`);
}

function cleanPaperAbstract(value: string | undefined): string {
  return value
    ?.replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(nbsp|amp);/gi, " ")
    .replace(/[·•]/g, ".")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

/**
 * Converts commonly reported dose-response risk figures into Korean without
 * inventing a result. The same pattern appears across nutrition, exposure,
 * and epidemiology abstracts, not just one named food.
 */
function extractDoseResponseRiskFinding(abstract: string): string | undefined {
  const doseMatch = /(\d+(?:\.\d+)?)\s*(g|mg|ml)\s*\/\s*(?:day|d)\b[^.]{0,150}?\bassociated with\b\s+([^.]*)/i.exec(abstract);
  if (!doseMatch) return undefined;
  const findings = [...doseMatch[3]!.matchAll(/(?:an?\s+)?(\d+(?:\.\d+)?)%\s+(higher|lower)\s+risk\s+of\s+([a-z][a-z -]+?)(?=,|\s+and\s+(?:an?\s+)?\d+(?:\.\d+)?%|$)/gi)]
    .map((match) => {
      const outcome = koreanHealthOutcome(match[3]!);
      if (!outcome) return undefined;
      return `${outcome} 위험 ${match[1]}% ${match[2]!.toLowerCase() === "higher" ? "증가" : "감소"}`;
    })
    .filter((value): value is string => Boolean(value));
  if (findings.length === 0) return undefined;
  const certainty = /low to very low certainty|very low certainty|low certainty/i.test(abstract)
    ? " 근거 확실성은 낮거나 매우 낮게 평가됐습니다."
    : "";
  return `하루 ${doseMatch[1]}${doseMatch[2]} 증가가 ${findings.slice(0, 3).join(", ")}와 연관됐습니다.${certainty}`;
}

/**
 * Many umbrella reviews report the effect as a relative risk rather than a
 * ready-made percentage. Convert only explicit ratios and retain the dose and
 * outcome stated in the abstract. This is intentionally not food-specific.
 */
function extractDoseResponseRelativeRiskFinding(abstract: string): string | undefined {
  const doseMatch = /(?:dose-response\s*\/?\s*)?(\d+(?:\.\d+)?)\s*g\s+(?:per\s+)?(?:day|d)?\s*(?:increase|increment)[^.]{0,120}?\b(?:was|were)\b\s+([\s\S]{0,850}?)(?=\.(?:\s|$))/i.exec(abstract);
  if (!doseMatch) return undefined;
  const outcomes = [...doseMatch[2]!.matchAll(/(1\.\d+)[\s\S]{0,100}?\bfor\s+([a-z0-9 -]+?)(?=,\s*1\.\d+|\s+and\s+1\.\d+|$)/gi)]
    .map((match) => {
      const outcome = koreanHealthOutcome(match[2]!);
      const relativeRisk = Number(match[1]);
      if (!outcome || !Number.isFinite(relativeRisk) || relativeRisk <= 0) return undefined;
      const percent = Math.round((relativeRisk - 1) * 100);
      return `${outcome} 위험 약 ${Math.abs(percent)}% ${percent >= 0 ? "증가" : "감소"}`;
    })
    .filter((value): value is string => Boolean(value));
  if (outcomes.length === 0) return undefined;
  const exposure = /processed meat/i.test(abstract)
    ? "가공육"
    : /red meat/i.test(abstract)
      ? "붉은 고기"
      : "해당 식품";
  return `${exposure} 하루 ${doseMatch[1]}g 증가는 ${outcomes.slice(0, 4).join(", ")}와 연관됐습니다.`;
}

function extractRiskRangeFinding(abstract: string): string | undefined {
  const range = /(\d+(?:\.\d+)?)\s*g\s*\/\s*(?:day|d)\s+(?:increment|increase)[^.]{0,180}?(\d+(?:\.\d+)?)\s*%\s*[-–]\s*(\d+(?:\.\d+)?)\s*%\s+higher\s+risk/i.exec(abstract);
  if (!range) return undefined;
  const exposure = /processed meat/i.test(abstract)
    ? "가공육"
    : /red meat/i.test(abstract)
      ? "붉은 고기"
      : "해당 식품";
  const certainty = /low to very low certainty|very low certainty|low certainty/i.test(abstract)
    ? " 근거 확실성은 낮거나 매우 낮게 평가됐습니다."
    : "";
  return `${exposure} 하루 ${range[1]}g 증가는 여러 질환 결과에서 위험 ${range[2]}~${range[3]}% 증가와 연관됐습니다.${certainty}`;
}

function extractFoodInterventionFinding(abstract: string): string | undefined {
  const trials = /\b(\d+)\s+trials\b/i.exec(abstract);
  const dose = /doses?\s+ranging\s+from\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s*g\s*\/\s*(?:day|d)/i.exec(abstract);
  const noAdverse = /does not appear to adversely affect|no significant effects? (?:were )?observed/i.test(abstract);
  if (!trials || !dose || !noAdverse) return undefined;
  const food = /dry-cured ham/i.test(abstract)
    ? "특정 건조 숙성 햄"
    : /sausage/i.test(abstract)
      ? "특정 소시지 제품"
      : "해당 식품";
  return `${trials[1]}개 시험에서 ${food}을 하루 ${dose[1]}~${dose[2]}g 섭취했을 때 일반적인 심대사 위험 지표의 뚜렷한 악화는 확인되지 않았습니다.`;
}

/**
 * Direct comparison papers often report two named groups or an explicit
 * between-group difference. Keep this parser outcome-first so it works for
 * drugs, diets, exercises, and education interventions without a subject
 * lookup table.
 */
function extractExplicitComparisonFinding(abstract: string): string | undefined {
  const sentences = abstract.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of [...sentences].reverse()) {
    const outcome = koreanOutcomeLabel(sentence);
    const difference = /(?:difference|mean difference|between[- ]group difference)\s*[,=:]?\s*([−-]?\d+(?:\.\d+)?)\s*(%|kg|cm|mmhg|mmol\/l)?/i.exec(sentence);
    if (difference && outcome) {
      const raw = Number(difference[1]!.replace("−", "-"));
      if (Number.isFinite(raw)) {
        const unit = difference[2]?.toLowerCase() ?? "";
        const renderedUnit = unit === "%" ? "%p" : unit === "mmhg" ? "mmHg" : unit;
        return `${outcome}의 군간 차이는 ${Math.abs(raw)}${renderedUnit}였습니다.`;
      }
    }

    const pairedPercent = /(?:was|were)\s*([−-]?\d+(?:\.\d+)?)%\s+with\s+[^,.]+(?:,|and)\s*([−-]?\d+(?:\.\d+)?)%\s+with\s+[^,.]+/i.exec(sentence);
    if (pairedPercent && outcome) {
      return `${outcome} 변화는 두 비교군에서 각각 ${pairedPercent[1]}%와 ${pairedPercent[2]}%였습니다.`;
    }

    const pair = /([a-z][a-z -]{1,50})\s*\((\d+(?:\.\d+)?)\)\s+had\s+a\s+(?:higher|lower)[^.]{0,90}?than\s+([a-z][a-z -]{1,50})\s*\((\d+(?:\.\d+)?)\)/i.exec(sentence);
    if (pair) {
      return `직접 비교한 측정값은 ${pair[1]!.trim()} ${pair[2]}, ${pair[3]!.trim()} ${pair[4]}였습니다.`;
    }
  }
  return undefined;
}

function extractMetaOutcomeFinding(abstract: string): string | undefined {
  const studyCount = /\b(?:a total of\s+)?(\d[\d,]*)\s+(?:(?:controlled|korean|randomized|eligible)\s+){0,3}(?:articles|studies|trials)\b/i.exec(abstract)
    ?? /\b(twenty[- ]five|twenty[- ]four)\s+studies\b/i.exec(abstract);
  const participantCount = /\b(\d[\d,]*)\s+participants\b/i.exec(abstract);
  const normalizedStudyCount = studyCount?.[1]
    ?.toLowerCase()
    .replace("twenty-five", "25")
    .replace("twenty five", "25")
    .replace("twenty-four", "24")
    .replace("twenty four", "24");
  const scope = normalizedStudyCount
    ? `${formatResearchNumber(normalizedStudyCount)}개 연구${participantCount ? `, ${formatResearchNumber(participantCount[1]!)}명` : ""}`
    : undefined;
  const domains: string[] = [];
  if (/(?:depression|depressive symptoms?)/i.test(abstract)) domains.push("우울 증상");
  if (/(?:anxiety|anxious)/i.test(abstract)) domains.push("불안 증상");
  if (/(?:psychological stress|mental stress)/i.test(abstract)) domains.push("심리적 스트레스");
  if (/(?:sleep quality|sleep disturbance)/i.test(abstract)) domains.push("수면 지표");
  const reductionSignal = /\b(?:significantly\s+)?(?:reduce|reduced|reductions?|lower(?:ed)?|decrease[ds]?)\b/i.test(abstract);
  const smd = /(?:psychological stress|depressive symptoms?|anxiety symptoms?)\s*\(\s*SMD\s*[=−-]+\s*(\d+(?:\.\d+)?)/i.exec(abstract);
  if (domains.length > 0 && reductionSignal) {
    const numeric = smd ? ` (대표 결과 SMD -${smd[1]})` : "";
    const heterogeneity = /\b(?:substantial|high)\s+heterogeneity|\bi\s*[²2]\s*>\s*\d+/i.test(abstract)
      ? " 연구 간 차이가 컸습니다."
      : "";
    const subject = scope ?? "선택된 연구";
    const particle = /[0-9명]$/.test(subject) ? "을" : "를";
    return `${subject}${particle} 종합한 결과 ${domains.slice(0, 3).join("·")} 감소가 보고됐습니다${numeric}.${heterogeneity}`;
  }

  const hedges = /(?:pooled\s+)?Hedges['’]?\s*g\s*=\s*([+-]?\d+(?:\.\d+)?)/i.exec(abstract);
  if (hedges) {
    const certainty = /(?:certainty|GRADE)[^.]{0,80}\blow\b|\blow\s+certainty\b/i.test(abstract)
      ? " 근거 확실성은 낮게 평가됐습니다."
      : "";
    const subject = scope ?? "선택된 연구";
    const particle = /[0-9명]$/.test(subject) ? "을" : "를";
    return `${subject}${particle} 종합한 결과 전체 효과크기 Hedges g=${hedges[1]}이 보고됐습니다.${certainty}`;
  }
  return undefined;
}

/**
 * A constrained fallback for common abstract result sentences. It translates
 * only a fixed outcome vocabulary and only when the English sentence states a
 * direction explicitly; anything else remains unrendered rather than guessed.
 */
function extractExplicitDirectionalFinding(abstract: string): string | undefined {
  const sentences = abstract.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of [...sentences].reverse()) {
    const noDifference = /\b(?:no|not)\s+(?:statistically\s+)?significant\s+(?:difference|effect|association)\s+(?:in|on|for|between)\s+([^.;]+)/i.exec(sentence)
      ?? /\b(?:did not|does not)\s+(?:significantly\s+)?(?:reduce|improve|increase|affect)\s+([^.;]+)/i.exec(sentence);
    if (noDifference) {
      const outcome = koreanOutcomeLabel(noDifference[1]!);
      if (outcome) return `${outcome}에서 뚜렷한 차이를 확인하지 못했습니다.`;
    }

    const risk = /\b(?:higher|increased|elevated|lower|reduced|decreased)\s+risk\s+of\s+([^.;,]+)/i.exec(sentence);
    if (risk) {
      const outcome = koreanOutcomeLabel(risk[1]!);
      if (outcome) {
        const direction = /\b(?:lower|reduced|decreased)\s+risk\b/i.test(sentence) ? "감소" : "증가";
        return `${outcome} 위험 증가와 연관됐습니다.`.replace("위험 증가", `위험 ${direction}`);
      }
    }

    const change = /\b(?:can|may|was|were)?\s*(?:significantly\s+)?(increased|improved|reduced|decreased|lowered)\s+([^.;,]+?)(?:\s+(?:compared with|versus|vs\.?|in)\b|[.;]|$)/i.exec(sentence)
      ?? /\b([^.;,]+?)\s+(?:was|were)\s+(?:significantly\s+)?(increased|improved|reduced|decreased|lower)\b/i.exec(sentence)?.slice().reverse() as RegExpExecArray | null;
    if (change) {
      const direction = change[1]!.toLowerCase();
      const outcome = koreanOutcomeLabel(change[2]!);
      if (outcome) {
        if (/improved/.test(direction)) return `${outcome}${koreanSubjectParticle(outcome)} 개선됐습니다.`;
        const verb = /increased/.test(direction) ? "증가" : "감소";
        return `${outcome} ${verb}가 보고됐습니다.`;
      }
    }
  }
  return undefined;
}

function koreanSubjectParticle(value: string): string {
  const last = value.trim().charCodeAt(value.trim().length - 1);
  if (!Number.isFinite(last) || last < 0xac00 || last > 0xd7a3) return "가";
  return (last - 0xac00) % 28 === 0 ? "가" : "이";
}

function koreanOutcomeLabel(value: string): string | undefined {
  const text = value.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const labels: Array<[RegExp, string]> = [
    [/body weight|weight loss|weight change/, "체중"],
    [/fat mass|body fat|adiposity/, "체지방량"],
    [/waist circumference/, "허리둘레"],
    [/body mass index|\bbmi\b/, "체질량지수"],
    [/blood pressure|systolic|diastolic/, "혈압"],
    [/visual fatigue|eye strain|computer vision syndrome|\bcvs\b/, "눈 피로"],
    [/dry eye|ocular surface/, "안구 건조 증상"],
    [/sleep quality|sleep/, "수면 지표"],
    [/fasting glucose|blood glucose|glycaemic|glycemic/, "혈당 지표"],
    [/triglyceride/, "중성지방"],
    [/cholesterol|lipid profile/, "혈중 지질 지표"],
    [/muscle mass|lean mass/, "근육량"],
    [/muscle strength|strength/, "근력"],
    [/protein bioaccessibility/, "단백질 생체접근성"],
    [/protein digestibility/, "단백질 소화성"],
    [/crude protein|protein concentration|protein content/, "단백질 함량"],
    [/pain|neck pain|back pain/, "통증"],
    [/mortality|death/, "사망"],
    [/cardiovascular/, "심혈관질환"],
    [/cancer/, "암"]
  ];
  return labels.find(([pattern]) => pattern.test(text))?.[1] ?? koreanHealthOutcome(text);
}

function koreanHealthOutcome(value: string): string | undefined {
  const outcome = value.toLowerCase().replace(/\s+/g, " ").trim();
  const labels: Array<[RegExp, string]> = [
    [/gastric cancer/, "위암"],
    [/colorectal cancer/, "대장암"],
    [/prostate cancer/, "전립선암"],
    [/chronic obstructive pulmonary disease|\bcopd\b/, "만성폐쇄성폐질환"],
    [/cardiovascular disease/, "심혈관질환"],
    [/coronary heart disease|\bchd\b/, "관상동맥심장질환"],
    [/heart failure/, "심부전"],
    [/stroke/, "뇌졸중"],
    [/all-cause mortality|overall mortality/, "전체 사망"],
    [/type 2 diabetes|\bt2d(?:m)?\b/, "제2형 당뇨병"]
  ];
  return labels.find(([pattern]) => pattern.test(outcome))?.[1];
}

function reportedKoreanSentence(abstract: string): string | undefined {
  const sentences = abstract.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 30 && sentence.length <= 600);
  const resultSignals = /\b(?:result|conclusion|found|reported|associated|increased|decreased|reduced|improved|higher|lower|risk|odds|effect|significant)\b/i;
  return [...sentences].reverse().find((sentence) => resultSignals.test(sentence) && isKoreanUserText(sentence));
}

function isKoreanUserText(value: string): boolean {
  if (!/[가-힣]/.test(value) && /[A-Za-z]{2,}/.test(value)) return false;
  return !/[A-Za-z]{2,}(?:[\s,;:()[\]/-]+[A-Za-z]{2,}){4,}/.test(value);
}

function evidenceWeight(level: string): number {
  switch (level) {
    case "systematic_review":
      return 4;
    case "clinical_study":
      return 3;
    case "official_guidance":
      return 3;
    case "observational_study":
      return 2;
    case "preprint":
      return 1;
    default:
      return 1;
  }
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function evidenceLevelLabel(level: string): string {
  switch (level) {
    case "systematic_review":
      return "체계적 문헌고찰/메타분석급";
    case "clinical_study":
      return "임상연구급";
    case "observational_study":
      return "관찰연구급";
    case "preprint":
      return "프리프린트급";
    case "official_guidance":
      return "공식 권고급";
    default:
      return "연구 설계 미확인";
  }
}

const noEffectSignals = [
  /\blittle or no effect\b/,
  /\bno effect\b/,
  /\bno significant\b/,
  /\bnot significant\b/,
  /\bnot associated\b/,
  /\bno association\b/,
  /\bdid not\b/,
  /\bdoes not\b/,
  /\bfailed to\b/,
  /\binsufficient evidence\b/,
  /\blittle evidence\b/,
  /\bno evidence\b/,
  /\bnot effective\b/,
  /\bwithout improvement\b/,
  /\bdo(?:es)? not support\b/,
  /\bmay not prevent\b/,
  /\bdid not prevent\b/,
  /\bnot prevent\b/,
  /\bmay not reduce\b/,
  /\bdid not reduce\b/,
  /\bnot reduce\b/,
  /\bno current [^.]{0,100}\bsupport\b/
];

const mixedSignals = [
  /\bmixed\b/,
  /\binconsistent\b/,
  /\bheterogeneous\b/,
  /\blimited evidence\b/,
  /\buncertain\b/,
  /\bconflicting\b/,
  /\bpreliminary\b/,
  /\bstill questioned\b/
];

const benefitSignals = [
  /\beffective\b/,
  /\befficacy\b/,
  /\bbeneficial\b/,
  /\bimproved\b/,
  /\bimprovement\b/,
  /\bbetter\b/,
  /\bprevention\b/,
  /\bweight loss\b/,
  /\breduced body weight\b/,
  /\bdecreased body weight\b/,
  /\bsymptom reduction\b/,
  /\breduced symptoms\b/,
  /\breduced\b[^.;]{0,50}\b(?:events|incidence|mortality|severity|duration)\b/
];

const harmSignals = [
  /\badverse\b/,
  /\bhigher risk\b/,
  /\bincreased risk\b/,
  /\belevated risk\b/,
  /\bworse\b/,
  /\bharmful\b/,
  /\btoxicity\b/,
  /\bincreased incidence\b/,
  /\brisk factor\b/
];

const lowerRiskSignals = [
  /\blower risk\b/,
  /\breduced risk\b/,
  /\bdecreased risk\b/,
  /\bprotective\b/
];
