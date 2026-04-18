import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { formatMemory, formatSearchResult, formatMemoryList, formatSessionSummary } from "../services/formatter.js";
import { Importance } from "../types.js";

const ImportanceSchema = z.enum(["low", "medium", "high", "critical"]);
const SortBySchema     = z.enum(["created_at", "updated_at", "importance", "access_count"]);

/** Normalize a user-supplied key to snake_case */
const keySchema = z
  .string().min(1).max(200)
  .transform(k => k.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""))
  .refine(k => k.length > 0, "Key must contain at least one alphanumeric character");

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export function registerTools(server: McpServer, svc: MemoryService): void {

  // ── memory_brief ──────────────────────────────────────────────────────────

  server.registerTool(
    "memory_brief",
    {
      title: "Session Start — Memory Brief",
      description:
        "⚡ CALL THIS ONCE AT THE START OF EVERY NEW CONVERSATION.\n\n" +
        "Returns a full memory brief: pinned instructions, critical/high memories, all memories by category, " +
        "and recently updated entries. Logs the session start.\n\n" +
        "Pattern: call → read brief silently → greet the user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const summary = svc.startSession();
      return { ...text(formatSessionSummary(summary)), structuredContent: summary as unknown as Record<string, unknown> };
    },
  );

  // ── memory_save ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_save",
    {
      title: "Save Memory",
      description:
        "Save or update a memory entry by key. Creates if new, updates if exists.\n\n" +
        "Args:\n" +
        "  key        — unique identifier, auto-normalized to snake_case\n" +
        "  content    — the memory text (required when creating; omit to keep existing)\n" +
        "  category   — namespace (e.g. user, project, instruction). Default: general\n" +
        "  tags       — searchable labels\n" +
        "  importance — low | medium | high | critical. Default: medium\n" +
        "  metadata   — extra string key-value pairs",
      inputSchema: z.object({
        key:        keySchema.describe("Unique memory key (auto-normalized to snake_case)"),
        content:    z.string().min(1).max(10_000).optional().describe("Memory content"),
        category:   z.string().min(1).max(100).default("general").describe("Category / namespace"),
        tags:       z.array(z.string().max(50)).max(20).default([]).describe("Searchable tags"),
        importance: ImportanceSchema.default("medium").describe("Priority: low | medium | high | critical"),
        metadata:   z.record(z.string(), z.string()).default({}).describe("Extra key-value metadata"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      const { memory: saved, action } = svc.save({
        key: p.key, content: p.content, category: p.category,
        tags: p.tags, importance: p.importance as Importance, metadata: p.metadata,
      });
      return { ...text(`✅ Memory ${action}.\n\n${formatMemory(saved)}`), structuredContent: { action, memory: saved } };
    },
  );

  // ── memory_recall ─────────────────────────────────────────────────────────

  server.registerTool(
    "memory_recall",
    {
      title: "Recall Memory",
      description:
        "Retrieve a memory by its exact key. Use memory_search for fuzzy/keyword lookup.\n\n" +
        "Args:\n" +
        "  key — exact memory key",
      inputSchema: z.object({
        key: z.string().min(1).describe("Exact memory key"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p) => {
      const m = svc.get(p.key);
      if (!m) return {
        ...text(`❌ No memory found for key "${p.key}". Try memory_search or memory_list.`),
        structuredContent: { found: false, key: p.key },
      };
      return { ...text(`✅ Memory recalled.\n\n${formatMemory(m)}`), structuredContent: { found: true, memory: m } };
    },
  );

  // ── memory_search ─────────────────────────────────────────────────────────

  server.registerTool(
    "memory_search",
    {
      title: "Search Memories",
      description:
        "Full-text search across all memories — keys, content, tags, category, metadata. " +
        "Results are ranked by relevance score.\n\n" +
        "Args:\n" +
        "  query    — keywords or phrase\n" +
        "  category — restrict to a category (optional)\n" +
        "  tags     — restrict to memories with any of these tags (optional)\n" +
        "  limit    — max results (default 10, max 50)",
      inputSchema: z.object({
        query:    z.string().min(1).max(500).describe("Search query"),
        category: z.string().optional().describe("Filter by category"),
        tags:     z.array(z.string()).optional().describe("Filter by tags (OR)"),
        limit:    z.number().int().min(1).max(50).default(10).describe("Max results"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p) => {
      const results = svc.search({ query: p.query, category: p.category, tags: p.tags, limit: p.limit });
      if (!results.length) return {
        ...text(`🔍 No memories found for "${p.query}". Try broader terms or memory_list.`),
        structuredContent: { query: p.query, count: 0, results: [] },
      };
      const out = [
        `🔍 ${results.length} result${results.length === 1 ? "" : "s"} for "${p.query}":`,
        "",
        ...results.map((r, i) => formatSearchResult(r, i + 1)),
      ].join("\n");
      return {
        ...text(out),
        structuredContent: {
          query: p.query,
          count: results.length,
          results: results.map(r => ({ ...r.memory, score: r.score, match_reason: r.match_reason })),
        },
      };
    },
  );

  // ── memory_list ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_list",
    {
      title: "List Memories",
      description:
        "Browse all memories with optional filters and pagination.\n\n" +
        "Args:\n" +
        "  category   — filter by category\n" +
        "  tags       — filter by tags (OR match)\n" +
        "  importance — filter by level\n" +
        "  sort_by    — created_at | updated_at | importance | access_count (default: updated_at)\n" +
        "  sort_order — asc | desc (default: desc)\n" +
        "  limit      — page size (default 50, max 200)\n" +
        "  offset     — pagination offset (default 0)",
      inputSchema: z.object({
        category:   z.string().optional(),
        tags:       z.array(z.string()).optional(),
        importance: ImportanceSchema.optional(),
        sort_by:    SortBySchema.default("updated_at"),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
        limit:      z.number().int().min(1).max(200).default(50),
        offset:     z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      const { memories, total } = svc.list({
        category:   p.category,
        tags:       p.tags,
        importance: p.importance as Importance | undefined,
        sort_by:    p.sort_by as "created_at" | "updated_at" | "importance" | "access_count",
        sort_order: p.sort_order as "asc" | "desc",
        limit:      p.limit,
        offset:     p.offset,
      });
      return {
        ...text(formatMemoryList(memories, total, p.offset)),
        structuredContent: { total, count: memories.length, offset: p.offset, memories, has_more: total > p.offset + memories.length },
      };
    },
  );

  // ── memory_delete ─────────────────────────────────────────────────────────

  server.registerTool(
    "memory_delete",
    {
      title: "Delete Memory",
      description: "Permanently delete a memory by key. Irreversible.\n\nArgs:\n  key — exact key to delete",
      inputSchema: z.object({
        key: z.string().min(1).describe("Exact memory key to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      const deleted = svc.delete(p.key);
      if (!deleted) return {
        ...text(`❌ No memory found for key "${p.key}". Nothing deleted.`),
        structuredContent: { deleted: false, key: p.key },
      };
      return {
        ...text(`🗑️ Memory "${p.key}" permanently deleted.`),
        structuredContent: { deleted: true, key: p.key },
      };
    },
  );
}