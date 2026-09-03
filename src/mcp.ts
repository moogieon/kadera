import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { PaperReferenceRecord } from "./cache.js";
import type { HostMcpLocalization, HostMcpLocalizationSource } from "./clients/openai.js";
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
  "MUST CALL this Kadera(카더라 말고) tool before answering any Korean question, claim, rumor, or curiosity that can be checked with academic research. The user does not need to say paper or research. Exact registered starters that MUST trigger it: '마운자로에대해 알려줘' and '제로 탄산이 몸에 안좋다던데 진짜 몸에 안좋은가?'. Also call for health, medicine, drugs, food, nutrition, supplements, exercise, sleep, parenting, child development, education, psychology, and study methods, including whether something is true, safe, harmful, helpful, or effective. It searches live scholarly sources and returns a complete Korean answer (완성 답변) with real paper links and [1234-a] follow-up keys. Pass the user's Korean text unchanged in question. Do not answer from model memory first. Do not call for casual chat, creative writing, opinions, shopping, or personal or medical-record data.";

export const getPaperDetailDescription =
  "MUST CALL this Kadera(카더라 말고) paper-detail tool whenever the user gives a paper key in the form 1234-a and asks to view, explain, summarize, translate, or inspect that paper. Exact registered starter that MUST trigger it: '8903-a 논문에 대해서 자세히 알려줘'. Pass only the exact key as paper_id; brackets are optional. It returns the saved title, bibliography, link, and complete available abstract so you can translate every abstract sentence faithfully into Korean and explain the design, participants, results, numbers, and limitations. Do not answer from memory, guess another key, start a new topic search, or claim the abstract is the full paper.";

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
        academic_query: z.string().min(3).max(450).optional().describe("Optional compatibility field. If omitted, Kadera creates the English scholarly query internally."),
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
      const retryNotice = academic_query ? untranslatedQueryNotice(academic_query) : undefined;
      if (retryNotice) return { content: [{ type: "text", text: retryNotice }], isError: true };
      const evidence = await findMcpEvidence(service, {
        question,
        academicQuery: academic_query,
        topicTerms: topic_terms,
        parentTerms: parent_terms,
        outcomeTerms: outcome_terms
      });
      if (!evidence) {
        return {
          content: [{
            type: "text",
            text: "카더라 말고가 질문을 영어 학술 검색어로 변환하지 못했습니다. 관련 연구가 없다고 답하지 말고, 잠시 후 같은 질문으로 다시 호출하세요."
          }],
          isError: true
        };
      }
      const savedReferences = service.savePaperReferences(hostEvidencePapers(evidence));
      const directReferences = savedReferences.filter((reference) =>
        hostEvidenceScope(reference.paper, evidence) === "direct"
      );
      // Once direct evidence exists, unrelated topic-only papers make the
      // answer look fuller but weaker. Keep them stored for diagnostics, not
      // displayed as if they helped settle the user's actual question.
      const references = directReferences.length > 0 ? directReferences : savedReferences;
      const displayEvidence = { ...evidence, papers: references.map((reference) => reference.paper) };
      const evidencePacket = formatHostEvidenceForMcp(displayEvidence, references);
      const answerSources = hostAnswerSources(displayEvidence, references);
      const localization = await service
        .localizeHostMcpPapers(question, answerSources)
        .catch((error: unknown) => {
          console.error(`[mcp-answer] localization failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        });
      const completedAnswer = localization
        ? formatCompletedHostAnswer(displayEvidence, references, answerSources, localization)
        : undefined;
      return {
        content: [{ type: "text", text: completedAnswer ?? evidencePacket }],
        structuredContent: hostEvidenceStructuredContent(evidence, savedReferences)
      };
    }
  );

  server.registerTool(
    "get_paper_detail",
    {
      title: "선택 논문 자세히 보기",
      description: getPaperDetailDescription,
      annotations: {
        title: "논문 상세·한국어 번역",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        paper_id: z.string().min(6).max(10).describe("Paper key shown by Kadera, for example '1234-a'. Keep letters and numbers exactly as displayed; brackets are optional.")
      }
    },
    async ({ paper_id }) => {
      const reference = service.getPaperReference(paper_id);
      if (!reference) {
        const text = [
          `논문 키 '${paper_id}'를 저장된 검색 결과에서 찾지 못했습니다.`,
          "키를 추측하거나 다른 논문으로 대체하지 마세요.",
          "사용자에게 search_paper_evidence로 주제를 다시 검색한 뒤 결과에 표시된 [xxxx-a] 형식의 키를 보내달라고 안내하세요."
        ].join(" ");
        return { content: [{ type: "text", text }], isError: true };
      }
      return {
        content: [{ type: "text", text: formatPaperDetailForMcp(reference) }],
        structuredContent: paperDetailStructuredContent(reference)
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

interface McpSearchInput {
  question: string;
  academicQuery?: string;
  topicTerms?: string[];
  parentTerms?: string[];
  outcomeTerms?: string[];
}

export async function findMcpEvidence(
  service: Pick<ClaimCheckerService, "findQuestionEvidence" | "findHostEvidence">,
  input: McpSearchInput
): Promise<EvidenceSearchResult | undefined> {
  const academicQuery = input.academicQuery?.replace(/\s+/g, " ").trim();
  if (!academicQuery) return service.findQuestionEvidence(input.question);
  return service.findHostEvidence({
    question: input.question,
    academicQuery,
    topicTerms: input.topicTerms,
    parentTerms: input.parentTerms,
    outcomeTerms: input.outcomeTerms
  });
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

export function formatHostEvidenceForMcp(
  evidence: EvidenceSearchResult,
  references: PaperReferenceRecord[] = []
): string {
  const papers = hostEvidencePapers(evidence);
  if (papers.length === 0) return noUsableEvidenceNotice(evidence);

  // The tool description no longer carries answer-writing policy: that text
  // competes for the 1,024-character trigger budget and only matters once the
  // host has already decided to call. It belongs here, where it is read at the
  // moment the answer is written.
  const scopes = new Set(papers.map((paper) => hostEvidenceScope(paper, evidence)));
  const glossary = evidence.glossary ?? [];
  const followUpExamples = references.slice(0, 2).map((reference, index) =>
    index === 0
      ? `- “${reference.paperId} 논문 자세히 알려줘”`
      : `- “${reference.paperId} 초록 전체를 한국어로 번역해줘”`
  );
  const lines = [
    "## 카더라 말고(Kadera) 논문 근거",
    "아래는 원문 초록에서 확인한 결과입니다. 최종 답변의 제목·표·설명·논문명은 모두 자연스러운 한국어로 쓰세요. 영문 논문 제목과 PubMed·Europe PMC 같은 데이터베이스 이름은 사용자가 요청하지 않는 한 본문에 노출하지 말고, 링크 문구는 모두 '원문 보기'로 통일하세요. LDL·HbA1c처럼 통용되는 의학 약어와 수치 단위만 원문 표기를 유지하세요. 이 목록에 없는 사실·수치를 추가하거나 기억·일반 지식으로 보완하지 마세요. '연관'을 인과관계로 바꾸지 말고, 연구 간 결과가 엇갈리면 그 사실을 밝히세요.",
    ...(references.length > 0
      ? ["각 대표 논문에는 제공된 [1234-a] 형식의 논문 키를 표 첫 열과 상세 제목에 그대로 표시하세요. [1] 같은 새 번호로 바꾸거나 키를 생략하지 마세요. 사용자가 나중에 '1234-a 논문 자세히 알려줘'처럼 말하면 get_paper_detail이 그 논문을 다시 엽니다."]
      : []),
    [
      "최종 답변은 다음 로컬 Kadera 형식을 유지하고, 짧은 일반론으로 축약하지 마세요:",
      "1) '## 현재 판단' — 반드시 첫 줄을 '**한줄 결론:**'으로 시작하고, 효과가 있는지, 일반적인 대안보다 나은지, 가장 중요한 불확실성이 무엇인지 숫자 없이 평이한 한 문장으로 먼저 답하세요. 그 아래 1~2개 문단에서 대표 연구의 수치와 중요한 예외를 설명",
      "2) '## 이번 판단에 사용한 근거' — 조회한 후보 문헌 수와 대표 논문 수를 명시",
      "3) '## 연구 결과 한눈에 보기' — '연구 | 핵심 결과' 2열 표로 대표 논문을 모두 비교",
      "4) '## 대표 논문 N편' — 각 논문마다 논문 제목을 한국어로 번역해 표시하고, 연도·연구 유형, 대상·조건(초록에서 확인될 때만), 결과, 한계, '[원문 보기](URL)' 링크를 표시. 영문 원제는 사용자가 요청할 때만 표시",
      "5) 안전성 결과가 있으면 '## 논문에서 확인된 안전성'",
      "6) '## 연구를 읽을 때' — 대상·측정·추적 기간 차이와 일반화 한계를 설명",
      ...(followUpExamples.length > 0
        ? ["7) 맨 마지막에 '## 논문을 더 자세히 보고 싶다면' — 실제 논문 키를 넣은 후속 질문 예시와 상세조회에서 제공되는 내용을 안내"]
        : []),
      "'## 대표 논문 N편' 제목만 쓰고 끝내지 말고, 바로 아래에 반드시 N개의 논문 상세 블록을 모두 작성하세요. 수치와 논문별 차이를 생략하지 말고, 근거에 없는 실천법을 덧붙이거나 '시작한다면' 같은 미완성 문장으로 끝내지 마세요. 대상·조건이나 기간을 초록에서 확인할 수 없으면 추측하지 말고 해당 항목을 생략하세요."
    ].join("\n"),
    ...(followUpExamples.length > 0
      ? [[
          "최종 답변 맨 끝에 아래 안내를 실제 논문 키와 함께 그대로 포함하세요:",
          "## 논문을 더 자세히 보고 싶다면",
          "궁금한 논문 키를 골라 이렇게 물어보세요.",
          ...followUpExamples,
          "해당 논문의 초록 전체 번역, 연구 설계와 대상, 주요 수치, 해석할 때의 한계를 자세히 확인할 수 있습니다."
        ].join("\n")]
      : []),
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
    ...(scopes.has("topic_context") || scopes.has("outcome_context")
      ? ["직접 근거가 부족한 자리는 '질문 대상 자체를 다룬 연구'와 '질문한 결과 자체를 다룬 연구'로만 보완했습니다. 이 보완 근거를 질문의 대상과 결과를 직접 연결한 증거처럼 쓰지 마세요."]
      : []),
    ...(scopes.has("related")
      ? ["일부 논문은 질문의 정확한 대상과 일치하는지 확인되지 않았습니다. 해당 논문은 참고 근거로만 소개하고 질문에 대한 결론으로 단정하지 마세요."]
      : []),
    ...papers.map((paper, index) => [
      `### ${index + 1}. ${paperReferenceLabel(references[index])}번역 대상 논문`,
      ...(references[index] ? [`- 논문 키: [${references[index].paperId}]`] : []),
      `- 번역할 영문 제목(최종 답변에는 한국어 제목만 표시): ${paper.title}`,
      `- 연구 유형: ${evidenceLevelLabel(paper.evidenceLevel)}${paper.year ? ` · ${paper.year}년` : ""}`,
      `- 근거 범위: ${hostEvidenceScopeLabel(hostEvidenceScope(paper, evidence))}`,
      `- 초록 결과: ${sourceResultExcerpt(paper.abstract)}`,
      `- 원문 보기 링크: ${paper.url}`
    ].join("\n"))
  ];
  return lines.join("\n\n");
}

