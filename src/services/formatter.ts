import { Memory, SearchResult } from "../types.js";

export function formatMemory(m: Memory): string {
  return [
    `🔑 Key: ${m.key}`,
    `📁 Category: ${m.category}`,
    `⚡ Importance: ${m.importance}`,
    `📝 Content: ${m.content}`,
    m.tags.length > 0 ? `🏷️  Tags: ${m.tags.join(", ")}` : null,
    Object.keys(m.metadata).length > 0
      ? `📎 Metadata: ${Object.entries(m.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}`
      : null,
    `🕐 Created: ${m.created_at}`,
    `🔄 Updated: ${m.updated_at}`,
    `👁️  Accessed: ${m.access_count} time(s)`,
  ].filter(Boolean).join("\n");
}

export function formatSearchResult(r: SearchResult, rank: number): string {
  return [
    `#${rank} [score: ${(r.score * 100).toFixed(0)}%] — ${r.match_reason}`,
    formatMemory(r.memory),
  ].join("\n");
}

export function formatMemoryList(memories: Memory[], total: number, offset: number): string {
  if (memories.length === 0) return "No memories found.";
  const lines = memories.map((m, i) => `${offset + i + 1}. [${m.importance}] ${m.key} (${m.category}): ${m.content.slice(0, 120)}${m.content.length > 120 ? "…" : ""}`);
  const header = `Found ${total} memor${total === 1 ? "y" : "ies"} (showing ${offset + 1}–${offset + memories.length}):`;
  return [header, ...lines].join("\n");
}
