# memory-mcp-server

A persistent memory MCP server for LLMs. Models can save facts, preferences, context, and decisions — and recall them across sessions.

---

## Features

- **Persistent storage** — memories survive between sessions (JSON file, no database required)
- **Full-text search** — keyword search across key, content, tags, category, and metadata
- **Rich metadata** — categories, tags, importance levels, access tracking, timestamps
- **Flexible transport** — stdio (for local tools like Cursor, LM Studio) or HTTP
- **7 tools** covering the full memory lifecycle

---

## Tools

| Tool | Description |
|------|-------------|
| `memory_save` | Save or update a memory by key |
| `memory_recall` | Get a memory by exact key |
| `memory_search` | Full-text search across all memories |
| `memory_list` | Browse memories with filters + pagination |
| `memory_delete` | Delete a single memory |
| `memory_clear` | Bulk-delete by category or wipe all |
| `memory_stats` | Overview of stored memories |

---

## Quick Start

### Build

```bash
npm install
npm run build
```

### Run (stdio — for Cursor, LM Studio, Claude Desktop)

```bash
node dist/index.js
```

### Run (HTTP server)

```bash
TRANSPORT=http PORT=3456 node dist/index.js
```

### Custom store path

```bash
MEMORY_STORE_PATH=/path/to/my-memories.json node dist/index.js
```

Default store path: `~/.memory-mcp/memories.json`

---

## Integration

### Cursor / Claude Desktop (`~/.cursor/mcp.json` or `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-mcp-server/dist/index.js"]
    }
  }
}
```

### LM Studio (MCP config)

```json
{
  "name": "memory",
  "transport": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/memory-mcp-server/dist/index.js"]
}
```

---

## Example Usage

```
# Save a memory
memory_save(key="user_name", content="Youssef", category="user", importance="high")

# Recall it
memory_recall(key="user_name")

# Search by content
memory_search(query="preferred language TypeScript")

# Browse all user preferences
memory_list(category="user", sort_by="importance")

# Delete stale memory
memory_delete(key="old_project_deadline")

# Stats overview
memory_stats()
```

---

## Memory Schema

```typescript
{
  key: string;          // Unique identifier
  content: string;      // The memory content
  category: string;     // Namespace (e.g. "user", "project", "fact")
  tags: string[];       // Searchable labels
  importance: "low" | "medium" | "high" | "critical";
  created_at: string;   // ISO timestamp
  updated_at: string;
  access_count: number; // Times recalled
  last_accessed: string;
  metadata: Record<string, string>; // Extra key-value pairs
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_STORE_PATH` | `~/.memory-mcp/memories.json` | Path to JSON store file |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3456` | HTTP port (only when `TRANSPORT=http`) |