interface HostAnswerSource extends HostMcpLocalizationSource {
  year?: number;
  designKo: string;
  scopeKo: string;
  url: string;
}

function hostAnswerSources(
  evidence: EvidenceSearchResult,
  references: PaperReferenceRecord[]
): HostAnswerSource[] {
  return references.map((reference) => ({
    paperId: reference.paperId,
    title: reference.paper.title,
    result: sourceResultExcerpt(reference.paper.abstract),
    year: reference.paper.year,
    designKo: evidenceLevelLabel(reference.paper.evidenceLevel),
    scopeKo: hostEvidenceScopeLabel(hostEvidenceScope(reference.paper, evidence)),
    url: reference.paper.url
  }));
}

export function formatCompletedHostAnswer(
  evidence: EvidenceSearchResult,
  references: PaperReferenceRecord[],
  sources: HostAnswerSource[],
  localization: HostMcpLocalization
): string {
  const localizedPapers = localization.papers;
  const localizedById = new Map(localizedPapers.map((paper) => [paper.paperId, paper]));
  const rows = sources.map((source) => {
    const localized = localizedById.get(source.paperId)!;
    return `| [${source.paperId}]${source.year ? ` · ${source.year}년` : ""} | ${localized.headlineKo} |`;
  });
  const details = sources.map((source) => {
    const localized = localizedById.get(source.paperId)!;
    const limitation = source.scopeKo.includes("직접 주제")
      ? "이번 조회에서 확보한 초록만으로는 연구의 모든 세부 조건과 장기 결과를 확인할 수 없습니다."
      : `${source.scopeKo}이므로 질문에 대한 직접 근거로 해석할 수 없습니다.`;
    return [
      `### [${source.paperId}] ${localized.titleKo}`,
      `- **연도·연구 유형:** ${source.year ? `${source.year}년 · ` : ""}${source.designKo}`,
      `- **근거 범위:** ${source.scopeKo}`,
      `- **결과:** ${localized.resultKo}`,
      `- **한계:** ${limitation}`,
      `- [원문 보기](${source.url})`
    ].join("\n");
  });
  const directIndex = sources.findIndex((source) => source.scopeKo.includes("직접 주제"));
  const primaryIndex = directIndex >= 0 ? directIndex : 0;
  const primarySource = sources[primaryIndex]!;
  const primary = localizedById.get(primarySource.paperId)!;
  const contextualCount = sources.filter((source) => !source.scopeKo.includes("직접 주제")).length;
  const followUps = references.slice(0, 2).map((reference, index) =>
    index === 0
      ? `- “${reference.paperId} 논문 자세히 알려줘”`
      : `- “${reference.paperId} 초록 전체를 한국어로 번역해줘”`
  );
  return [
    "## 현재 판단",
    `**한줄 결론:** ${localization.conclusionKo}`,
    "## 상세 답변",
    `가장 직접적인 대표 연구에서는 ${primary.resultKo}`,
    contextualCount > 0
      ? `나머지 ${contextualCount}편은 질문의 대상 또는 결과 한쪽만 다룬 보완 근거이므로, 크레아틴과 탈모를 직접 연결한 증거로 해석하지 않았습니다.`
      : "대표 논문은 질문의 대상과 결과를 직접 다룬 자료입니다.",
    "## 이번 판단에 사용한 근거",
    `초록이 있는 후보 문헌 ${evidence.retrievedPaperCount ?? sources.length}편 가운데 대표 논문 ${sources.length}편을 확인했습니다.`,
    "## 연구 결과 한눈에 보기",
    ["| 연구 | 핵심 결과 |", "| --- | --- |", ...rows].join("\n"),
    `## 대표 논문 ${sources.length}편`,
    details.join("\n\n"),
    "## 연구를 읽을 때",
    "직접 근거와 보완 근거를 구분해 읽어야 합니다. 논문마다 대상과 측정 방법, 추적 기간이 다르며, 이번 답변은 연결된 원문 초록에서 확인할 수 있는 결과까지만 반영했습니다.",
    "## 논문을 더 자세히 보고 싶다면",
    "궁금한 논문 키를 골라 이렇게 물어보세요.",
    ...followUps,
    "해당 논문의 초록 전체 번역, 연구 설계와 대상, 주요 수치, 해석할 때의 한계를 자세히 확인할 수 있습니다."
  ].filter(Boolean).join("\n\n");
}

