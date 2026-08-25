import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { formatAnswerForText, formatEvidenceDetailsForText } from "./answer.js";
import { loadConfig } from "./config.js";
import { createKaderaMcpServer } from "./mcp.js";
import { createRequestRateLimiter } from "./rateLimit.js";
import { ClaimCheckerService } from "./service.js";
import type { Category } from "./types.js";

const config = loadConfig();
const service = new ClaimCheckerService(config);
const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts: config.mcpAllowedHosts
});
const rateLimit = createRequestRateLimiter({
  maxRequests: config.rateLimitMaxRequests,
  mcpMaxRequests: config.mcpRateLimitMaxRequests,
  windowMs: config.rateLimitWindowMs
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});
app.use(rateLimit);
app.use(
  "/vendor/markdown-it",
  express.static("node_modules/markdown-it/dist", {
    index: false,
    immutable: true,
    maxAge: "7d"
  })
);
app.use(express.static("public"));

/**
 * Whether a deploy actually landed was only observable by probing behaviour
 * and guessing, and one such guess reported a rollout that had not happened.
 * Report the commit instead. Railway and most builders expose it already; the
 * fallbacks cover the platforms that use a different name.
 */
const buildCommit = (process.env.GIT_COMMIT
  ?? process.env.RAILWAY_GIT_COMMIT_SHA
  ?? process.env.SOURCE_COMMIT
  ?? process.env.VERCEL_GIT_COMMIT_SHA
  ?? "unknown").slice(0, 12);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "kadera-malgo", commit: buildCommit });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = readChatMessage(req.body);
    const category = readCategory(req.body?.category);
    const answer = await service.checkClaim({ question: message, category });
    res.json({ mode: "claim", text: formatAnswerForText(answer), answer });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

if (config.exposeDiagnosticApis) {
  app.get("/api/runtime-status", (_req, res) => {
    res.json(service.runtimeStatus());
  });

  app.get("/api/data-sources", (_req, res) => {
    res.json({ sources: service.dataSources() });
  });

  app.post("/api/find-evidence", async (req, res) => {
    try {
      const input = normalizeClaimRequest(req.body);
      const evidence = await service.findEvidence(input);
      res.json(evidence);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
}

app.post("/api/check-claim", async (req, res) => {
  try {
    const input = normalizeClaimRequest(req.body);
    const answer = await service.checkClaim(input);
    res.json(answer);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

if (config.exposeDiagnosticApis) {
  app.post("/api/explain-evidence", async (req, res) => {
    try {
      const input = normalizeClaimRequest(req.body);
      const claimId = readClaimId(req.body);
      const answer = await service.explainEvidence({
        question: input.question,
        category: input.category,
        claimId
      });
      res.json(answer);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/research-claim", async (req, res) => {
    try {
      const input = normalizeClaimRequest(req.body);
      const result = await service.checkClaimWithTrace(input);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/compare-models", async (req, res) => {
    try {
      const input = normalizeClaimRequest(req.body);
      const result = await service.compareClaimModels(input);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
}

app.post("/mcp", async (req, res) => {
  const server = createKaderaMcpServer(service);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST for Streamable HTTP." },
    id: null
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  });
});

const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    console.error("Failed to start server", error);
    process.exit(1);
  }
  console.log(`kadera-malgo MCP server listening on http://localhost:${config.port}/mcp`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  server.close(() => {
    service.close();
    process.exit(0);
  });
}

function normalizeClaimRequest(body: unknown): { question: string; category?: Category; limit?: number; skipCache?: boolean } {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  const input = body as { question?: unknown; category?: unknown; limit?: unknown; skipCache?: unknown };
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question.length < 2) throw new Error("question must be at least 2 characters.");
  if (question.length > config.maxQuestionLength) throw new Error(`question must be at most ${config.maxQuestionLength} characters.`);
  const category = typeof input.category === "string" ? input.category : "auto";
  const limit = Number(input.limit ?? 5);
  return {
    question,
    category: category as Category,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 10)) : 5,
    skipCache: config.allowSkipCache && input.skipCache === true
  };
}

function readClaimId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { claim_id?: unknown; claimId?: unknown }).claim_id ??
    (body as { claim_id?: unknown; claimId?: unknown }).claimId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 80) {
    throw new Error("claim_id must be a non-empty string of at most 80 characters.");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readChatMessage(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("요청 본문이 필요합니다.");
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string") throw new Error("message는 문자열이어야 합니다.");
  const trimmed = message.trim();
  if (trimmed.length < 2 || trimmed.length > config.maxQuestionLength) {
    throw new Error(`message는 2자 이상 ${config.maxQuestionLength}자 이하여야 합니다.`);
  }
  return trimmed;
}

function readCategory(value: unknown): Category {
  const category = typeof value === "string" ? value : "auto";
  return ["auto", "health", "childcare", "education", "exercise", "nutrition", "psychology"].includes(category)
    ? category as Category
    : "auto";
}
