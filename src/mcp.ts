import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { formatAnswerForText } from "./answer.js";
import type { ClaimCheckerService } from "./service.js";
import { categories } from "./types.js";

export function createKaderaMcpServer(service: ClaimCheckerService): McpServer {
  const server = new McpServer({
    name: "kadera-malgo",
    version: "0.1.0"
  });

  server.registerTool(
    "check_claim",
    {
      title: "카더라 검증",
      description:
        "카더라의 읽기 전용 검증 도구입니다. 한국어 생활 건강/육아/운동/영양/교육/심리 질문을 실제 연구 문헌 검색 결과에 근거해 검증합니다. 없는 논문은 인용하지 않으며 계정/비밀번호/개인정보를 변경하지 않습니다.",
      annotations: {
        title: "카더라 검증",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: {
        question: z.string().min(2).max(350).describe("검증할 한국어 질문 또는 주장. 개인정보, 계정정보, 비밀번호는 넣지 마세요."),
        category: z.enum(categories).optional().default("auto").describe("분야. 모르면 auto"),
        audience: z.string().optional().default("general").describe("답변 대상. 기본값 general"),
        limit: z.number().int().min(1).max(10).optional().default(5).describe("소스별 검색 개수")
      }
    },
    async (input) => {
      const answer = await service.checkClaim(input);
      return {
        content: [{ type: "text", text: formatAnswerForText(answer) }],
        structuredContent: { ...answer }
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
        description: "Gemini RAG 합성 활성 여부와 공개 가능한 보안/캐시 상태를 반환합니다. 로컬 경로나 비밀값은 반환하지 않습니다.",
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
