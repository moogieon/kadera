import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { isConsumerHealthEvidenceCandidate } from "./evidence.js";
import { screenSafety } from "./safety.js";
import type { ClaimCheckerService } from "./service.js";
import { categories, type EvidenceLevel, type EvidenceSearchResult, type Paper } from "./types.js";

/**
 * Kakao Tools caps a tool description at 1,024 characters and warns that an
 * over-long one hurts tool-call rate for this tool and for every other tool in
 * the user's 도구함. Keep this text spent on the calling decision: what the
 * service is, the Korean utterances that should trigger it, and what must not.
 * Answer-writing policy belongs in the tool result, not here.
 */
export const searchPaperEvidenceDescription =
  "Kadera(카더라 말고) checks Korean everyday health rumors against live scholarly papers from PubMed, Europe PMC, OpenAlex and Crossref. Call it whenever the user asks whether something is good, bad, safe, effective, or true about health, food, diet, supplements, medicine, exercise, sleep, parenting, child development, psychology, or study methods, even when the user never says paper, research, or evidence. Typical Korean triggers: '소시지 몸에 안 좋아?', '크레아틴 먹으면 탈모 와?', '달걀 하루 두 개 괜찮아?', '간헐적 단식 효과 있어?', '아기한테 영상 보여줘도 돼?', '명상하면 불안 줄어?', '이거 진짜야?', '카더라 아니야?'. Prefer calling it over answering from memory: the user wants verified papers, not recollection. Do not call it for casual chat, creative writing, personal opinions, shopping, or anything involving personal or medical-record data.";

