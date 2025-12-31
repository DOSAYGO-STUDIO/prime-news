# Claude Code Context

## Static News Architecture

Static News is an offline HN archive viewer. Here's the locked-in architecture:

### Schema (Minimal & Working)

```sql
-- Items table (stories, comments, jobs, polls)
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  type TEXT,          -- 'story', 'comment', 'job', 'poll'
  time INTEGER,       -- unix timestamp
  by TEXT,            -- username
  title TEXT,         -- story title (null for comments)
  text TEXT,          -- body text (comments, Ask HN, etc)
  url TEXT,           -- external link (stories only)
  score INTEGER,      -- points
  parent INTEGER      -- parent item ID (comments only)
);

-- Edges table (parent→child relationships)
CREATE TABLE edges (
  parent_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,       -- sibling order (0, 1, 2...)
  child_id INTEGER NOT NULL,
  PRIMARY KEY(parent_id, ord)
);

-- Indexes
CREATE INDEX idx_items_time ON items(time);
CREATE INDEX idx_items_type_time ON items(type, time);
CREATE INDEX idx_items_parent ON items(parent);
CREATE INDEX idx_edges_parent ON edges(parent_id);
```

### Edge Building (Critical!)

Edges are built **from the `parent` field**, not `kids` array (BigQuery doesn't have `kids`).

In `finalizeShardDb()`:
```sql
INSERT INTO edges (parent_id, ord, child_id)
SELECT parent, ROW_NUMBER() OVER (PARTITION BY parent ORDER BY time, id) - 1, id
FROM items
WHERE parent IS NOT NULL AND parent != 0
```

This creates edges in the **same shard as the child item**. Works because:
- Comments are usually close in ID to their parent story
- Both parent and children end up in same/adjacent shards

### Query Pattern for Comment Trees

```javascript
// Find children of a parent
SELECT child_id FROM edges WHERE parent_id=? ORDER BY ord ASC

// Fetch child items (batch by shard)
SELECT * FROM items WHERE id IN (...)
```

### Data Flow

1. `download_hn.sh` → BigQuery export with: `id, title, by, score, time, type, text, url, parent`
2. `etl-hn.js` → Builds shards with items + edges from parent field
3. `static.html` → Client-side SQLite WASM queries

### Key Files

- `docs/static.html` - Main app
- `docs/static-manifest.json` - Shard metadata
- `docs/static-shards/*.sqlite` - Data shards
- `etl-hn.js` - ETL script
- `download_hn.sh` - BigQuery export script

### What NOT to change

- The edges table approach works. Don't switch to querying `parent` column directly.
- Schema is minimal. Don't add `dead`, `deleted`, `channel`, `descendants`.
- Shard size targets in ETL are tuned for balance of load time vs coverage.
