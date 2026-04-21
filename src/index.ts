#!/usr/bin/env node
import fs   from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeStopwords } = require("stopword") as { removeStopwords: (words: string[]) => string[] };

// ─── Types ────────────────────────────────────────────────────────────────────

type Importance = "low" | "medium" | "high" | "critical";

interface Memory {
  id: string;
  key: string;
  content: string;
  category: string;
  tags: string[];
  importance: Importance;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string;
  metadata: Record<string, string>;
}

interface MemoryStore {
  version: string;
  memories: Record<string, Memory>;
  sessions: Array<{ id: string; started_at: string; memory_count: number }>;
  last_saved: string;
}

interface SearchResult {
  memory: Memory;
  score: number;
  match_reason: string;
}

interface SessionSummary {
  session_id: string;
  started_at: string;
  total_memories: number;
  sessions_count: number;
  last_session_at: string | null;
  critical_memories: Memory[];
  high_memories: Memory[];
  recent_memories: Memory[];
  by_category: Record<string, Memory[]>;
  pinned_instructions: Memory[];
}

// ─── MemoryService ────────────────────────────────────────────────────────────

const VERSION         = "1.0.0";
const IMPORTANCE_RANK: Record<Importance, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function defaultStorePath(): string {
  return (
    process.env.MEMORY_STORE_PATH ??
    path.join(process.env.HOME ?? ".", ".memory-mcp", "memories.json")
  );
}

function loadStore(filePath: string): MemoryStore {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<MemoryStore>;
      return {
        version:    parsed.version    ?? VERSION,
        memories:   parsed.memories   ?? {},
        sessions:   parsed.sessions   ?? [],
        last_saved: parsed.last_saved ?? new Date().toISOString(),
      };
    }
  } catch { /* corrupted store -- start fresh */ }
  return { version: VERSION, memories: {}, sessions: [], last_saved: new Date().toISOString() };
}

