import fs from "fs";
import path from "path";
import { Memory, MemoryStore, SearchResult, ImportanceLevel, SessionLog, SessionSummary } from "../types.js";

const STORE_VERSION = "1.0.0";
const DEFAULT_STORE_PATH = path.join(
  process.env.MEMORY_STORE_PATH || path.join(process.env.HOME || ".", ".memory-mcp"),
  "memories.json"
);

// ─── Persistence ───────────────────────────────────────────────────────────────

function loadStore(storePath: string): MemoryStore {
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<MemoryStore>;
      return {
        version: parsed.version ?? STORE_VERSION,
        memories: parsed.memories ?? {},
        sessions: parsed.sessions ?? [],   // back-compat with old stores
        last_saved: parsed.last_saved ?? new Date().toISOString(),
      };
    }
  } catch {
    // Corrupted store → start fresh
  }
  return { version: STORE_VERSION, memories: {}, sessions: [], last_saved: new Date().toISOString() };
}

function saveStore(store: MemoryStore, storePath: string): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  store.last_saved = new Date().toISOString();
  // Write atomically: write to a temp file then rename so a mid-write crash
  // can never leave a partial/corrupted store file.
  const tmp = storePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, storePath);
}

// ─── MemoryService ─────────────────────────────────────────────────────────────