export function formatPaperDetailForMcp(reference: PaperReferenceRecord): string {
  const { paperId, paper } = reference;
  const authors = paper.authors.filter(Boolean).join(", ");
  return [
    `## [${paperId}] 논문 상세 자료`,
    "현재 Kadera가 확보해 저장한 원문 범위는 논문의 초록 전문입니다. 논문 전체 본문을 확보했다고 말하지 마세요.",
    [
      "사용자에게 반드시 한국어로 다음 순서로 답하세요:",
      "1) '한줄 결론' — 이 논문 한 편이 실제로 말하는 바를 평이하게 설명",
      "2) '초록 전체 번역' — 아래 원문 초록의 모든 문장을 순서대로 빠짐없이 번역하고, BACKGROUND·METHODS·RESULTS·CONCLUSIONS 같은 구획도 한국어로 표시",
      "3) '연구 설계와 대상' — 초록에 적힌 내용만 정리",
      "4) '핵심 결과' — 비교 대상, 방향, 효과크기, 신뢰구간 등 초록에 있는 수치를 그대로 보존",
      "5) '이 논문만으로 말할 수 없는 것' — 초록에서 확인되는 한계와 한 편의 연구를 일반화할 때의 한계를 구분",
      "6) '[원문 보기](URL)' 형식의 클릭 가능한 링크",
      `답변 마지막 줄은 반드시 '[원문 보기](${paper.url})' 링크로 끝내세요. '원문 링크'라는 제목만 쓰고 URL을 생략하지 마세요.`,
      "답변의 논문 제목과 모든 설명은 자연스러운 한국어로 쓰고, 영문 원제와 PubMed·Europe PMC 같은 데이터베이스 이름은 사용자가 요청하지 않는 한 노출하지 마세요. LDL·HbA1c처럼 통용되는 의학 약어와 수치 단위만 원문 표기를 유지하세요. 번역문을 짧은 요약으로 대체하지 말고, 원문에 없는 대상·방법·수치·결론을 추측하지 마세요. 관찰된 연관성을 인과관계로 바꾸지 마세요."
    ].join("\n"),
    "### 서지정보",
    `- 논문 키: [${paperId}]`,
    `- 번역할 영문 제목(최종 답변에는 한국어 제목만 표시): ${paper.title}`,
    ...(authors ? [`- 저자: ${authors}`] : []),
    ...(paper.venue ? [`- 학술지: ${paper.venue}`] : []),
    ...(paper.year ? [`- 연도: ${paper.year}`] : []),
    `- 연구 유형: ${evidenceLevelLabel(paper.evidenceLevel)}`,
    ...(paper.doi ? [`- DOI: ${paper.doi}`] : []),
    `- 원문 보기 링크: ${paper.url}`,
    "### 번역할 원문 초록",
    paper.abstract?.trim() || "이 논문은 저장된 초록을 제공하지 않습니다."
  ].join("\n\n");
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

function hostEvidenceStructuredContent(
  evidence: EvidenceSearchResult,
  references: PaperReferenceRecord[] = []
) {
  const papers = hostEvidencePapers(evidence);
  const retrievedPaperCount = evidence.retrievedPaperCount ?? 0;
  return {
    status: papers.length > 0 ? "ok" : retrievedPaperCount > 0 ? "retrieved_but_filtered" : "no_results",
    response_format: "kadera_local_detailed",
    retrieved_paper_count: retrievedPaperCount,
    usable_paper_count: papers.length,
    glossary: (evidence.glossary ?? []).map((entry) => ({ term: entry.term, asked_as: entry.askedAs })),
    papers: papers.map((paper, index) => ({
      paper_id: references[index]?.paperId,
      title: paper.title,
      year: paper.year,
      evidence_level: paper.evidenceLevel,
      evidence_scope: hostEvidenceScope(paper, evidence),
      abstract_result: sourceResultExcerpt(paper.abstract),
      url: paper.url
    }))
  };
}

function paperDetailStructuredContent(reference: PaperReferenceRecord) {
  const { paperId, paper } = reference;
  return {
    status: "ok",
    paper_id: paperId,
    available_text: "abstract",
    title: paper.title,
    authors: paper.authors,
    venue: paper.venue,
    year: paper.year,
    doi: paper.doi,
    source: paper.source,
    source_id: paper.sourceId,
    evidence_level: paper.evidenceLevel,
    publication_types: paper.publicationTypes,
    abstract_original: paper.abstract,
    url: paper.url
  };
}

function paperReferenceLabel(reference: PaperReferenceRecord | undefined): string {
  return reference ? `[${reference.paperId}] ` : "";
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
  const exactTitleMatched = exactTopicAnchors.length > 0
    ? usableCandidates.filter((paper) => hostTopicAnchorHits({ ...paper, abstract: undefined }, exactTopicAnchors) > 0)
    : usableCandidates;
  const exactResultMatched = exactTopicAnchors.length > 0
    ? usableCandidates.filter((paper) => anchorHitsInText(outcomeEvidenceText(paper), exactTopicAnchors) > 0)
    : usableCandidates;
  const exactFocused = uniqueHostPapers([...exactTitleMatched, ...exactResultMatched]);
  // Broader evidence is intentionally title-anchored. A broad review can
  // mention "saturated fat" in background while studying an unrelated oil;
  // it is useful only when that broader exposure is the paper's real subject.
  const parentTitleMatched = parentAnchors.length > 0
    ? usableCandidates.filter((paper) => hostTopicAnchorHits({ ...paper, abstract: undefined }, parentAnchors) > 0)
    : [];
  const outcomeAnchors = usableAnchors(evidence.hostOutcomeTerms?.map((term) => term.trim()).filter(Boolean) ?? []);
  // Outcome labels are host-written concepts, not guaranteed title phrases.
  // Requiring them verbatim in the title made a carefully-filled call worse
  // than one that omitted outcome_terms: intermittent-fasting searches found
  // dozens of papers, then discarded all of them because papers write "body
  // weight" and "cardiometabolic risk" instead of "weight loss" and
  // "metabolic health". Conversely, searching the whole abstract admits BMI
  // papers for a height question because Methods sections record height to
  // calculate BMI. Match concepts in titles and in result-bearing text only.
  const rank = (papers: Paper[]) => [...papers]
    .sort((left, right) => hostEvidencePaperScore(right, exactTopicAnchors, parentAnchors) - hostEvidencePaperScore(left, exactTopicAnchors, parentAnchors));

  if (outcomeAnchors.length === 0) {
    // With no requested endpoint, a topic-centred paper is the direct answer.
    // Preserve the old label-mismatch fallback so a host-written Korean alias
    // cannot turn a successfully retrieved review into "no research".
    return rank(exactFocused.length > 0 ? exactFocused : usableCandidates).slice(0, 5);
  }

  const outcomeMatches = (paper: Paper) =>
    hostOutcomeAnchorHits(paper.title, outcomeAnchors) > 0 ||
    hostOutcomeAnchorHits(outcomeEvidenceText(paper), outcomeAnchors) > 0;
  const directPapers = rank(exactFocused.filter(outcomeMatches));
  const parentPapers = rank(parentTitleMatched.filter(outcomeMatches));
  const isStrongContextEvidence = (paper: Paper) =>
    paper.evidenceLevel === "systematic_review" ||
    paper.evidenceLevel === "clinical_study" ||
    paper.evidenceLevel === "official_guidance";
  const topicContextPapers = rank(exactTitleMatched.filter((paper) =>
    !directPapers.includes(paper) && isStrongContextEvidence(paper)
  ));
  // Outcome-only context must name the endpoint in the title. Matching a
  // Methods or background sentence would recreate the unrelated-paper bug.
  const outcomeContextPapers = rank(usableCandidates.filter((paper) =>
    !exactFocused.includes(paper) &&
    !parentTitleMatched.includes(paper) &&
    isStrongContextEvidence(paper) &&
    hostOutcomeAnchorHits(paper.title, outcomeAnchors) > 0
  ));

  const selected = uniqueHostPapers([...directPapers, ...parentPapers]);
  if (directPapers.length < 2) {
    const perLaneLimit = directPapers.length === 0 ? 2 : 1;
    const contextLanes = [
      topicContextPapers.slice(0, perLaneLimit),
      outcomeContextPapers.slice(0, perLaneLimit)
    ];
    for (let index = 0; selected.length < 5 && contextLanes.some((lane) => index < lane.length); index += 1) {
      for (const lane of contextLanes) {
        const paper = lane[index];
        if (paper && !selected.includes(paper)) selected.push(paper);
        if (selected.length >= 5) break;
      }
    }
  }
  return uniqueHostPapers(selected).slice(0, 5);
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
  const labelledConclusion = labelledResults ? extractLabelledConclusionSection(clean) : undefined;
  const conclusion = labelledConclusion
    ? splitAbstractSentences(labelledConclusion)
      .map((sentence, index) => ({ sentence, index, score: abstractResultScore(sentence) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.sentence
    : undefined;
  const excerpt = conclusion && conclusion !== selected
    ? `${selected} ${conclusion}`
    : selected;
  return excerpt.length > 700 ? `${excerpt.slice(0, 699).trimEnd()}…` : excerpt;
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

type HostEvidenceScope = "direct" | "parent" | "topic_context" | "outcome_context" | "related";

function hostEvidenceScope(paper: Paper, evidence: EvidenceSearchResult): HostEvidenceScope {
  const topicAnchors = hostTopicTerms(evidence);
  const parentAnchors = hostParentTerms(evidence);
  // With nothing to check the paper against, claiming a scope would be an
  // invention. Only an actual anchor hit may be reported as direct evidence.
  if (topicAnchors.length === 0 && parentAnchors.length === 0) return "direct";
  const titlePaper = { ...paper, abstract: undefined };
  const topicInTitle = hostTopicAnchorHits(titlePaper, topicAnchors) > 0;
  const topicInResult = anchorHitsInText(outcomeEvidenceText(paper), topicAnchors) > 0;
  const outcomeAnchors = usableAnchors(evidence.hostOutcomeTerms?.map((term) => term.trim()).filter(Boolean) ?? []);
  const outcomeMatches = outcomeAnchors.length === 0 ||
    hostOutcomeAnchorHits(paper.title, outcomeAnchors) > 0 ||
    hostOutcomeAnchorHits(outcomeEvidenceText(paper), outcomeAnchors) > 0;
  if ((topicInTitle || topicInResult) && outcomeMatches) return "direct";
  if (hostTopicAnchorHits(titlePaper, parentAnchors) > 0) return "parent";
  if (topicInTitle) return "topic_context";
  if (outcomeAnchors.length > 0 && hostOutcomeAnchorHits(paper.title, outcomeAnchors) > 0) return "outcome_context";
  return "related";
}

function hostEvidenceScopeLabel(scope: HostEvidenceScope): string {
  switch (scope) {
    case "direct": return "직접 주제";
    case "parent": return "상위 주제 보완 근거";
    case "topic_context": return "질문 대상 보완 근거(질문한 결과는 직접 평가하지 않음)";
    case "outcome_context": return "질문 결과 보완 근거(질문 대상은 직접 평가하지 않음)";
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
  },
  {
    recognizes: /\b(?:digestion|digestive function|gastric emptying|dyspepsia|gastro-?oesophageal reflux|gastroesophageal reflux|reflux|gerd)\b/i,
    appearsAs: /\b(?:digestion|digestive function|gastric emptying|dyspepsia|gastro-?oesophageal reflux|gastroesophageal reflux|reflux symptoms?|gerd)\b/i
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

function extractLabelledConclusionSection(text: string): string | undefined {
  const match = text.match(/\bconclusions?\s*:\s*([\s\S]*?)$/i);
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
  if (/^(?:in conclusion|conclusions?)\b/i.test(normalized)) score += 60;
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
  return /\b(?:no (?:significant |clear |consistent )?(?:effect|association|difference|benefit|evidence of)|not (?:significantly )?associated|did not (?:alter|differ|increase|reduce|change|improve)|(?:was|were) identical|confidence intervals? (?:included|crossed)|crossed the null|null (?:effect|result)|inconclusive|uncertain(?:ty)? (?:about|regarding|in) the (?:effect|benefit)|certainty of (?:the )?evidence was (?:very )?low)\b/i.test(sentence);
}

function isAbstractMethodSentence(sentence: string): boolean {
  return (/^(?:we\s+)?(?:conducted|performed|undertook|aimed|sought|evaluated|assessed|investigated|reviewed|summari[sz]ed)\b/i.test(sentence.trim()) ||
    /\b(?:was|were) administered\b/i.test(sentence)) &&
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
