import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { formatMemory, formatSearchResult, formatMemoryList } from "../services/formatter.js";
import { ImportanceLevel } from "../types.js";

const ImportanceSchema = z.enum(["low", "medium", "high", "critical"]);
const SortBySchema = z.enum(["created_at", "updated_at", "importance", "access_count"]);

export function registerTools(server: McpServer, memory: MemoryService): void {

  // ── memory_save ─────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_save",
    {
      title: "Save Memory",
      description: `Save or update a memory entry. Creates a new memory if the key doesn't exist, or updates the existing one.

Use this to persist any information that should survive across sessions: user preferences, facts, decisions, project context, instructions, relationships, goals, etc.

Args:
  - key (string): Unique identifier for this memory (e.g. "user_name", "project_goal", "api_key_hint"). Use snake_case.
  - content (string): The actual memory content to store.
  - category (string, optional): Namespace for organizing memories (e.g. "user", "project", "fact", "instruction"). Default: "general".
  - tags (string[], optional): Searchable labels (e.g. ["preference", "important"]).
  - importance ("low"|"medium"|"high"|"critical", optional): Priority level. Default: "medium".
  - metadata (object, optional): Extra string key-value pairs attached to this memory.

Returns: Confirmation with the saved memory details and whether it was created or updated.

Examples:
  - "Remember my name is Youssef" → key="user_name", content="Youssef", category="user"
  - "My preferred language is TypeScript" → key="preferred_language", content="TypeScript", category="preference", importance="high"`,
      inputSchema: z.object({
        key: z.string().min(1).max(200).describe("Unique memory key in snake_case (e.g. 'user_name', 'project_deadline')"),
        content: z.string().min(1).max(10000).describe("The memory content to store"),
        category: z.string().min(1).max(100).default("general").describe("Namespace/category for organizing memories"),
        tags: z.array(z.string().max(50)).max(20).default([]).describe("Searchable tags for this memory"),
        importance: ImportanceSchema.default("medium").describe("Priority level: low, medium, high, critical"),
        metadata: z.record(z.string(), z.string()).default({}).describe("Optional extra key-value metadata"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { memory: saved, action } = memory.save({
        key: params.key,
        content: params.content,
        category: params.category,
        tags: params.tags,
        importance: params.importance as ImportanceLevel,
        metadata: params.metadata,
      });

      const text = `✅ Memory ${action}.\n\n${formatMemory(saved)}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { action, memory: saved },
      };
    }
  );

  // ── memory_recall ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_recall",
    {
      title: "Recall Memory",
      description: `Retrieve a specific memory by its exact key.

Use this when you know the exact key of a memory you want to fetch. For fuzzy/keyword search, use memory_search instead.

Args:
  - key (string): The exact memory key to retrieve.

Returns: Full memory details, or a not-found message.`,
      inputSchema: z.object({
        key: z.string().min(1).describe("Exact memory key to retrieve"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const found = memory.get(params.key);
      if (!found) {
        return {
          content: [{ type: "text", text: `❌ No memory found with key: "${params.key}". Use memory_search to find by content or memory_list to browse all.` }],
          structuredContent: { found: false, key: params.key },
        };
      }
      return {
        content: [{ type: "text", text: `✅ Memory recalled.\n\n${formatMemory(found)}` }],
        structuredContent: { found: true, memory: found },
      };
    }
  );

  // ── memory_search ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_search",
    {
      title: "Search Memories",
      description: `Full-text search across all memories. Scores and ranks results by relevance.

Use this to find memories when you don't know the exact key — searches across key names, content, tags, category, and metadata. Results are ranked by relevance score.

Args:
  - query (string): Search query — keywords, phrases, or partial content.
  - category (string, optional): Restrict search to a specific category.
  - tags (string[], optional): Only search memories that have at least one of these tags.
  - limit (number, optional): Max results to return (default: 10, max: 50).

Returns: Ranked list of matching memories with relevance scores and match reasons.`,
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("Search query — keywords, phrases, or partial memory content"),
        category: z.string().optional().describe("Filter by category (optional)"),
        tags: z.array(z.string()).optional().describe("Filter by tags — returns memories with any of these tags"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return (default: 10)"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const results = memory.search({
        query: params.query,
        category: params.category,
        tags: params.tags,
        limit: params.limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `🔍 No memories found matching "${params.query}". Try broader terms or use memory_list to see all memories.` }],
          structuredContent: { query: params.query, count: 0, results: [] },
        };
      }

      const text = [
        `🔍 Found ${results.length} matching memor${results.length === 1 ? "y" : "ies"} for "${params.query}":`,
        "",
        ...results.map((r, i) => formatSearchResult(r, i + 1)),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          query: params.query,
          count: results.length,
          results: results.map(r => ({ ...r.memory, score: r.score, match_reason: r.match_reason })),
        },
      };
    }
  );

  // ── memory_list ─────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_list",
    {
      title: "List Memories",
      description: `Browse all saved memories with optional filters and sorting.

Use this to get an overview of stored memories, browse by category, or paginate through all entries.

Args:
  - category (string, optional): Filter by category.
  - tags (string[], optional): Filter by tags (OR logic — returns memories with any tag).
  - importance ("low"|"medium"|"high"|"critical", optional): Filter by importance level.
  - sort_by ("created_at"|"updated_at"|"importance"|"access_count", optional): Sort field (default: "updated_at").
  - sort_order ("asc"|"desc", optional): Sort direction (default: "desc").
  - limit (number, optional): Page size (default: 50, max: 200).
  - offset (number, optional): Pagination offset (default: 0).

Returns: Paginated list of memories with total count.`,
      inputSchema: z.object({
        category: z.string().optional().describe("Filter by category"),
        tags: z.array(z.string()).optional().describe("Filter by tags (OR match)"),
        importance: ImportanceSchema.optional().describe("Filter by importance level"),
        sort_by: SortBySchema.default("updated_at").describe("Sort field"),
        sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
        limit: z.number().int().min(1).max(200).default(50).describe("Page size"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { memories, total } = memory.list({
        category: params.category,
        tags: params.tags,
        importance: params.importance as ImportanceLevel | undefined,
        sort_by: params.sort_by as "created_at" | "updated_at" | "importance" | "access_count",
        sort_order: params.sort_order as "asc" | "desc",
        limit: params.limit,
        offset: params.offset,
      });

      const text = formatMemoryList(memories, total, params.offset);
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          total,
          count: memories.length,
          offset: params.offset,
          memories,
          has_more: total > params.offset + memories.length,
        },
      };
    }
  );

  // ── memory_delete ───────────────────────────────────────────────────────────

  server.registerTool(
    "memory_delete",
    {
      title: "Delete Memory",
      description: `Permanently delete a memory by its key.

This action is irreversible. Use with care. To delete multiple memories or a whole category, use memory_clear.

Args:
  - key (string): Exact key of the memory to delete.

Returns: Confirmation if deleted, or error if key not found.`,
      inputSchema: z.object({
        key: z.string().min(1).describe("Exact memory key to delete"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const deleted = memory.delete(params.key);
      if (!deleted) {
        return {
          content: [{ type: "text", text: `❌ No memory found with key: "${params.key}". Nothing was deleted.` }],
          structuredContent: { deleted: false, key: params.key },
        };
      }
      return {
        content: [{ type: "text", text: `🗑️ Memory "${params.key}" has been permanently deleted.` }],
        structuredContent: { deleted: true, key: params.key },
      };
    }
  );

  // ── memory_stats ────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_stats",
    {
      title: "Memory Statistics",
      description: `Get an overview of the memory store: total count, breakdown by category and importance, storage path, and last save time.

Use this to audit what's stored, check storage health, or get a quick summary before deciding what to save or clean up.

Args: (none)

Returns: Stats object with totals, breakdowns, and store path.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const stats = memory.stats();
      const categoryLines = Object.entries(stats.by_category)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`).join("\n");

      const text = [
        `📊 Memory Store Statistics`,
        `─────────────────────────`,
        `Total memories: ${stats.total}`,
        ``,
        `By importance:`,
        `  🔴 critical: ${stats.by_importance.critical}`,
        `  🟠 high:     ${stats.by_importance.high}`,
        `  🟡 medium:   ${stats.by_importance.medium}`,
        `  🟢 low:      ${stats.by_importance.low}`,
        ``,
        `By category:`,
        categoryLines || "  (none)",
        ``,
        `Store path:  ${stats.store_path}`,
        `Last saved:  ${stats.last_saved}`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: stats,
      };
    }
  );

  // ── memory_clear ────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_clear",
    {
      title: "Clear Memories",
      description: `Delete multiple memories at once — either all memories in a specific category, or the entire memory store.

⚠️ This is a destructive, irreversible operation. Double-check before using.

Args:
  - category (string, optional): If provided, only memories in this category are deleted. If omitted, ALL memories are cleared.
  - confirm (boolean): Must be set to true to proceed. Acts as a safety guard.

Returns: Count of deleted memories.`,
      inputSchema: z.object({
        category: z.string().optional().describe("Category to clear. Omit to clear ALL memories."),
        confirm: z.literal(true).describe("Must be true to confirm the destructive operation"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const deleted = memory.clear(params.category);
      const scope = params.category ? `category "${params.category}"` : "entire memory store";
      const text = `🗑️ Cleared ${deleted} memor${deleted === 1 ? "y" : "ies"} from ${scope}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { deleted_count: deleted, scope: params.category ?? "all" },
      };
    }
  );
}