function persistStore(store: MemoryStore, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  store.last_saved = new Date().toISOString();
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

class MemoryService {
  private store: MemoryStore;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultStorePath();
    this.store    = loadStore(this.filePath);
  }

  private persist() { persistStore(this.store, this.filePath); }

  save(params: {
    key: string; content?: string; category?: string;
    tags?: string[]; importance?: Importance; metadata?: Record<string, string>;
  }): { memory: Memory; action: "created" | "updated" } {
    const now      = new Date().toISOString();
    const existing = this.store.memories[params.key];

    if (!existing && !params.content)
      throw new Error(`content is required when creating a new memory (key "${params.key}" not found)`);

    const memory: Memory = {
      id:            existing?.id            ?? crypto.randomUUID(),
      key:           params.key,
      content:       params.content          ?? existing!.content,
      category:      params.category         ?? existing?.category   ?? "general",
      tags:          params.tags             ?? existing?.tags        ?? [],
      importance:    params.importance       ?? existing?.importance  ?? "medium",
      created_at:    existing?.created_at    ?? now,
      updated_at:    now,
      access_count:  existing?.access_count  ?? 0,
      last_accessed: existing?.last_accessed ?? now,
      metadata:      params.metadata         ?? existing?.metadata    ?? {},
    };

    this.store.memories[params.key] = memory;
    this.persist();
    return { memory, action: existing ? "updated" : "created" };
  }

  delete(key: string): boolean {
    if (!this.store.memories[key]) return false;
    delete this.store.memories[key];
    this.persist();
    return true;
  }

  list(params: {
    category?: string; tags?: string[]; importance?: Importance;
    limit?: number; offset?: number;
    sort_by?: "created_at" | "updated_at" | "importance" | "access_count";
    sort_order?: "asc" | "desc";
  }): { memories: Memory[]; total: number } {
    let results = Object.values(this.store.memories);

    if (params.category)     results = results.filter(m => m.category   === params.category);
    if (params.importance)   results = results.filter(m => m.importance === params.importance);
    if (params.tags?.length) results = results.filter(m => params.tags!.some(t => m.tags.includes(t)));

    const sortBy    = params.sort_by    ?? "updated_at";
    const sortOrder = params.sort_order ?? "desc";
    const dir       = sortOrder === "asc" ? 1 : -1;

    results.sort((a, b) => {
      if (sortBy === "importance")   return dir * (IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]);
      if (sortBy === "access_count") return dir * (a.access_count - b.access_count);
      return dir * a[sortBy].localeCompare(b[sortBy]);
    });

    const total  = results.length;
    const offset = params.offset ?? 0;
    const limit  = params.limit  ?? 50;
    return { memories: results.slice(offset, offset + limit), total };
  }

  search(params: { query: string; category?: string; tags?: string[]; limit?: number }): SearchResult[] {
    const query      = params.query.toLowerCase().trim();
    const queryWords = removeStopwords(query.split(/\s+/)).filter((w: string) => w.length > 1);
    const limit      = params.limit ?? 10;

    let candidates = Object.values(this.store.memories);
    if (params.category)     candidates = candidates.filter(m => m.category === params.category);
    if (params.tags?.length) candidates = candidates.filter(m => params.tags!.some(t => m.tags.includes(t)));

    const now = new Date().toISOString();

    const results = candidates
      .map((m): SearchResult => {
        const haystack = [m.key, m.content, m.category, ...m.tags, ...Object.values(m.metadata)]
          .join(" ").toLowerCase();

        let score = 0;
        const reasons: string[] = [];

        if (m.key.toLowerCase() === query)            { score += 1.0; reasons.push("exact key"); }
        else if (m.key.toLowerCase().includes(query)) { score += 0.7; reasons.push("key match"); }

        if (queryWords.length > 1 && m.content.toLowerCase().includes(query))
          { score += 0.5; reasons.push("phrase in content"); }

        if (queryWords.length > 0) {
          const hits = queryWords.filter((w: string) => haystack.includes(w));
          if (hits.length) { score += (hits.length / queryWords.length) * 0.6; reasons.push(`${hits.length}/${queryWords.length} keywords`); }
        }

        const tagHits = m.tags.filter(t => t.toLowerCase().includes(query) || query.includes(t.toLowerCase()));
        if (tagHits.length) { score += 0.3; reasons.push(`tags: ${tagHits.join(", ")}`); }

        score += (IMPORTANCE_RANK[m.importance] - 1) * 0.05;
        return { memory: m, score: Math.min(score, 1), match_reason: reasons.join("; ") };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    for (const r of results) { r.memory.access_count++; r.memory.last_accessed = now; }
    return results;
  }

  startSession(): SessionSummary {
    const now       = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const all       = Object.values(this.store.memories);
    const prev      = this.store.sessions.at(-1) ?? null;

    this.store.sessions.push({ id: sessionId, started_at: now, memory_count: all.length });
    if (this.store.sessions.length > 100) this.store.sessions = this.store.sessions.slice(-100);
    this.persist();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const by_category: Record<string, Memory[]> = {};
    for (const m of all) (by_category[m.category] ??= []).push(m);
    for (const group of Object.values(by_category))
      group.sort((a, b) =>
        IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
        b.updated_at.localeCompare(a.updated_at));

    return {
      session_id:          sessionId,
      started_at:          now,
      total_memories:      all.length,
      sessions_count:      this.store.sessions.length,
      last_session_at:     prev?.started_at ?? null,
      critical_memories:   all.filter(m => m.importance === "critical"),
      high_memories:       all.filter(m => m.importance === "high"),
      recent_memories:     all.filter(m => m.updated_at >= sevenDaysAgo),
      by_category,
      pinned_instructions: all.filter(m => m.category === "instruction"),
    };
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const BRIEF_MAX_CHARS   = 10_000;
const BRIEF_MAX_PER_CAT = 20;

function formatMemory(m: Memory): string {
  const lines = [
    `Key:        ${m.key}`,
    `Category:   ${m.category}`,
    `Importance: ${m.importance}`,
    `Content:    ${m.content}`,
    m.tags.length                  && `Tags:       ${m.tags.join(", ")}`,
    Object.keys(m.metadata).length && `Metadata:   ${Object.entries(m.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Created:    ${m.created_at}`,
    `Updated:    ${m.updated_at}`,
    `Accessed:   ${m.access_count} time(s)`,
  ];
  return lines.filter(Boolean).join("\n");
}

function formatSearchResult(r: SearchResult, rank: number): string {
  return `#${rank} [${(r.score * 100).toFixed(0)}%] ${r.match_reason}\n${formatMemory(r.memory)}`;
}

function formatMemoryList(memories: Memory[], total: number, offset: number): string {
  if (!memories.length) return "No memories found.";
  const rows = memories.map(
    (m, i) =>
      `${offset + i + 1}. [${m.importance}] ${m.key} (${m.category}): ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}`,
  );
  return [
    `Found ${total} memor${total === 1 ? "y" : "ies"} (showing ${offset + 1}-${offset + memories.length}):`,
    ...rows,
  ].join("\n");
}

function formatSessionSummary(s: SessionSummary): string {
  const lines: string[] = [];
  const bullet = (m: Memory) =>
    `  - [${m.key}] ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`;

  lines.push(`Memory Brief -- Session #${s.sessions_count} (${s.session_id.slice(0, 8)})`);
  lines.push(`${s.total_memories} memor${s.total_memories === 1 ? "y" : "ies"}${s.last_session_at ? ` | Last session: ${s.last_session_at}` : " | First session"}`);
  lines.push("");

  if (s.total_memories === 0) {
    lines.push("Memory store is empty.");
    return lines.join("\n");
  }

  if (s.pinned_instructions.length) {
    lines.push("INSTRUCTIONS (always apply):");
    s.pinned_instructions.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  if (s.critical_memories.length) {
    lines.push("CRITICAL:");
    s.critical_memories.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  if (s.high_memories.length) {
    lines.push("HIGH IMPORTANCE:");
    s.high_memories.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  const categories = Object.entries(s.by_category)
    .filter(([cat]) => cat !== "instruction")
    .sort((a, b) => b[1].length - a[1].length);

  if (categories.length) {
    lines.push("ALL MEMORIES BY CATEGORY:");
    for (const [cat, mems] of categories) {
      lines.push(`  ${cat} (${mems.length}):`);
      mems.slice(0, BRIEF_MAX_PER_CAT).forEach(m => lines.push(`  ${bullet(m)}`));
      const overflow = mems.length - BRIEF_MAX_PER_CAT;
      if (overflow > 0) lines.push(`    ... and ${overflow} more -- use memory_read category="${cat}"`);
    }
    lines.push("");
  }

  const shownKeys = new Set([...s.critical_memories, ...s.high_memories, ...s.pinned_instructions].map(m => m.key));
  const newRecent = s.recent_memories.filter(m => !shownKeys.has(m.key));
  if (newRecent.length) {
    lines.push(`RECENTLY UPDATED (last 7 days, ${newRecent.length}):`);
    newRecent.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  lines.push("------------------------------------------");
  lines.push("Use memory_read with a key or query for full details.");

  const out = lines.join("\n");
  if (out.length <= BRIEF_MAX_CHARS) return out;
  const cut = out.lastIndexOf("\n", BRIEF_MAX_CHARS);
  return out.slice(0, cut) + "\n\n... [brief truncated -- use memory_read or memory_read with a query]";
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const ImportanceSchema = z.enum(["low", "medium", "high", "critical"]);
const SortBySchema     = z.enum(["created_at", "updated_at", "importance", "access_count"]);

const keySchema = z
  .string().min(1).max(200)
  .transform(k => k.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""))
  .refine(k => k.length > 0, "Key must contain at least one alphanumeric character");

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function registerTools(server: McpServer, svc: MemoryService): void {

  // ── memory_read ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_read",
    {
      title: "Read Memories",
      description:
        "Read memories in one of two modes based on whether 'query' is provided.\n\n" +
        "NO QUERY -- session init or filtered browse:\n" +
        "  memory_read({})                                         -- call once at conversation start; returns full memory brief grouped by importance/category and logs the session\n" +
        "  memory_read({category: \"user\"})                        -- browse a category\n" +
        "  memory_read({importance: \"critical\", limit: 10})       -- filter by importance\n\n" +
        "WITH QUERY -- full-text search (keys, content, tags, category, metadata); exact key names score highest:\n" +
        "  memory_read({query: \"project deadline\"})\n" +
        "  memory_read({query: \"user_name\"})                      -- exact key lookup\n" +
        "  memory_read({query: \"API auth\", category: \"project\"})\n\n" +
        "Args:\n" +
        "  query      -- search terms (omit to browse/init)\n" +
        "  category   -- filter by namespace\n" +
        "  tags       -- filter by tags (OR match)\n" +
        "  importance -- filter by level: low | medium | high | critical (browse only)\n" +
        "  sort_by    -- created_at | updated_at | importance | access_count (browse only, default: updated_at)\n" +
        "  sort_order -- asc | desc (browse only, default: desc)\n" +
        "  limit      -- page size / max results (default 50)\n" +
        "  offset     -- pagination offset (default 0)",
      inputSchema: z.object({
        query:      z.string().min(1).max(500).optional().describe("Search terms; omit to browse or init session"),
        category:   z.string().optional().describe("Filter by category / namespace"),
        tags:       z.array(z.string()).optional().describe("Filter by tags (OR match)"),
        importance: ImportanceSchema.optional().describe("Filter by importance (browse only)"),
        sort_by:    SortBySchema.default("updated_at").describe("Sort field (browse only)"),
        sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction (browse only)"),
        limit:      z.number().int().min(1).max(200).default(50).describe("Max results / page size"),
        offset:     z.number().int().min(0).default(0).describe("Pagination offset"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (p) => {
      if (p.query) {
        const results = svc.search({ query: p.query, category: p.category, tags: p.tags, limit: Math.min(p.limit, 50) });
        if (!results.length) return {
          ...text(`No memories found for "${p.query}". Try broader terms or call memory_read with no query to browse all.`),
          structuredContent: { mode: "search", query: p.query, count: 0, results: [] },
        };
        const out = [
          `${results.length} result${results.length === 1 ? "" : "s"} for "${p.query}":`,
          "",
          ...results.map((r, i) => formatSearchResult(r, i + 1)),
        ].join("\n");
        return {
          ...text(out),
          structuredContent: {
            mode: "search", query: p.query, count: results.length,
            results: results.map(r => ({ ...r.memory, score: r.score, match_reason: r.match_reason })),
          },
        };
      }

      // No query: session init (no filters) or filtered browse
      const isSessionInit = !p.category && !p.tags?.length && !p.importance && p.offset === 0;
      if (isSessionInit) {
        const summary = svc.startSession();
        return { ...text(formatSessionSummary(summary)), structuredContent: summary as unknown as Record<string, unknown> };
      }

      const { memories, total } = svc.list({
        category:   p.category,
        tags:       p.tags,
        importance: p.importance as Importance | undefined,
        sort_by:    p.sort_by    as "created_at" | "updated_at" | "importance" | "access_count",
        sort_order: p.sort_order as "asc" | "desc",
        limit:      p.limit,
        offset:     p.offset,
      });
      return {
        ...text(formatMemoryList(memories, total, p.offset)),
        structuredContent: { mode: "browse", total, count: memories.length, offset: p.offset, memories, has_more: total > p.offset + memories.length },
      };
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
        "  key        -- unique identifier, auto-normalized to snake_case\n" +
        "  content    -- the memory text (required when creating; omit to keep existing)\n" +
        "  category   -- namespace (e.g. user, project, instruction). Default: general\n" +
        "  tags       -- searchable labels\n" +
        "  importance -- low | medium | high | critical. Default: medium\n" +
        "  metadata   -- extra string key-value pairs\n\n" +
        "Examples:\n" +
        "  memory_save({key: \"user_name\", content: \"Alice\", category: \"user\", importance: \"high\"})\n" +
        "  memory_save({key: \"project_deadline\", content: \"MVP due 2026-06-01\", category: \"project\", tags: [\"deadline\"], importance: \"critical\"})\n" +
        "  memory_save({key: \"user_name\", importance: \"critical\"})  // update only importance; content preserved",
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
      return { ...text(`Memory ${action}.\n\n${formatMemory(saved)}`), structuredContent: { action, memory: saved } };
    },
  );

  // ── memory_delete ─────────────────────────────────────────────────────────

  server.registerTool(
    "memory_delete",
    {
      title: "Delete Memory",
      description:
        "Permanently delete a memory by key. Irreversible.\n\n" +
        "Args:\n" +
        "  key -- exact key to delete\n\n" +
        "Examples:\n" +
        "  memory_delete({key: \"old_api_key\"})       // remove a stale secret\n" +
        "  memory_delete({key: \"temp_draft_notes\"})  // clean up ephemeral entries",
      inputSchema: z.object({
        key: z.string().min(1).describe("Exact memory key to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      const deleted = svc.delete(p.key);
      if (!deleted) return {
        ...text(`No memory found for key "${p.key}". Nothing deleted.`),
        structuredContent: { deleted: false, key: p.key },
      };
      return {
        ...text(`Memory "${p.key}" permanently deleted.`),
        structuredContent: { deleted: true, key: p.key },
      };
    },
  );
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "memory-mcp-server", version: VERSION });
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

  app.get("/health", (_req, res) => res.json({ status: "ok", version: VERSION }));

  const port = parseInt(process.env.PORT ?? "3456");
  app.listen(port, () => console.error(`Memory MCP Server running on http://localhost:${port}/mcp`));
}

const transport = process.env.TRANSPORT ?? "stdio";
(transport === "http" ? runHTTP() : runStdio()).catch(err => { console.error(err); process.exit(1); });