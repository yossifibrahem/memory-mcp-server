import { Memory, SearchResult, SessionSummary } from "../types.js";

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

function memoryLine(m: Memory): string {
  return `  • [${m.key}] ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`;
}

const BRIEF_MAX_PER_CATEGORY = 20;
const BRIEF_MAX_CHARS = 10_000;

export function formatSessionSummary(s: SessionSummary): string {
  const lines: string[] = [];

  // ── Session header ─────────────────────────────────────────────────────────
  lines.push(`🧠 Memory Brief — Session #${s.sessions_count} (${s.session_id.slice(0, 8)})`);
  lines.push(`📊 ${s.total_memories} memor${s.total_memories === 1 ? "y" : "ies"} stored${s.last_session_at ? ` | Last session: ${s.last_session_at}` : " | First session"}`);
  lines.push("");

  if (s.total_memories === 0) {
    lines.push("📭 Memory store is empty. Nothing to recall yet.");
    return lines.join("\n");
  }

  // ── Pinned instructions ────────────────────────────────────────────────────
  if (s.pinned_instructions.length > 0) {
    lines.push("📌 INSTRUCTIONS (always apply these):");
    s.pinned_instructions.forEach(m => lines.push(memoryLine(m)));
    lines.push("");
  }

  // ── Critical memories ──────────────────────────────────────────────────────
  if (s.critical_memories.length > 0) {
    lines.push("🔴 CRITICAL:");
    s.critical_memories.forEach(m => lines.push(memoryLine(m)));
    lines.push("");
  }

  // ── High importance ────────────────────────────────────────────────────────
  if (s.high_memories.length > 0) {
    lines.push("🟠 HIGH IMPORTANCE:");
    s.high_memories.forEach(m => lines.push(memoryLine(m)));
    lines.push("");
  }

  // ── Category breakdown ─────────────────────────────────────────────────────
  const skipCategories = new Set(["instruction"]);
  const categories = Object.entries(s.by_category)
    .filter(([cat]) => !skipCategories.has(cat))
    .sort((a, b) => b[1].length - a[1].length);

  if (categories.length > 0) {
    lines.push("📂 ALL MEMORIES BY CATEGORY:");
    for (const [cat, memories] of categories) {
      const shown = memories.slice(0, BRIEF_MAX_PER_CATEGORY);
      const overflow = memories.length - shown.length;
      lines.push(`  ▸ ${cat} (${memories.length}):`);
      shown.forEach(m => lines.push(`  ${memoryLine(m)}`));
      if (overflow > 0) {
        lines.push(`    … and ${overflow} more — use memory_list category="${cat}" to see all`);
      }
    }
    lines.push("");
  }

  // ── Recently updated ──────────────────────────────────────────────────────
  const recentKeys = new Set([
    ...s.critical_memories.map(m => m.key),
    ...s.high_memories.map(m => m.key),
    ...s.pinned_instructions.map(m => m.key),
  ]);
  const newRecent = s.recent_memories.filter(m => !recentKeys.has(m.key));
  if (newRecent.length > 0) {
    lines.push(`🕐 RECENTLY UPDATED (last 7 days, ${newRecent.length} item${newRecent.length === 1 ? "" : "s"}):`);
    newRecent.forEach(m => lines.push(memoryLine(m)));
    lines.push("");
  }

  lines.push("──────────────────────────────────────────────────");
  lines.push("Use memory_search or memory_recall for full details.");

  const output = lines.join("\n");
  if (output.length > BRIEF_MAX_CHARS) {
    const truncated = output.slice(0, BRIEF_MAX_CHARS);
    // Cut at a clean line boundary
    const lastNewline = truncated.lastIndexOf("\n");
    return truncated.slice(0, lastNewline) +
      "\n\n… [brief truncated — store is large; use memory_list or memory_search for remaining memories]";
  }
  return output;
}