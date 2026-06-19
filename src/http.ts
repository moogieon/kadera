import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { loadConfig } from "./config.js";
import { createKaderaMcpServer } from "./mcp.js";
import { ClaimCheckerService } from "./service.js";
import type { Category } from "./types.js";

const config = loadConfig();
const service = new ClaimCheckerService(config);
const app = createMcpExpressApp();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "kadera-malgo" });
});

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

app.post("/api/check-claim", async (req, res) => {
  try {
    const input = normalizeClaimRequest(req.body);
    const answer = await service.checkClaim(input);
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
  const category = typeof input.category === "string" ? input.category : "auto";
  const limit = Number(input.limit ?? 5);
  return {
    question,
    category: category as Category,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 10)) : 5,
    skipCache: input.skipCache === true
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
