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
  → SearchModule checks in-memory cache (keyed by SHA256 of query)
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

PUT /api/reindex/:id (API key guard)
  → fetch single post from WP (post__in: [id])
  → compute embedding → upsert → invalidate cache → 200

DELETE /api/reindex/:id (API key guard)
  → delete from documents (FTS5 triggers clean up) → invalidate cache → 200
```

---

## Database Schema

```sql
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wp_id         INTEGER,
  doc_type      TEXT NOT NULL,       -- 'project' | 'post'
  project_slug  TEXT NOT NULL,
  project_title TEXT,
  project_type  TEXT,                -- 'book' | 'podcast' | 'collection' | 'newsletter' | 'post'
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  permalink     TEXT,
  excerpt       TEXT,
  content       TEXT,
  authors       TEXT,                -- JSON: string[]
  author_bios   TEXT,                -- JSON: string[]
  tags          TEXT,                -- JSON: string[]
  image_url     TEXT,
  indexed_at    TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_documents_wp_id ON documents(wp_id) WHERE wp_id IS NOT NULL;
CREATE INDEX idx_documents_project_slug ON documents(project_slug);

-- FTS5 virtual table (content-backed, kept in sync via triggers)
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
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL
);
CREATE INDEX chunks_doc_idx ON chunks(document_id);

-- Spell/autocomplete vocabulary
CREATE TABLE vocabulary (term TEXT PRIMARY KEY, freq INTEGER);
```

---

## WordPress Data Source

### Projects

Fetched from: `GET https://pabgon18.dream.press/wp-content/uploads/projects.json`

**Filtered out (not indexed):**
- Slugs: `nopublicadas`, `espacio_negativo`, `clima_proceso`
- Project types: `podcast`, `collection`

Each retained project is indexed as a `doc_type='project'` document.

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

Same custom endpoint with `post__in: [id], posts_per_page: 1` in args. Returns 404 if empty.

---

## Indexing Pipeline

### Phase 1 — Content Indexing

1. Fetch and filter projects
2. For each project (max 5 concurrent):
   - Insert project document (`doc_type='project'`)
   - Fetch all posts for that project
   - Insert each post as `doc_type='post'`
3. Build vocabulary from all indexed text

### Phase 2 — Embedding Generation

**Document classification:**
- `content.length < 28,668 chars` → single embedding
  - Input: `concat(title, authors, excerpt, content)`, truncated to 24,000 chars
- `content.length >= 28,668 chars` → chunked
  - Chunks: 1,400 chars, 175-char overlap
  - Each chunk prefixed: `"Título: {title}\nAutores: {authors}\n\n"`

**Batching:** 100 items per OpenAI API call, parallel batch calls.
**Model:** `text-embedding-3-small`
**Storage:** `Float32Array → Buffer → BLOB`

### Status Tracking

In-memory state object (not persisted):
```typescript
{
  state: 'idle' | 'running',
  lastIndexedAt: string | null,
  totalDocs: number,
  progress: { current: number, total: number } | null
}
```

---

## Search Algorithm

```
1. Normalize + hash query → check in-memory cache
2. Cache miss:
   a. Compute query embedding (OpenAI text-embedding-3-small)
   b. FTS5: SELECT rowid, rank FROM documents_fts WHERE documents_fts MATCH ?
   c. For each FTS result:
        - short doc  → cosine(queryEmbedding, embeddings.embedding)
        - chunked doc → max cosine across all chunks
   d. Final score = (normalized bm25) * 0.4 + (cosine similarity) * 0.6
   e. Sort descending, take top N (default 10)
3. Store in cache with 1h TTL
4. Return SearchResult[]
```

**Fallback:** if `embeddings` table is empty, return FTS5-only results.

---

## API Contract

### Authentication

```
Header: X-API-Key: <secret>
```
Applied to: `POST /api/reindex`, `PUT /api/reindex/:id`, `DELETE /api/reindex/:id`
Public: `POST /api/search`, `GET /api/status`

### Endpoints

#### `POST /api/search`
```
Body:    { query: string, limit?: number }  // limit default: 10
Returns: SearchResult[]
Errors:  400 (missing/empty query)
```

#### `GET /api/status`
```
Returns: {
  state: 'idle' | 'running',
  totalDocs: number,
  lastIndexedAt: string | null,
  progress?: { current: number, total: number }
}
```

#### `POST /api/reindex`
```
Returns: 202 { message: 'Reindex started' }
Errors:  401 (invalid API key), 409 (reindex already running)
```

#### `PUT /api/reindex/:id`
```
Returns: 200 { message: 'Document reindexed' }
Errors:  401, 404 (post not found in WP)
```

#### `DELETE /api/reindex/:id`
```
Returns: 200 { message: 'Document deleted' }
Errors:  401, 404 (document not in index)
```

### SearchResult Type

```typescript
type SearchResult = {
  id: number;
  doc_type: 'project' | 'post';
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string;
  excerpt: string;
  authors: string;
  tags: string | null;
  image_url: string | null;
  rank: number;
  snippet_content: string;
  snippet_excerpt: string;
  matchedFields: string[];
  content?: string;
};
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| WP fetch fails for a project during full reindex | Log error, skip project, continue |
| OpenAI API failure | Retry 3x with exponential backoff; if still failing, store document without embedding (FTS-only) |
| Concurrent reindex request | Return 409 Conflict |
| `PUT` post not found in WP | Return 404 |
| Search with empty embeddings table | Fall back to FTS5-only ranking |

---

## Testing Strategy

| Layer | What to test |
|---|---|
| Unit | Cosine similarity + rank merging in `SearchService`; document classification (short vs. chunked) in `IndexService`; `postToDoc` / `projectToDoc` mapping in `WordPressService` |
| Integration | SQLite upsert/delete, FTS5 trigger correctness, cache TTL expiry |
| E2E | One happy-path test per endpoint using seeded test DB; WP and OpenAI HTTP calls mocked at the HTTP client level |

---

## Infrastructure

- **Runtime:** Node.js 20, NestJS
- **Database:** SQLite via `better-sqlite3`
- **Embeddings:** OpenAI `text-embedding-3-small`
- **Deployment:** Docker Compose on Digital Ocean droplet
- **Reverse proxy:** Traefik (SSL termination, routing to `search.elgatoylacaja.com`)
- **DB persistence:** SQLite file mounted as a Docker volume

### Environment Variables

```
WP_BASE_URL=https://pabgon18.dream.press
OPENAI_API_KEY=<secret>
API_KEY=<secret>              # shared secret for reindex endpoints
DB_PATH=/data/search.db       # path inside container
PORT=3000
```
