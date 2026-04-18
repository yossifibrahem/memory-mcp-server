import { Memory, SearchResult, SessionSummary } from "../types.js";

const BRIEF_MAX_CHARS    = 10_000;
const BRIEF_MAX_PER_CAT  = 20;

export function formatMemory(m: Memory): string {
  const lines = [
    `🔑 Key: ${m.key}`,
    `📁 Category: ${m.category}`,
    `⚡ Importance: ${m.importance}`,
    `📝 Content: ${m.content}`,
    m.tags.length                          && `🏷️  Tags: ${m.tags.join(", ")}`,
    Object.keys(m.metadata).length         && `📎 Metadata: ${Object.entries(m.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `🕐 Created: ${m.created_at}`,
    `🔄 Updated: ${m.updated_at}`,
    `👁️  Accessed: ${m.access_count} time(s)`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatSearchResult(r: SearchResult, rank: number): string {
  return `#${rank} [${(r.score * 100).toFixed(0)}%] ${r.match_reason}\n${formatMemory(r.memory)}`;
}

export function formatMemoryList(memories: Memory[], total: number, offset: number): string {
  if (!memories.length) return "No memories found.";
  const rows = memories.map(
    (m, i) =>
      `${offset + i + 1}. [${m.importance}] ${m.key} (${m.category}): ${m.content.slice(0, 120)}${m.content.length > 120 ? "…" : ""}`,
  );
  return [`Found ${total} memor${total === 1 ? "y" : "ies"} (showing ${offset + 1}–${offset + memories.length}):`, ...rows].join("\n");
}

export function formatSessionSummary(s: SessionSummary): string {
  const lines: string[] = [];
  const bullet = (m: Memory) =>
    `  • [${m.key}] ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`;

  lines.push(`🧠 Memory Brief — Session #${s.sessions_count} (${s.session_id.slice(0, 8)})`);
  lines.push(`📊 ${s.total_memories} memor${s.total_memories === 1 ? "y" : "ies"}${s.last_session_at ? ` | Last session: ${s.last_session_at}` : " | First session"}`);
  lines.push("");

  if (s.total_memories === 0) {
    lines.push("📭 Memory store is empty.");
    return lines.join("\n");
  }

  if (s.pinned_instructions.length) {
    lines.push("📌 INSTRUCTIONS (always apply):");
    s.pinned_instructions.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  if (s.critical_memories.length) {
    lines.push("🔴 CRITICAL:");
    s.critical_memories.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  if (s.high_memories.length) {
    lines.push("🟠 HIGH IMPORTANCE:");
    s.high_memories.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  const categories = Object.entries(s.by_category)
    .filter(([cat]) => cat !== "instruction")
    .sort((a, b) => b[1].length - a[1].length);

  if (categories.length) {
    lines.push("📂 ALL MEMORIES BY CATEGORY:");
    for (const [cat, mems] of categories) {
      lines.push(`  ▸ ${cat} (${mems.length}):`);
      mems.slice(0, BRIEF_MAX_PER_CAT).forEach(m => lines.push(`  ${bullet(m)}`));
      const overflow = mems.length - BRIEF_MAX_PER_CAT;
      if (overflow > 0) lines.push(`    … and ${overflow} more — use memory_list category="${cat}"`);
    }
    lines.push("");
  }

  const shownKeys = new Set([
    ...s.critical_memories,
    ...s.high_memories,
    ...s.pinned_instructions,
  ].map(m => m.key));
  const newRecent = s.recent_memories.filter(m => !shownKeys.has(m.key));
  if (newRecent.length) {
    lines.push(`🕐 RECENTLY UPDATED (last 7 days, ${newRecent.length}):`);
    newRecent.forEach(m => lines.push(bullet(m)));
    lines.push("");
  }

  lines.push("──────────────────────────────────────────");
  lines.push("Use memory_search or memory_recall for full details.");

  const out = lines.join("\n");
  if (out.length <= BRIEF_MAX_CHARS) return out;
  const cut = out.lastIndexOf("\n", BRIEF_MAX_CHARS);
  return out.slice(0, cut) + "\n\n… [brief truncated — use memory_list or memory_search]";
}