#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createKaderaMcpServer } from "./mcp.js";
import { ClaimCheckerService } from "./service.js";

const config = loadConfig();
const service = new ClaimCheckerService(config);
const server = createKaderaMcpServer(service);
const transport = new StdioServerTransport();

await server.connect(transport);
console.error("kadera-malgo MCP server running on stdio");

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  service.close();
  process.exit(0);
}
