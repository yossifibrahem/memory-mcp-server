import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeStopwords } = require("stopword") as { removeStopwords: (words: string[]) => string[] };
import { Memory, MemoryStore, SearchResult, Importance, SessionSummary } from "../types.js";

const VERSION = "1.0.0";
const IMPORTANCE_RANK: Record<Importance, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function defaultStorePath(): string {
  // MEMORY_STORE_PATH is treated as a full file path (not a directory)
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
        version: parsed.version ?? VERSION,
        memories: parsed.memories ?? {},
        sessions: parsed.sessions ?? [],
        last_saved: parsed.last_saved ?? new Date().toISOString(),
      };
    }
  } catch {
    // Corrupted store — start fresh
  }
  return { version: VERSION, memories: {}, sessions: [], last_saved: new Date().toISOString() };
}

function saveStore(store: MemoryStore, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  store.last_saved = new Date().toISOString();
  // Atomic write: write to tmp then rename to prevent corruption on crash
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

// ─── MemoryService ────────────────────────────────────────────────────────────

export class MemoryService {
  private store: MemoryStore;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultStorePath();
    this.store = loadStore(this.filePath);
  }

  private persist() {
    saveStore(this.store, this.filePath);
  }

  // ── Upsert ────────────────────────────────────────────────────────────────

  save(params: {
    key: string;
    content?: string;
    category?: string;
    tags?: string[];
    importance?: Importance;
    metadata?: Record<string, string>;
  }): { memory: Memory; action: "created" | "updated" } {
    const now = new Date().toISOString();
    const existing = this.store.memories[params.key];

    if (!existing && !params.content) {
      throw new Error(`content is required when creating a new memory (key "${params.key}" not found)`);
    }

    const memory: Memory = {
      id:            existing?.id ?? crypto.randomUUID(),
      key:           params.key,
      content:       params.content ?? existing!.content,
      category:      params.category ?? existing?.category ?? "general",
      tags:          params.tags ?? existing?.tags ?? [],
      importance:    params.importance ?? existing?.importance ?? "medium",
      created_at:    existing?.created_at ?? now,
      updated_at:    now,
      access_count:  existing?.access_count ?? 0,
      last_accessed: existing?.last_accessed ?? now,
      metadata:      params.metadata ?? existing?.metadata ?? {},
    };

    this.store.memories[params.key] = memory;
    this.persist();
    return { memory, action: existing ? "updated" : "created" };
  }

  // ── Get by key ────────────────────────────────────────────────────────────
  // access_count is incremented in-memory and will persist on the next write

  get(key: string): Memory | null {
    const m = this.store.memories[key] ?? null;
    if (m) {
      m.access_count++;
      m.last_accessed = new Date().toISOString();
    }
    return m;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  delete(key: string): boolean {
    if (!this.store.memories[key]) return false;
    delete this.store.memories[key];
    this.persist();
    return true;
  }

  // ── List ──────────────────────────────────────────────────────────────────

  list(params: {
    category?: string;
    tags?: string[];
    importance?: Importance;
    limit?: number;
    offset?: number;
    sort_by?: "created_at" | "updated_at" | "importance" | "access_count";
    sort_order?: "asc" | "desc";
  }): { memories: Memory[]; total: number } {
    let results = Object.values(this.store.memories);

    if (params.category)   results = results.filter(m => m.category === params.category);
    if (params.importance) results = results.filter(m => m.importance === params.importance);
    if (params.tags?.length)
      results = results.filter(m => params.tags!.some(t => m.tags.includes(t)));

    const sortBy    = params.sort_by    ?? "updated_at";
    const sortOrder = params.sort_order ?? "desc";
    const dir = sortOrder === "asc" ? 1 : -1;

    results.sort((a, b) => {
      if (sortBy === "importance")    return dir * (IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]);
      if (sortBy === "access_count")  return dir * (a.access_count - b.access_count);
      return dir * a[sortBy].localeCompare(b[sortBy]);
    });

    const total  = results.length;
    const offset = params.offset ?? 0;
    const limit  = params.limit  ?? 50;
    return { memories: results.slice(offset, offset + limit), total };
  }

  // ── Search ────────────────────────────────────────────────────────────────
  // access_count increments in-memory; persisted on next write

  search(params: {
    query: string;
    category?: string;
    tags?: string[];
    limit?: number;
  }): SearchResult[] {
    const query      = params.query.toLowerCase().trim();
    const queryWords = removeStopwords(query.split(/\s+/)).filter(w => w.length > 1);
    const limit      = params.limit ?? 10;

    let candidates = Object.values(this.store.memories);
    if (params.category)   candidates = candidates.filter(m => m.category === params.category);
    if (params.tags?.length)
      candidates = candidates.filter(m => params.tags!.some(t => m.tags.includes(t)));

    const now = new Date().toISOString();

    const results = candidates
      .map((m): SearchResult => {
        const haystack = [m.key, m.content, m.category, ...m.tags, ...Object.values(m.metadata)]
          .join(" ").toLowerCase();

        let score = 0;
        const reasons: string[] = [];

        if (m.key.toLowerCase() === query) {
          score += 1.0; reasons.push("exact key");
        } else if (m.key.toLowerCase().includes(query)) {
          score += 0.7; reasons.push("key match");
        }

        if (queryWords.length > 1 && m.content.toLowerCase().includes(query)) {
          score += 0.5; reasons.push("phrase in content");
        }

        if (queryWords.length > 0) {
          const hits = queryWords.filter(w => haystack.includes(w));
          if (hits.length) {
            score += (hits.length / queryWords.length) * 0.6;
            reasons.push(`${hits.length}/${queryWords.length} keywords`);
          }
        }

        const tagHits = m.tags.filter(t => t.toLowerCase().includes(query) || query.includes(t.toLowerCase()));
        if (tagHits.length) {
          score += 0.3; reasons.push(`tags: ${tagHits.join(", ")}`);
        }

        score += (IMPORTANCE_RANK[m.importance] - 1) * 0.05; // 0–0.15 boost

        return { memory: m, score: Math.min(score, 1), match_reason: reasons.join("; ") };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Bump access counts in-memory (will persist on next write)
    for (const r of results) {
      r.memory.access_count++;
      r.memory.last_accessed = now;
    }

    return results;
  }

  // ── Session start ─────────────────────────────────────────────────────────

  startSession(): SessionSummary {
    const now       = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const all       = Object.values(this.store.memories);

    const prev = this.store.sessions.at(-1) ?? null;

    this.store.sessions.push({ id: sessionId, started_at: now, memory_count: all.length });
    if (this.store.sessions.length > 100) this.store.sessions = this.store.sessions.slice(-100);
    this.persist();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const by_category: Record<string, Memory[]> = {};
    for (const m of all) {
      (by_category[m.category] ??= []).push(m);
    }
    for (const group of Object.values(by_category)) {
      group.sort(
        (a, b) =>
          IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
          b.updated_at.localeCompare(a.updated_at),
      );
    }

    return {
      session_id:           sessionId,
      started_at:           now,
      total_memories:       all.length,
      sessions_count:       this.store.sessions.length,
      last_session_at:      prev?.started_at ?? null,
      critical_memories:    all.filter(m => m.importance === "critical"),
      high_memories:        all.filter(m => m.importance === "high"),
      recent_memories:      all.filter(m => m.updated_at >= sevenDaysAgo),
      by_category,
      pinned_instructions:  all.filter(m => m.category === "instruction"),
    };
  }
}