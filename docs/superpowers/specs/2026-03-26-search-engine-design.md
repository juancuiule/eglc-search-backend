# Search Engine Service — Design Spec
**Date:** 2026-03-26
**Project:** eglc-search-backend
**Deployed at:** search.elgatoylacaja.com

---

## Overview

A NestJS-based parallel search engine for the El Gato y La Caja WordPress site. It indexes projects and their posts/chapters, supports full-text search (SQLite FTS5) combined with semantic search (OpenAI embeddings + cosine similarity), and exposes a REST API consumed by the site frontend and a WordPress plugin.

---

## Architecture

Four NestJS modules with clear boundaries:

```
AppModule
├── WordPressModule   — fetches projects.json + posts via custom WP endpoint
├── IndexModule       — SQLite schema, FTS5, embeddings, background reindex queue
├── SearchModule      — search logic: FTS5 + cosine similarity + in-memory cache
└── ConfigModule      — env vars: WP_BASE_URL, OPENAI_API_KEY, API_KEY, DB_PATH
```

Modules communicate only through their public service interfaces. No cross-module direct database access.

### Request Flow — Search

```
POST /api/search
  → SearchModule checks in-memory cache (keyed by SHA256 of lowercased+trimmed query)
  → cache miss: compute query embedding (OpenAI) + run FTS5 match
  → merge FTS5 bm25 scores + cosine similarity scores
  → store results in cache (TTL 1h) → return SearchResult[]
```

### Request Flow — Reindex

```
POST /api/reindex (API key guard)
  → returns 202 immediately
  → IndexModule background worker runs two phases:
      Phase 1: fetch + insert content
      Phase 2: compute + store embeddings

PUT /api/reindex/:id (API key guard)  -- :id is wp_id
  → fetch single post from WP (post__in: [id])
  → compute embedding → upsert → clear full cache → 200

DELETE /api/reindex/:id (API key guard)  -- :id is wp_id
  → delete from documents (FTS5 triggers clean up) → clear full cache → 200
```

---

## Database Schema

```sql
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wp_id         INTEGER,           -- NULL for projects, always set for posts
  doc_type      TEXT NOT NULL,     -- 'project' | 'post'
  project_slug  TEXT NOT NULL,
  project_title TEXT,
  project_type  TEXT,              -- 'book' | 'podcast' | 'collection' | 'newsletter' | 'post'
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  permalink     TEXT,
  excerpt       TEXT,              -- empty string if not provided by WP
  content       TEXT,
  authors       TEXT,              -- JSON: string[] (display names, joined as comma string in SearchResult)
  author_bios   TEXT,              -- JSON: string[]
  tags          TEXT,              -- JSON: string[] (joined as comma string in SearchResult)
  image_url     TEXT,
  indexed_at    TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_documents_wp_id ON documents(wp_id) WHERE wp_id IS NOT NULL;
CREATE INDEX idx_documents_project_slug ON documents(project_slug);

-- FTS5 virtual table (content-backed, kept in sync via triggers)
-- Uses standard SQLite FTS5 content table pattern.
-- Deletion trigger passes field values alongside 'delete' command as required by FTS5 spec.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, excerpt, content, authors, author_bios, tags, project_title,
  content=documents,
  content_rowid=id,
  tokenize='unicode61'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, excerpt, content, authors, author_bios, tags, project_title)
  VALUES (new.id, new.title, new.excerpt, new.content, new.authors, new.author_bios, new.tags, new.project_title);
END;

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, excerpt, content, authors, author_bios, tags, project_title)
  VALUES ('delete', old.id, old.title, old.excerpt, old.content, old.authors, old.author_bios, old.tags, old.project_title);
END;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, excerpt, content, authors, author_bios, tags, project_title)
  VALUES ('delete', old.id, old.title, old.excerpt, old.content, old.authors, old.author_bios, old.tags, old.project_title);
  INSERT INTO documents_fts(rowid, title, excerpt, content, authors, author_bios, tags, project_title)
  VALUES (new.id, new.title, new.excerpt, new.content, new.authors, new.author_bios, new.tags, new.project_title);
END;

-- Single embedding for short/medium documents
CREATE TABLE embeddings (
  document_id INTEGER PRIMARY KEY,
  embedding   BLOB NOT NULL    -- Float32Array serialized as binary
);

-- Chunked embeddings for long documents (>= ~28,668 chars)
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,    -- raw chunk text (no prefix), for display
  embedding   BLOB NOT NULL
);
CREATE INDEX chunks_doc_idx ON chunks(document_id);

-- Vocabulary for spell/autocomplete (built during Phase 1, reserved for future endpoint)
CREATE TABLE vocabulary (term TEXT PRIMARY KEY, freq INTEGER);
```