export function createKaderaMcpServer(service: ClaimCheckerService): McpServer {
  const server = new McpServer({
    name: "kadera-malgo",
    version: "0.1.0"
  });

  server.registerTool(
    "search_paper_evidence",
    {
      title: "논문 근거 확인",
      description: searchPaperEvidenceDescription,
      annotations: {
        title: "카더라 검증",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: {
        question: z.string().min(2).max(350).describe("The user's question in Korean, with personal and medical-record details removed."),
        academic_query: z.string().min(3).max(450).describe("Required. One English scholarly search query. Example: 'energy drink blood pressure systematic review'."),
        topic_terms: z.array(z.string().min(2).max(100)).min(1).max(4).optional().describe("English name of the exact item asked about, plus true synonyms. Example: ['energy drink']."),
        parent_terms: z.array(z.string().min(2).max(100)).min(1).max(3).optional().describe("Broader English exposure, only when the exact item has little direct research. Example for lard: ['saturated fat']."),
        outcome_terms: z.array(z.string().min(2).max(100)).min(1).max(4).optional().describe("English name of the outcome asked about. Example: ['blood pressure'].")
      }
    },
    async ({ question, academic_query, topic_terms, parent_terms, outcome_terms }) => {
      // The MCP surface is the only one Kakao users reach, and it ran no
      // safety screen at all: a question about how to end one's life came back
      // as drug research. Refuse before retrieval, and tell the host what to
      // say instead of letting it improvise from papers.
      const crisis = crisisRedirectForHost(question);
      if (crisis) return { content: [{ type: "text", text: crisis }], isError: false };
      // No scholarly source indexes Korean. When the host echoes the user's
      // Korean question into academic_query the search returns nothing, and
      // the user is told no research exists on a topic that has plenty. Ask
      // the host to retry in English instead of reporting a false negative.
      const retryNotice = untranslatedQueryNotice(academic_query);
      if (retryNotice) return { content: [{ type: "text", text: retryNotice }], isError: true };
      const evidence = await service.findHostEvidence({
        question,
        academicQuery: academic_query,
        topicTerms: topic_terms,
        parentTerms: parent_terms,
        outcomeTerms: outcome_terms
      });
      return {
        content: [{ type: "text", text: formatHostEvidenceForMcp(evidence) }],
        structuredContent: hostEvidenceStructuredContent(evidence)
      };
    }
  );

  if (service.diagnosticToolsEnabled()) {
    server.registerTool(
      "find_evidence",
      {
        title: "근거 논문 검색",
        description: "답변 생성 없이 연결된 연구 데이터베이스에서 관련 연구 메타데이터를 검색합니다.",
        annotations: {
          title: "근거 논문 검색",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        },
        inputSchema: {
          question: z.string().min(2).max(350).describe("검색할 한국어 질문 또는 주장. 개인정보, 계정정보, 비밀번호는 넣지 마세요."),
          category: z.enum(categories).optional().default("auto").describe("분야. 모르면 auto"),
          limit: z.number().int().min(1).max(10).optional().default(5).describe("소스별 검색 개수")
        }
      },
      async (input) => {
        const evidence = await service.findEvidence(input);
        return {
          content: [{ type: "text", text: JSON.stringify(evidence, null, 2) }],
          structuredContent: { ...evidence }
        };
      }
    );

    server.registerTool(
      "popular_claims",
      {
        title: "인기 카더라",
        description: "개인정보 없이 익명 집계된 반복 검증 주제를 반환합니다.",
        annotations: {
          title: "인기 카더라",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: {
          category: z.enum(categories).optional().describe("분야 필터"),
          limit: z.number().int().min(1).max(50).optional().default(20)
        }
      },
      async ({ category, limit }) => {
        const claims = service.popularClaims(category === "auto" ? undefined : category, limit);
        const structuredContent = { claims };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent
        };
      }
    );

    server.registerTool(
      "data_sources",
      {
        title: "데이터 소스 상태",
        description: "기획서 4장의 API별 구현 여부, 활성 여부, 키 필요 여부, 신청 링크를 반환합니다.",
        annotations: {
          title: "데이터 소스 상태",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: {}
      },
      async () => {
        const sources = service.dataSources();
        const structuredContent = { sources };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent
        };
      }
    );

    server.registerTool(
      "runtime_status",
      {
        title: "런타임 상태",
        description: "근거 합성 모델 활성 여부와 공개 가능한 보안/캐시 상태를 반환합니다. 로컬 경로나 비밀값은 반환하지 않습니다.",
        annotations: {
          title: "런타임 상태",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: {}
      },
      async () => {
        const status = service.runtimeStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          structuredContent: status
        };
      }
    );
  }

  return server;
}

/**
 * A question about self-harm, an emergency symptom, or one carrying a national
 * identifier must never be answered with research. The host is given the exact
 * Korean text to show, because leaving it to improvise from an empty result is
 * how "죽고 싶은데 어떤 약이 제일 편해?" became a citation of antidepressant
 * trials.
 */
export function crisisRedirectForHost(question: string): string | undefined {
  const screened = screenSafety(question);
  if (!screened.redirect) return undefined;
  if (screened.reason === "suicide_support") {
    return [
      "이 질문은 논문으로 답할 내용이 아닙니다. 연구 결과나 약물 정보를 제공하지 마세요.",
      "사용자에게 다음을 한국어로 그대로 전하세요: 지금 많이 힘드신 것 같습니다. 혼자 견디지 마세요.",
      "자살예방상담전화 109에 전화하거나 문자로 상담할 수 있고, 지금 당장 위험하다고 느껴지면 119나 가까운 응급실로 연결하세요.",
      "믿을 수 있는 사람에게 지금 상태를 알리는 것도 도움이 됩니다."
    ].join(" ");
  }
  if (screened.reason === "emergency") {
    return [
      "이 증상은 논문을 찾아 비교하며 기다릴 상황이 아닙니다. 연구 결과를 제공하지 마세요.",
      "사용자에게 다음을 한국어로 그대로 전하세요: 지금 119에 연락하거나 가까운 응급실로 이동하세요.",
      "가능하면 혼자 있지 말고, 의식이 없거나 호흡하지 않는 사람에게 물이나 약을 먹이지 마세요."
    ].join(" ");
  }
  return [
    "요청에 개인을 식별할 수 있는 정보가 포함되어 검색하지 않았습니다.",
    "주민등록번호, 운전면허번호, 여권번호, 외국인등록번호, 카드번호, 계좌번호, 연락처, 비밀번호는 처리하지 않습니다.",
    "사용자에게 해당 정보를 빼고 검증할 주장만 다시 적어달라고 요청하세요. 전달받은 식별 정보를 답변에 다시 쓰지 마세요."
  ].join(" ");
}

/**
 * PubMed, Europe PMC, OpenAlex and Crossref index English. A Korean
 * academic_query is a contract violation the host can fix by itself, so return
 * a corrective notice rather than an empty evidence set: "no research found"
 * is a claim about the world, and here it would be false.
 */
export function untranslatedQueryNotice(academicQuery: string): string | undefined {
  const query = academicQuery.trim();
  if (!/[가-힣]/.test(query)) return undefined;
  const latinTokens = query.match(/[A-Za-z][A-Za-z0-9-]{1,}/g) ?? [];
  if (latinTokens.length >= 2) return undefined;
  return [
    "academic_query가 영어 학술 검색어가 아니라 한국어 그대로 전달되어 검색을 실행하지 않았습니다.",
    "논문 데이터베이스는 영어만 색인하므로, 이 상태로 검색하면 연구가 있어도 결과가 비어 있게 됩니다.",
    "한국어 대상명을 영어 학술 용어로 바꿔 다시 호출하세요. 의약품은 상품명이 아니라 성분명을 쓰세요.",
    "예: '위고비' → 'semaglutide', '마운자로' → 'tirzepatide', '타이레놀' → 'acetaminophen'.",
    "사용자에게 관련 연구가 없다고 답하지 마세요."
  ].join(" ");
}

export function formatHostEvidenceForMcp(evidence: EvidenceSearchResult): string {
  const papers = hostEvidencePapers(evidence);
  if (papers.length === 0) return noUsableEvidenceNotice(evidence);

  // The tool description no longer carries answer-writing policy: that text
  // competes for the 1,024-character trigger budget and only matters once the
  // host has already decided to call. It belongs here, where it is read at the
  // moment the answer is written.
  const scopes = new Set(papers.map((paper) => hostEvidenceScope(paper, evidence)));
  const glossary = evidence.glossary ?? [];
  const lines = [
    "## 카더라 말고(Kadera) 논문 근거",
    "아래는 원문 초록에서 확인한 결과입니다. 최종 답변은 한국어로 쓰되 이 목록에 없는 사실·수치를 추가하지 말고, 기억이나 일반 지식으로 보완하지 마세요. '연관'을 인과관계로 바꾸지 말고, 연구 간 결과가 엇갈리면 그 사실을 밝히고, 원문 링크를 함께 보여주세요.",
    [
      "최종 답변은 다음 로컬 Kadera 형식을 유지하고, 짧은 일반론으로 축약하지 마세요:",
      "1) '## 현재 판단' — 반드시 첫 줄을 '**한줄 결론:**'으로 시작하고, 효과가 있는지, 일반적인 대안보다 나은지, 가장 중요한 불확실성이 무엇인지 숫자 없이 평이한 한 문장으로 먼저 답하세요. 그 아래 1~2개 문단에서 대표 연구의 수치와 중요한 예외를 설명",
      "2) '## 이번 판단에 사용한 근거' — 조회한 후보 문헌 수와 대표 논문 수를 명시",
      "3) '## 연구 결과 한눈에 보기' — '연구 | 핵심 결과' 2열 표로 대표 논문을 모두 비교",
      "4) '## 대표 논문 N편' — 각 논문마다 연도·연구 유형, 원문 제목, 대상·조건(초록에서 확인될 때만), 결과, 한계, 클릭 가능한 원문 링크를 표시",
      "5) 안전성 결과가 있으면 '## 논문에서 확인된 안전성'",
      "6) '## 연구를 읽을 때' — 대상·측정·추적 기간 차이와 일반화 한계를 설명",
      "수치와 논문별 차이를 생략하지 말고, 근거에 없는 실천법을 덧붙이거나 '시작한다면' 같은 미완성 문장으로 끝내지 마세요. 대상·조건이나 기간을 초록에서 확인할 수 없으면 추측하지 말고 해당 항목을 생략하세요."
    ].join("\n"),
    // Papers are indexed by ingredient and by scholarly term, so an answer
    // about "마운자로" comes back as findings about tirzepatide. Left
    // unexplained the reader cannot tell which number is about what they
    // asked. Supply the pairs we can verify, and require the host to gloss
    // the rest rather than silently swapping the user's vocabulary.
    "논문은 상품명이 아니라 성분명·학술용어로 검색됩니다. 사용자가 쓴 말과 다른 용어가 답변에 등장하면 처음 나올 때 '티르제파타이드(마운자로)'처럼 괄호로 사용자가 쓴 이름을 함께 적으세요. 비교 질문이면 어느 수치가 어느 쪽인지 반드시 구분되게 쓰세요.",
    ...(glossary.length > 0
      ? [`확인된 용어 대응: ${glossary.map((entry) => `${entry.term} = ${entry.askedAs}`).join(" · ")}`]
      : []),
    `이번 조회에서 초록이 있는 후보 ${evidence.retrievedPaperCount ?? papers.length}편 중 대표 논문 ${papers.length}편을 골랐습니다.`,
    ...(scopes.has("related")
      ? ["일부 논문은 질문의 정확한 대상과 일치하는지 확인되지 않았습니다. 해당 논문은 참고 근거로만 소개하고 질문에 대한 결론으로 단정하지 마세요."]
      : []),
    ...papers.map((paper, index) => [
      `### ${index + 1}. ${paper.title}`,
      `- 연구 유형: ${evidenceLevelLabel(paper.evidenceLevel)}${paper.year ? ` · ${paper.year}년` : ""}`,
      `- 근거 범위: ${hostEvidenceScopeLabel(hostEvidenceScope(paper, evidence))}`,
      `- 초록 결과: ${sourceResultExcerpt(paper.abstract)}`,
      `- 원문: ${paper.url}`
    ].join("\n"))
  ];
  return lines.join("\n\n");
}

/**
 * "No reliable research found" is a claim about the world, so it must only be
 * made when the search really came back empty. A vague query does the
 * opposite: "lard" alone retrieves soap formulation, Raman spectroscopy and
 * rat-offspring studies, all correctly discarded, and the user was then told
 * that pork fat has never been studied.
 */
export function noUsableEvidenceNotice(evidence: EvidenceSearchResult): string {
  if ((evidence.retrievedPaperCount ?? 0) === 0) {
    return "관련해서 답할 만한 신뢰도 높은 연구를 찾지 못했습니다.";
  }
  return [
    `검색 자체는 성공해 문헌 ${evidence.retrievedPaperCount}편을 확인했지만, 질문의 대상·결과와 일치하면서 초록에서 결과를 확인할 수 있는 대표 논문은 0편이었습니다.`,
    "'현재 확인된 대표 연구는 다음과 같습니다' 같은 빈 목록을 만들지 마세요.",
    "검색어 또는 outcome_terms가 논문에서 쓰는 표현보다 좁을 수 있습니다. 대상과 알고 싶은 결과를 포함하되 동의어를 사용한 더 구체적인 영어 학술 검색어로 한 번만 다시 호출하세요.",
    "예: 'lard' 대신 'lard saturated fat LDL cholesterol cardiovascular risk'.",
    "사용자에게 관련 연구가 없다고 답하지 마세요."
  ].join(" ");
}

function hostEvidenceStructuredContent(evidence: EvidenceSearchResult) {
  const papers = hostEvidencePapers(evidence);
  const retrievedPaperCount = evidence.retrievedPaperCount ?? 0;
  return {
    status: papers.length > 0 ? "ok" : retrievedPaperCount > 0 ? "retrieved_but_filtered" : "no_results",
    response_format: "kadera_local_detailed",
    retrieved_paper_count: retrievedPaperCount,
    usable_paper_count: papers.length,
    glossary: (evidence.glossary ?? []).map((entry) => ({ term: entry.term, asked_as: entry.askedAs })),
    papers: papers.map((paper) => ({
      title: paper.title,
      year: paper.year,
      evidence_level: paper.evidenceLevel,
      evidence_scope: hostEvidenceScope(paper, evidence),
      abstract_result: sourceResultExcerpt(paper.abstract),
      url: paper.url
    }))
  };
}

function hostEvidencePapers(evidence: EvidenceSearchResult): Paper[] {
  const seen = new Set<string>();
  const candidates = evidence.papers
    .filter((paper) => Boolean(paper.url) && Boolean(paper.abstract?.trim()))
    // The fast MCP path receives a host-provided academic query instead of a
    // local LLM intent. Apply the same generic consumer-health gate used by
    // the full pipeline so a result about packaging, animal feed, or pork-fat
    // preservation cannot reach the host just because it shares topic words.
    .filter((paper) => isConsumerHealthEvidenceCandidate(paper))
    .filter((paper) => !/\b(?:protocol|study protocol)\b/i.test(paper.title))
    .filter((paper) => {
      const key = `${paper.doi ?? paper.sourceId}|${paper.title}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const resultBearingCandidates = candidates.filter((paper) => hasReportableSourceResult(paper));
  const evidenceBearingCandidates = resultBearingCandidates.filter((paper) =>
    paper.evidenceLevel !== "unknown" && paper.evidenceLevel !== "preprint"
  );
  const usableCandidates = evidenceBearingCandidates.length > 0
    ? evidenceBearingCandidates
    : resultBearingCandidates.length > 0
      ? resultBearingCandidates
      : candidates;
  const exactTopicAnchors = hostTopicTerms(evidence);
  const parentAnchors = hostParentTerms(evidence);
  const exactMatched = exactTopicAnchors.length > 0
    ? usableCandidates.filter((paper) => hostTopicAnchorHits(paper, exactTopicAnchors) > 0)
    : usableCandidates;
  const exactTitleMatched = exactTopicAnchors.length > 0
    ? exactMatched.filter((paper) => hostTopicAnchorHits({ ...paper, abstract: undefined }, exactTopicAnchors) > 0)
    : exactMatched;
  const exactRepresentativePool = exactTitleMatched.length >= Math.min(3, exactMatched.length)
    ? exactTitleMatched
    : exactMatched;
  // Broader evidence is intentionally title-anchored. A broad review can
  // mention "saturated fat" in background while studying an unrelated oil;
  // it is useful only when that broader exposure is the paper's real subject.
  const parentTitleMatched = parentAnchors.length > 0
    ? usableCandidates.filter((paper) => hostTopicAnchorHits({ ...paper, abstract: undefined }, parentAnchors) > 0)
    : [];
  const scopedPapers = uniqueHostPapers([...exactRepresentativePool, ...parentTitleMatched]);
  // A supplied label that matches nothing is a labelling failure by the host,
  // not proof that no research exists. Returning an empty set here reported
  // "no reliable research found" for questions whose evidence had already been
  // retrieved, simply because the host wrote "processed meats" for a
  // literature that writes "processed meat". Fall back to the ranked candidate
  // pool instead; hostEvidenceScope marks those papers as unverified scope.
  const topicRepresentativePool = scopedPapers.length > 0 ? scopedPapers : usableCandidates;
  const outcomeAnchors = usableAnchors(evidence.hostOutcomeTerms?.map((term) => term.trim()).filter(Boolean) ?? []);
  // Outcome labels are host-written concepts, not guaranteed title phrases.
  // Requiring them verbatim in the title made a carefully-filled call worse
  // than one that omitted outcome_terms: intermittent-fasting searches found
  // dozens of papers, then discarded all of them because papers write "body
  // weight" and "cardiometabolic risk" instead of "weight loss" and
  // "metabolic health". Conversely, searching the whole abstract admits BMI
  // papers for a height question because Methods sections record height to
  // calculate BMI. Match concepts in titles and in result-bearing text only.
  const outcomeInTitle = outcomeAnchors.length > 0
    ? topicRepresentativePool.filter((paper) => hostOutcomeAnchorHits(paper.title, outcomeAnchors) > 0)
    : [];
  const outcomeInResults = outcomeAnchors.length > 0
    ? topicRepresentativePool.filter((paper) => hostOutcomeAnchorHits(outcomeEvidenceText(paper), outcomeAnchors) > 0)
    : [];
  const outcomeMatched = outcomeAnchors.length === 0
    ? topicRepresentativePool
    : [...outcomeInTitle, ...outcomeInResults.filter((paper) => !outcomeInTitle.includes(paper))];
  // Never trade the endpoint for a paper count. This used to drop the outcome
  // filter whenever fewer than three papers matched it, so "일찍 자면 키가
  // 클까?" came back with sleep-and-myopia and sleep-and-obesity: the topic
  // matched and the question did not. One paper about the right outcome beats
  // five about the wrong one, and none beats a confident wrong answer.
  const rankingPool = outcomeAnchors.length > 0
    ? outcomeMatched
    : topicRepresentativePool.length > 0
      ? topicRepresentativePool
      : usableCandidates;
  return rankingPool
    .sort((left, right) => hostEvidencePaperScore(right, exactTopicAnchors, parentAnchors) - hostEvidencePaperScore(left, exactTopicAnchors, parentAnchors))
    .slice(0, 5);
}

function hasReportableSourceResult(paper: Paper): boolean {
  const excerpt = sourceResultExcerpt(paper.abstract);
  return !isAbstractMethodSentence(excerpt) && abstractResultScore(excerpt) >= 15;
}

function sourceResultExcerpt(abstract: string | undefined): string {
  const clean = decodeAbstractText(abstract ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "초록 결과를 제공하지 않았습니다.";
  const labelledResults = extractLabelledResultSection(clean);
  const sentences = splitAbstractSentences(labelledResults ?? clean);
  const selected = [...sentences]
    .map((sentence, index) => ({ sentence, index, score: abstractResultScore(sentence) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.sentence
    ?? sentences.at(-1)
    ?? clean;
  return selected.length > 700 ? `${selected.slice(0, 699).trimEnd()}…` : selected;
}

function hostEvidencePaperScore(paper: Paper, exactTopicAnchors: string[], parentAnchors: string[]): number {
  const title = paper.title.toLowerCase();
  const excerpt = sourceResultExcerpt(paper.abstract).toLowerCase();
  const levelScore = paper.evidenceLevel === "systematic_review"
    ? 500
    : paper.evidenceLevel === "clinical_study"
      ? 330
      : paper.evidenceLevel === "observational_study"
        ? 230
        : paper.evidenceLevel === "official_guidance"
          ? 190
          : 0;
  const measurableResult = /\b\d+(?:[.,]\d+)?\s*(?:%|mm\s*hg|mmhg|bpm|mg|g|kg|ml|l|ci|rr|or|hr)\b/i.test(excerpt) ? 120 : 0;
  const outcomeResult = /\b(?:increas(?:ed|e|es)|decreas(?:ed|e|es)|reduc(?:ed|e|es)|higher|lower|associated with|linked to|did not differ|no significant|adverse|risk|improv(?:ed|e|es))\b/i.test(excerpt) ? 70 : 0;
  const surveyPenalty = /\b(?:prevalence|consumption patterns?|motivations?|self-reported|consumer attitudes?|survey|questionnaire)\b/i.test(title) ? 180 : 0;
  const titlePaper = { ...paper, abstract: undefined };
  const directTitleHit = hostTopicAnchorHits(titlePaper, exactTopicAnchors) > 0;
  const parentTitleHit = hostTopicAnchorHits(titlePaper, parentAnchors) > 0;
  const exactTopicScore = hostTopicAnchorHits(paper, exactTopicAnchors) * 180;
  const parentTopicScore = hostTopicAnchorHits(paper, parentAnchors) * 45;
  const scopeScore = directTitleHit ? 360 : parentTitleHit ? 90 : 0;
  return levelScore + measurableResult + outcomeResult + exactTopicScore + parentTopicScore + scopeScore - surveyPenalty + Math.min(20, Math.max(0, (paper.year ?? 2000) - 2000));
}

function hostTopicTerms(evidence: EvidenceSearchResult): string[] {
  const supplied = usableAnchors(evidence.hostTopicTerms?.map((term) => term.trim()).filter(Boolean) ?? []);
  if (supplied.length) return supplied;
  return deriveTopicTermsFromQuery(evidence.queryTerms);
}

function hostParentTerms(evidence: EvidenceSearchResult): string[] {
  return usableAnchors(evidence.hostParentTerms?.map((term) => term.trim()).filter(Boolean) ?? []);
}

type HostEvidenceScope = "direct" | "parent" | "related";

function hostEvidenceScope(paper: Paper, evidence: EvidenceSearchResult): HostEvidenceScope {
  const topicAnchors = hostTopicTerms(evidence);
  const parentAnchors = hostParentTerms(evidence);
  // With nothing to check the paper against, claiming a scope would be an
  // invention. Only an actual anchor hit may be reported as direct evidence.
  if (topicAnchors.length === 0 && parentAnchors.length === 0) return "direct";
  const titlePaper = { ...paper, abstract: undefined };
  if (hostTopicAnchorHits(titlePaper, topicAnchors) > 0) return "direct";
  if (hostTopicAnchorHits(titlePaper, parentAnchors) > 0) return "parent";
  if (hostTopicAnchorHits(paper, topicAnchors) > 0) return "direct";
  return "related";
}

function hostEvidenceScopeLabel(scope: HostEvidenceScope): string {
  switch (scope) {
    case "direct": return "직접 주제";
    case "parent": return "상위 주제 보완 근거";
    default: return "주제 관련 근거(정확 일치는 확인되지 않음)";
  }
}

function uniqueHostPapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = `${paper.doi ?? paper.source}:${paper.sourceId}|${paper.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deriveTopicTermsFromQuery(queryTerms: string[]): string[] {
  const stopwords = new Set([
    "adverse", "adversely", "effect", "effects", "outcome", "outcomes", "health", "safety", "safe", "risk", "risks",
    "systematic", "review", "meta", "analysis", "clinical", "trial", "trials", "study", "studies", "evidence",
    "blood", "pressure", "disease", "diseases", "adult", "adults", "human", "humans", "association", "associated",
    "acute", "chronic", "long", "term", "terms", "benefit", "benefits", "harm", "harms", "randomized", "controlled",
    "with", "without", "from", "that", "this", "these", "those", "and", "the", "for", "into", "among", "versus", "vs"
  ]);
  const firstQuery = queryTerms.find((term) => /[a-z]/i.test(term)) ?? "";
  const tokens = firstQuery.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const topicTokens: string[] = [];
  for (const token of tokens) {
    if (stopwords.has(token)) break;
    topicTokens.push(token);
    if (topicTokens.length >= 4) break;
  }
  return topicTokens.length > 0 ? [topicTokens.join(" ")] : [];
}

const anchorStopwords = new Set(["and", "or", "of", "the", "with", "for", "in", "on", "to", "vs", "versus"]);

function anchorTokens(anchor: string): string[] {
  return (anchor.toLowerCase().match(/[a-z0-9-]{2,}/g) ?? [])
    .filter((token) => !anchorStopwords.has(token));
}

/**
 * A host label written in Korean cannot be matched against English abstracts.
 * Treating it as an anchor rejected every candidate and reported "no research
 * found"; dropping it lets the scholarly query supply the anchors instead.
 */
function usableAnchors(anchors: string[]): string[] {
  return anchors.filter((anchor) => anchorTokens(anchor).length > 0);
}

/**
 * Match a supplied label morphologically in both directions. The host commonly
 * sends a plural canonical form ("processed meats", "energy drinks") for a
 * literature that writes the singular, and the reverse also happens.
 */
function tokenPattern(token: string): string {
  const stem = anchorStem(token);
  // "saturated fat" and "saturated fatty acid" are the same parent exposure
  // for retrieval purposes. Keep this narrowly morphological so it does not
  // turn a food topic into an arbitrary semantic match.
  if (stem === "fat") return "fat(?:s|ty)?";
  if (stem.endsWith("y") && stem.length > 2) {
    return `${escapeRegex(stem.slice(0, -1)).replace(/-/g, "[- ]")}(?:y|ies)`;
  }
  return `${escapeRegex(stem).replace(/-/g, "[- ]")}(?:e?s|e)?`;
}

function anchorStem(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es") && token.length > 3) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 2) return token.slice(0, -1);
  return token;
}

function hostTopicAnchorHits(paper: Paper, anchors: string[]): number {
  const text = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  return anchorHitsInText(text, anchors);
}

function anchorHitsInText(text: string, anchors: string[]): number {
  const normalizedText = text.toLowerCase();
  const present = (token: string): boolean =>
    new RegExp(`\\b${tokenPattern(token)}\\b`, "i").test(normalizedText);
  return anchors.filter((anchor) => {
    const tokens = anchorTokens(anchor);
    if (tokens.length === 0) return false;
    if (new RegExp(`\\b${tokens.map(tokenPattern).join("\\s+")}\\b`, "i").test(normalizedText)) return true;
    if (tokens.length < 2) return false;
    // The host label is often a longer phrase than the literature uses: "red
    // and processed meat" against a paper titled "Processed meat intake and
    // colorectal cancer". Accept it when the head noun and at least half of
    // the qualifiers appear, so one extra qualifier cannot discard the whole
    // evidence set. The head noun alone is never enough.
    const head = tokens.at(-1) ?? "";
    if (!present(head)) return false;
    const qualifiers = tokens.slice(0, -1);
    return qualifiers.filter(present).length >= Math.ceil(qualifiers.length / 2);
  }).length;
}

type OutcomeConcept = {
  recognizes: RegExp;
  appearsAs: RegExp;
};

// This is deliberately a small vocabulary of common outcome labels, not a
// general synonym engine. Each group is bounded to measurements that can
// answer the same consumer question. Topic matching above still has to pass,
// and matches in abstracts are limited to Results/Conclusions text.
const outcomeConcepts: OutcomeConcept[] = [
  {
    recognizes: /\b(?:weight loss|body weight|weight reduction|weight change)\b/i,
    appearsAs: /\b(?:weight loss|body weight|weight reduction|weight change|lost (?:body )?weight|weight (?:decreased|declined|was reduced))\b/i
  },
  {
    recognizes: /\b(?:metabolic health|metabolic outcomes?|cardiometabolic health|cardiometabolic outcomes?)\b/i,
    appearsAs: /\b(?:cardiometabolic|metabolic (?:health|risk|factors?|markers?|profile|parameters?|outcomes?|syndrome)|glyc(?:a?emic)|blood glucose|insulin resistance|lipid profile|cholesterol|triglycerides?)\b/i
  },
  {
    recognizes: /\b(?:safety|tolerability|adverse events?|side effects?)\b/i,
    appearsAs: /\b(?:safety|tolerability|adverse (?:events?|effects?|reactions?)|side effects?|serious events?|nausea|vomiting|diarrhea|constipation|discontinu(?:ation|ed)|withdr(?:awal|ew))\b/i
  },
  {
    recognizes: /\b(?:glyc(?:a?emic) control|blood glucose|glucose control|hba1c)\b/i,
    appearsAs: /\b(?:glyc(?:a?emic)|blood glucose|fasting glucose|glucose control|hba1c|insulin resistance)\b/i
  },
  {
    recognizes: /\b(?:lipid profile|blood lipids?|cholesterol|triglycerides?)\b/i,
    appearsAs: /\b(?:lipid profile|blood lipids?|cholesterol|ldl|hdl|triglycerides?)\b/i
  },
  {
    recognizes: /\b(?:final adult height|adult height|linear growth|growth velocity|height|stature)\b/i,
    appearsAs: /\b(?:final adult height|adult height|height gain|height velocity|linear growth|growth velocity|stature|statural growth)\b/i
  }
];

function hostOutcomeAnchorHits(text: string, anchors: string[]): number {
  return anchors.filter((anchor) => {
    if (anchorHitsInText(text, [anchor]) > 0) return true;
    return outcomeConcepts.some((concept) => concept.recognizes.test(anchor) && concept.appearsAs.test(text));
  }).length;
}

function outcomeEvidenceText(paper: Paper): string {
  const cleanAbstract = decodeAbstractText(paper.abstract ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const resultText = extractLabelledResultSection(cleanAbstract) ?? sourceResultExcerpt(cleanAbstract);
  return `${paper.title} ${resultText}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLabelledResultSection(text: string): string | undefined {
  const labels = "results?|findings?|main results?|data analysis|conclusions?";
  const sectionBoundary = "background|context|objective|aims?|methods?|materials?|data sources?|data extraction|data analysis|results?|findings?|main results?|conclusions?|discussion|registration";
  const match = text.match(new RegExp(`\\b(?:${labels})\\s*:\\s*([\\s\\S]*?)(?=\\s+\\b(?:${sectionBoundary})\\s*:\\s*|$)`, "i"));
  return match?.[1]?.trim() || undefined;
}

function splitAbstractSentences(text: string): string[] {
  return text.split(/(?<=[.!?])(?:["')\]]+)?\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function abstractResultScore(sentence: string): number {
  const normalized = sentence.toLowerCase();
  let score = 0;
  if (/^(?:aim|objective|purpose|background|introduction|methods?)\b/i.test(normalized)) score -= 80;
  if (hasDirectionalSourceResult(sentence)) score += 30;
  if (/\b\d+(?:[.,]\d+)?\s*(?:%|mm\s*hg|mmhg|bpm|mg|g|kg|ml|l|ci|rr|or|hr)\b/i.test(sentence)) score += 40;
  if (/\b\d+(?:[.,]\d+)?\s*(?:stud(?:y|ies)|articles?|participants?|patients?|trials?|rcts?|references?)\b/i.test(sentence)) score += 10;
  if (/\brisk of bias\b/i.test(normalized)) score -= 60;
  if (/\b(?:included|screened|references?|articles?|studies?|participants?)\b/.test(normalized) &&
    !hasDirectionalSourceResult(sentence)) score -= 35;
  // "We included 29 studies" is a methods/counting sentence, not a result.
  // It can contain a large number and otherwise outrank the outcome sentence
  // in a meta-analysis abstract. A true result with a direction is exempt.
  if (/\b(?:we\s+)?(?:included|screened)\b[^.]{0,160}\b(?:stud(?:y|ies)|trial(?:s)?|article(?:s)?|participant(?:s)?)\b/i.test(sentence) &&
    !hasDirectionalSourceResult(sentence)) score -= 50;
  if (isAbstractMethodSentence(sentence)) score -= 100;
  if (/\b(?:methods?|objective|background)\b/.test(normalized)) score -= 20;
  return score;
}

function hasDirectionalSourceResult(sentence: string): boolean {
  const directionalLanguage = /\b(?:increas(?:ed|e|es|ing)|decreas(?:ed|e|es|ing)|reduc(?:ed|e|es|tion|tions)|higher|lower|greater|less|associated with|linked to|did not differ|no significant|improv(?:ed|e|es|ement)|wors(?:e|ened|ens)|benefi(?:t|cial)|harmful)\b/i.test(sentence);
  const measuredRatio = /\b(?:risk ratio|relative risk|odds ratio|hazard ratio)\b\s*(?:\([^)]{0,24}\)\s*)?(?:(?:=|:|of)\s*)?\d+(?:[.,]\d+)?\b/i.test(sentence) ||
    // Abbreviated estimates are uppercase in abstracts, so this stays
    // case-sensitive: a lowercase "or" is the English conjunction.
    /\b(?:RR|HR|OR|aHR|aOR|SMD|MD|WMD)\s*(?:\([^)]{0,24}\)\s*)?(?:=|:)?\s*[-−]?\d/.test(sentence);
  return directionalLanguage || measuredRatio || hasNullSourceResult(sentence);
}

/**
 * "No difference" is a finding, not the absence of one, and for a rumour-
 * checking service it is often the answer the user needs. It was being scored
 * as a non-result: the counting penalty below fires on "the confidence
 * interval included no effect" because of the word "included", so any paper
 * reporting a null or uncertain outcome was dropped whenever a paper with a
 * strong positive result was also retrieved.
 */
function hasNullSourceResult(sentence: string): boolean {
  return /\b(?:no (?:significant |clear |consistent )?(?:effect|association|difference|benefit|evidence of)|not (?:significantly )?associated|did not (?:differ|increase|reduce|change|improve)|confidence intervals? (?:included|crossed)|crossed the null|null (?:effect|result)|inconclusive|uncertain(?:ty)? (?:about|regarding|in) the (?:effect|benefit)|certainty of (?:the )?evidence was (?:very )?low)\b/i.test(sentence);
}

function isAbstractMethodSentence(sentence: string): boolean {
  return /^(?:we\s+)?(?:conducted|performed|undertook|aimed|sought|evaluated|assessed|investigated|reviewed|summari[sz]ed)\b/i.test(sentence.trim()) &&
    !hasDirectionalSourceResult(sentence);
}

function decodeAbstractText(value: string): string {
  return value
    // Europe PMC frequently wraps sections in heading tags rather than
    // writing "RESULTS:". Preserve those labels before removing the markup
    // so the result extractor does not join a methods sentence to a conclusion.
    .replace(/<h[1-6][^>]*>\s*([^<]+?)\s*<\/h[1-6]>/gi, "$1: ")
    .replace(/&(lt|gt|amp|nbsp);/gi, (_match, entity: string) => ({ lt: "<", gt: ">", amp: "&", nbsp: " " })[entity.toLowerCase()] ?? " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/<[^>]+>/g, " ");
}

function validCodePoint(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff;
}

function evidenceLevelLabel(level: EvidenceLevel): string {
  switch (level) {
    case "systematic_review": return "체계적 문헌고찰·메타분석";
    case "clinical_study": return "임상·비교 연구";
    case "observational_study": return "관찰연구";
    case "official_guidance": return "공식 권고·과학 자문";
    case "preprint": return "프리프린트";
    default: return "연구 문헌";
  }
}
