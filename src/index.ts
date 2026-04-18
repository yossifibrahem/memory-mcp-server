#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { MemoryService } from "./services/memory.service.js";
import { registerTools } from "./tools/memory.tools.js";

const server = new McpServer({ name: "memory-mcp-server", version: "1.0.0" });
const svc    = new MemoryService(process.env.MEMORY_STORE_PATH);
registerTools(server, svc);

async function runStdio() {
  await server.connect(new StdioServerTransport());
  console.error("Memory MCP Server running on stdio");
}

async function runHTTP() {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", version: "1.0.0" }));

  const port = parseInt(process.env.PORT ?? "3456");
  app.listen(port, () => console.error(`Memory MCP Server running on http://localhost:${port}/mcp`));
}

const transport = process.env.TRANSPORT ?? "stdio";
(transport === "http" ? runHTTP() : runStdio()).catch(err => { console.error(err); process.exit(1); });