**Schema migration:** No migration strategy in scope. A full reindex (`POST /api/reindex`) drops and recreates all tables, so redeployments with schema changes require triggering a full reindex.

---

## WordPress Data Source

### Projects

Fetched from: `GET https://pabgon18.dream.press/wp-content/uploads/projects.json`

**Filtered out by `IndexModule` (hardcoded constants, not by WP endpoint):**
- Slugs: `nopublicadas`, `espacio_negativo`, `clima_proceso`
- Project types: `podcast`, `collection`

Each retained project is indexed as a `doc_type='project'` document. Projects have `wp_id = NULL`.

### Posts per Project

Fetched via custom WP endpoint:
```
POST https://pabgon18.dream.press/wp-json/api/gato_get_posts/
Body: {
  args: JSON.stringify({
    post_type: [projectSlug],
    posts_per_page: -1,
    paged: 1,
    meta_query: {
      relation: 'OR',
      '0': { key: 'lang', value: 'es', compare: '=' },
      '1': { key: 'lang', compare: 'NOT EXISTS' }
    }
  }),
  reduced: false
}
```

Language filter: Spanish (`lang=es`) or unset — excludes non-Spanish content.

### Single Post (for PUT /api/reindex/:id)

Same custom endpoint with `post__in: [id], posts_per_page: 1, post_type: ['any']` in args. If the response array is empty, the caller receives 404.

---

## Indexing Pipeline

### Phase 1 — Content Indexing

1. Fetch and filter projects (filtering applied in `IndexModule`)
2. Drop and recreate all tables (full reindex only; PUT skips this)
3. For each project (max 5 concurrent):
   - Insert project document (`doc_type='project'`, `wp_id=NULL`)
   - Fetch all posts for that project
   - Insert each post as `doc_type='post'` with `wp_id=id_post`
   - `excerpt` defaults to empty string `''` if not provided
4. Build vocabulary from all indexed text (tokenize titles, excerpts, content)

### Phase 2 — Embedding Generation

**Document classification:**
- `totalText.length < 28,668 chars` → single embedding
  - Input: `concat(title, authors, excerpt, content)`, truncated to 24,000 chars if needed
- `totalText.length >= 28,668 chars` → chunked
  - Chunk window: 1,400 chars of raw `content` (overlap: 175 chars)
  - Overlap is calculated on raw content only; prefix is applied after slicing
  - Each chunk embedded as: `"Título: {title}\nAutores: {authors}\n\n{chunkText}"`
  - Last chunk included even if shorter than overlap threshold (no minimum size)

**Batching:** 100 items per OpenAI API call, parallel batch calls.
**Model:** `text-embedding-3-small`
**Storage:** `Float32Array → Buffer → BLOB`
**OpenAI retry:** 3 attempts with backoff: 1s → 2s → 4s. HTTP 429 (rate limit) is treated the same as transient failure and retried with the same backoff. If all retries fail, document is stored without embedding (FTS-only).
**Idempotency:** Phase 2 can be re-run independently without re-fetching content (embeddings table is dropped and rebuilt from existing `documents` rows).

### Status Tracking

In-memory state object (not persisted — resets on restart):
```typescript
{
  state: 'idle' | 'running',
  lastIndexedAt: string | null,   // ISO datetime string
  totalDocs: number,
  progress: { current: number, total: number } | null  // non-null only when state='running'
}
```

---

## Search Algorithm

**Query normalization:** lowercase + trim before hashing and before FTS5 match.

```
1. Normalize query (lowercase + trim) → SHA256 hash → check in-memory cache
2. Cache miss:
   a. Compute query embedding (OpenAI text-embedding-3-small)
   b. FTS5: SELECT rowid, rank FROM documents_fts WHERE documents_fts MATCH ?
      - rank is negative BM25 score (lower = more relevant); normalize to [0, 1]
   c. For each FTS result fetch embedding:
        - short doc  → cosine(queryEmbedding, embeddings.embedding)
        - chunked doc → max cosine score across all its chunks
        - no embedding → cosine score = 0 (FTS-only fallback)
   d. Final score = (normalized_bm25) * 0.4 + (cosine) * 0.6
   e. Sort descending by final score, take top N (default 10, max 50)
   f. Build SearchResult: serialize JSON arrays to comma-joined strings for
      `authors` and `tags` fields; generate snippets via FTS5 snippet() function
      (fragment length: 64 tokens, highlight tags: <mark>/<mark>)
3. Store results in cache with 1h TTL
4. Return SearchResult[]
```

