#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { MemoryService } from "./services/memory.service.js";
import { registerTools } from "./tools/memory.tools.js";

const server = new McpServer({
  name: "memory-mcp-server",
  version: "1.0.0",
});

const storePath = process.env.MEMORY_STORE_PATH;
const memoryService = new MemoryService(storePath);
registerTools(server, memoryService);

// ─── Transport ─────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Memory MCP Server running on stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "memory-mcp-server", version: "1.0.0" });
  });

  const port = parseInt(process.env.PORT ?? "3456");
  app.listen(port, () => {
    console.error(`Memory MCP Server running on http://localhost:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch(err => { console.error(err); process.exit(1); });
} else {
  runStdio().catch(err => { console.error(err); process.exit(1); });
}
