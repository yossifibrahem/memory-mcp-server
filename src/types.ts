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

export interface MemoryStore {
  version: string;
  memories: Record<string, Memory>; // keyed by memory.key
  last_saved: string;
}

export interface SearchResult {
  memory: Memory;
  score: number; // Relevance score 0-1
  match_reason: string;
}