export class MemoryService {
  private store: MemoryStore;
  private storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath || DEFAULT_STORE_PATH;
    this.store = loadStore(this.storePath);
  }

  // ── Save / Upsert ────────────────────────────────────────────────────────────

  save(params: {
    key: string;
    content?: string;          // optional for updates — omit to keep existing content
    category?: string;
    tags?: string[];
    importance?: ImportanceLevel;
    metadata?: Record<string, string>;
  }): { memory: Memory; action: "created" | "updated" } {
    const now = new Date().toISOString();
    const existing = this.store.memories[params.key];

    if (!existing && !params.content) {
      throw new Error(`content is required when creating a new memory (key "${params.key}" does not exist yet)`);
    }

    const memory: Memory = {
      id: existing?.id ?? crypto.randomUUID(),
      key: params.key,
      content: params.content ?? existing!.content,
      category: params.category ?? existing?.category ?? "general",
      tags: params.tags ?? existing?.tags ?? [],
      importance: params.importance ?? existing?.importance ?? "medium",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      access_count: existing?.access_count ?? 0,
      last_accessed: existing?.last_accessed ?? now,
      metadata: params.metadata ?? existing?.metadata ?? {},
    };

    this.store.memories[params.key] = memory;
    saveStore(this.store, this.storePath);

    return { memory, action: existing ? "updated" : "created" };
  }

  // ── Recall by exact key ──────────────────────────────────────────────────────

  get(key: string): Memory | null {
    const memory = this.store.memories[key] ?? null;
    if (memory) {
      memory.access_count++;
      memory.last_accessed = new Date().toISOString();
      saveStore(this.store, this.storePath);
    }
    return memory;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  delete(key: string): boolean {
    if (!this.store.memories[key]) return false;
    delete this.store.memories[key];
    saveStore(this.store, this.storePath);
    return true;
  }

  // ── List ─────────────────────────────────────────────────────────────────────

  list(params: {
    category?: string;
    tags?: string[];
    importance?: ImportanceLevel;
    limit?: number;
    offset?: number;
    sort_by?: "created_at" | "updated_at" | "importance" | "access_count";
    sort_order?: "asc" | "desc";
  }): { memories: Memory[]; total: number } {
    const importanceRank: Record<ImportanceLevel, number> = {
      low: 1, medium: 2, high: 3, critical: 4,
    };

    let results = Object.values(this.store.memories);

    if (params.category) {
      results = results.filter(m => m.category === params.category);
    }
    if (params.tags && params.tags.length > 0) {
      results = results.filter(m =>
        params.tags!.some(t => m.tags.includes(t))
      );
    }
    if (params.importance) {
      results = results.filter(m => m.importance === params.importance);
    }

    const sortBy = params.sort_by ?? "updated_at";
    const sortOrder = params.sort_order ?? "desc";

    results.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "importance") {
        cmp = importanceRank[a.importance] - importanceRank[b.importance];
      } else if (sortBy === "access_count") {
        cmp = a.access_count - b.access_count;
      } else {
        cmp = a[sortBy].localeCompare(b[sortBy]);
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    const total = results.length;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;

    return { memories: results.slice(offset, offset + limit), total };
  }

  // ── Semantic / keyword search ─────────────────────────────────────────────────

  search(params: {
    query: string;
    category?: string;
    tags?: string[];
    limit?: number;
  }): SearchResult[] {
    const STOP_WORDS = new Set([
      "a","an","the","is","are","was","were","be","been","being",
      "have","has","had","do","does","did","will","would","could","should",
      "may","might","what","where","when","who","how","in","on","at","to",
      "for","of","with","by","from","and","or","but","not","my","your",
      "their","its","this","that","these","those","i","you","he","she","we","they",
    ]);

    const query = params.query.toLowerCase().trim();
    // Filter stop words and single-char tokens so they don't dilute word coverage
    const queryWords = query
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
    const limit = params.limit ?? 10;

    let candidates = Object.values(this.store.memories);
    if (params.category) candidates = candidates.filter(m => m.category === params.category);
    if (params.tags?.length) {
      candidates = candidates.filter(m => params.tags!.some(t => m.tags.includes(t)));
    }

    const scored: SearchResult[] = candidates
      .map(memory => {
        const searchText = [
          memory.key,
          memory.content,
          memory.category,
          ...memory.tags,
          ...Object.values(memory.metadata),
        ].join(" ").toLowerCase();

        let score = 0;
        const reasons: string[] = [];

        // Exact key match → highest weight
        if (memory.key.toLowerCase() === query) {
          score += 1.0;
          reasons.push("exact key match");
        } else if (memory.key.toLowerCase().includes(query)) {
          score += 0.7;
          reasons.push("key contains query");
        }

        // Exact phrase match in content (bonus over individual word hits)
        if (queryWords.length > 1 && memory.content.toLowerCase().includes(query)) {
          score += 0.5;
          reasons.push("exact phrase in content");
        }

        // Word coverage — only meaningful (non-stop) words
        if (queryWords.length > 0) {
          const matchedWords = queryWords.filter(w => searchText.includes(w));
          const wordScore = matchedWords.length / queryWords.length;
          if (wordScore > 0) {
            score += wordScore * 0.6;
            reasons.push(`${matchedWords.length}/${queryWords.length} keywords matched`);
          }
        }

        // Tag match bonus
        const tagHits = memory.tags.filter(t => t.toLowerCase().includes(query) || query.includes(t.toLowerCase()));
        if (tagHits.length > 0) {
          score += 0.3;
          reasons.push(`tag match: ${tagHits.join(", ")}`);
        }

        // Importance boost
        const importanceBoost: Record<ImportanceLevel, number> = {
          low: 0, medium: 0.05, high: 0.1, critical: 0.15,
        };
        score += importanceBoost[memory.importance];

        return { memory, score: Math.min(score, 1), match_reason: reasons.join("; ") };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Increment access counts
    if (scored.length > 0) {
      const now = new Date().toISOString();
      scored.forEach(r => {
        r.memory.access_count++;
        r.memory.last_accessed = now;
      });
      saveStore(this.store, this.storePath);
    }

    return scored;
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  stats(): {
    total: number;
    by_category: Record<string, number>;
    by_importance: Record<ImportanceLevel, number>;
    store_path: string;
    last_saved: string;
  } {
    const memories = Object.values(this.store.memories);
    const by_category: Record<string, number> = {};
    const by_importance: Record<ImportanceLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };

    for (const m of memories) {
      by_category[m.category] = (by_category[m.category] ?? 0) + 1;
      by_importance[m.importance]++;
    }

    return {
      total: memories.length,
      by_category,
      by_importance,
      store_path: this.storePath,
      last_saved: this.store.last_saved,
    };
  }

  // ── Bulk clear (by category or all) ──────────────────────────────────────────

  clear(category?: string): number {
    const before = Object.keys(this.store.memories).length;
    if (category) {
      for (const [key, m] of Object.entries(this.store.memories)) {
        if (m.category === category) delete this.store.memories[key];
      }
    } else {
      this.store.memories = {};
    }
    saveStore(this.store, this.storePath);
    return before - Object.keys(this.store.memories).length;
  }

  // ── Session start ─────────────────────────────────────────────────────────────

  startSession(): SessionSummary {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const allMemories = Object.values(this.store.memories);

    // Record this session
    const log: SessionLog = {
      session_id: sessionId,
      started_at: now,
      memory_count: allMemories.length,
    };
    this.store.sessions.push(log);
    // Keep only the last 100 session logs
    if (this.store.sessions.length > 100) {
      this.store.sessions = this.store.sessions.slice(-100);
    }
    saveStore(this.store, this.storePath);

    // Previous session (second-to-last after we just pushed)
    const prevSession = this.store.sessions.length >= 2
      ? this.store.sessions[this.store.sessions.length - 2]
      : null;

    // 7-day recency window
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Group by category
    const by_category: Record<string, Memory[]> = {};
    for (const m of allMemories) {
      (by_category[m.category] ??= []).push(m);
    }
    // Sort each group: critical first, then by updated_at desc
    const importanceRank: Record<ImportanceLevel, number> = {
      low: 1, medium: 2, high: 3, critical: 4,
    };
    for (const group of Object.values(by_category)) {
      group.sort((a, b) =>
        importanceRank[b.importance] - importanceRank[a.importance] ||
        b.updated_at.localeCompare(a.updated_at)
      );
    }

    return {
      session_id: sessionId,
      started_at: now,
      total_memories: allMemories.length,
      sessions_count: this.store.sessions.length,
      last_session_at: prevSession?.started_at ?? null,
      critical_memories: allMemories.filter(m => m.importance === "critical"),
      high_memories: allMemories.filter(m => m.importance === "high"),
      recent_memories: allMemories.filter(m => m.updated_at >= sevenDaysAgo),
      by_category,
      pinned_instructions: allMemories.filter(m => m.category === "instruction"),
    };
  }
}