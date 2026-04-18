export type Importance = "low" | "medium" | "high" | "critical";

export interface Memory {
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

export interface MemoryStore {
  version: string;
  memories: Record<string, Memory>;
  /** Newest entry last. Capped at 100. */
  sessions: Array<{ id: string; started_at: string; memory_count: number }>;
  last_saved: string;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  match_reason: string;
}

export interface SessionSummary {
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