**FTS5 field mismatch note:** FTS5 indexes `author_bios` and `tags` but embeddings are computed from `title + authors + excerpt + content` only. Matches on `author_bios`/`tags` fields will rank via BM25 only (0.4 weight); this is acceptable behavior.

**Fallback:** if `embeddings` table is empty, cosine scores are all 0 — results are ranked by BM25 alone.

---

## API Contract

### Authentication

```
Header: X-API-Key: <secret>
```
Applied to: `POST /api/reindex`, `PUT /api/reindex/:id`, `DELETE /api/reindex/:id`
Public: `POST /api/search`, `GET /api/status`

### Error Response Format

All errors return JSON:
```json
{ "statusCode": number, "message": string }
```

### Endpoints

#### `POST /api/search`
```
Body:    { query: string, limit?: number }
         limit: integer, min 1, max 50, default 10
Returns: SearchResult[]
Errors:  400 (missing/empty query, limit out of range)
```

#### `GET /api/status`
```
Returns: {
  state: 'idle' | 'running',
  totalDocs: number,
  lastIndexedAt: string | null,    // ISO datetime, null if never indexed
  progress?: { current: number, total: number }  // only present when state='running'
}
```

#### `POST /api/reindex`
```
Returns: 202 { message: 'Reindex started' }
Errors:  401 (invalid API key), 409 (reindex already running)
```

#### `PUT /api/reindex/:id`
`:id` is the WordPress post ID (`wp_id`)
```
Returns: 200 { message: 'Document reindexed' }
Errors:  401, 404 (post not found in WP)
```

#### `DELETE /api/reindex/:id`
`:id` is the WordPress post ID (`wp_id`)
```
Returns: 200 { message: 'Document deleted' }
Errors:  401, 404 (document not in index)
```

### SearchResult Type

```typescript
type SearchResult = {
  id: number;                        // internal documents.id
  doc_type: 'project' | 'post';
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string;
  excerpt: string;                   // empty string if not provided by WP
  authors: string;                   // comma-joined from JSON array in DB
  tags: string | null;               // comma-joined from JSON array, null if empty
  image_url: string | null;
  rank: number;                      // final combined score [0, 1]
  snippet_content: string;           // FTS5 snippet() from content field
  snippet_excerpt: string;           // FTS5 snippet() from excerpt field
  matchedFields: string[];           // FTS5 column names that matched the query
  content?: string;                  // omitted unless explicitly requested
};
```

**Serialization note:** `authors` and `tags` are stored as JSON arrays in SQLite but serialized to comma-joined strings in `SearchResult` to match the consumer contract.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| WP fetch fails for a project during full reindex | Log error, skip project, continue with remaining projects |
| OpenAI API failure (any error incl. 429) | Retry 3x: backoff 1s → 2s → 4s; if still failing, store document without embedding (FTS-only searchable) |
| Concurrent reindex request | Return 409 Conflict |
| `PUT` post not found in WP (empty response) | Return 404 |
| `DELETE` wp_id not in index | Return 404 |
| Search with empty embeddings table | Cosine scores = 0; rank by BM25 only |
| SQLite unavailable / locked | NestJS throws 500; service restarts via Docker restart policy |

---

## Testing Strategy

| Layer | What to test |
|---|---|
| Unit | Cosine similarity + rank merging in `SearchService`; document classification (short vs. chunked) in `IndexService`; chunk boundary edge cases (last chunk, content shorter than chunk size); `postToDoc` / `projectToDoc` mapping in `WordPressService`; query normalization + cache key hashing |
| Integration | SQLite upsert/delete, FTS5 trigger correctness (insert/update/delete), cache TTL expiry, `authors`/`tags` JSON→string serialization |
| E2E | One happy-path test per endpoint using seeded test DB; WP and OpenAI HTTP calls mocked at the HTTP client level |

---

## Infrastructure

- **Runtime:** Node.js 20, NestJS
- **Database:** SQLite via `better-sqlite3`
- **Embeddings:** OpenAI `text-embedding-3-small`
- **Deployment:** Docker Compose on Digital Ocean droplet
- **Reverse proxy:** Traefik (SSL termination, routing to `search.elgatoylacaja.com`)
- **DB persistence:** SQLite file mounted as a Docker volume
- **Restart policy:** `restart: unless-stopped` in Docker Compose (handles SQLite crash recovery)

### Environment Variables

```
WP_BASE_URL=https://pabgon18.dream.press
OPENAI_API_KEY=<secret>
API_KEY=<secret>              # shared secret for reindex endpoints
DB_PATH=/data/search.db       # path inside container
PORT=3000
EXCLUDED_SLUGS=nopublicadas,espacio_negativo,clima_proceso   # comma-separated
EXCLUDED_TYPES=podcast,collection                            # comma-separated
```
