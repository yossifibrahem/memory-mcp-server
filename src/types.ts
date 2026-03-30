// ─── Core Types ────────────────────────────────────────────────────────────────

export type ImportanceLevel = "low" | "medium" | "high" | "critical";

export interface Memory {
  id: string;              // UUID
  key: string;             // Human-readable unique key (e.g. "user_name")
  content: string;         // The memory content
  category: string;        // Namespace / category (e.g. "user", "project", "fact")
  tags: string[];          // Searchable tags
  importance: ImportanceLevel;
  created_at: string;      // ISO timestamp
  updated_at: string;      // ISO timestamp
  access_count: number;    // How many times recalled
  last_accessed: string;   // ISO timestamp
  metadata: Record<string, string>; // Optional extra key-value pairs
}

export interface SessionLog {
  session_id: string;    // UUID
  started_at: string;    // ISO timestamp
  memory_count: number;  // Snapshot of total memories at session start
}

export interface MemoryStore {
  version: string;
  memories: Record<string, Memory>; // keyed by memory.key
  sessions: SessionLog[];           // History of session starts (newest last)
  last_saved: string;
}

export interface SessionSummary {
  session_id: string;
  started_at: string;
  total_memories: number;
  sessions_count: number;
  last_session_at: string | null;    // When the previous session started
  critical_memories: Memory[];       // importance === "critical"
  high_memories: Memory[];           // importance === "high"
  recent_memories: Memory[];         // updated in the last 7 days
  by_category: Record<string, Memory[]>; // all memories grouped
  pinned_instructions: Memory[];     // category === "instruction"
}

export interface SearchResult {
  memory: Memory;
  score: number; // Relevance score 0-1
  match_reason: string;
}