# Bug Fixes and Improvements — Design Spec
**Date:** 2026-03-30
**Project:** eglc-search-backend

---

## Overview

This spec covers 14 bug fixes identified during code review plus three feature improvements: safer OpenAI token batching for Spanish content, HTML stripping from WordPress post content before indexing, and a new `POST /api/reindex/project/:slug` endpoint for partial project reindexing.

---

## 1. Bug Fixes

### 1.1 Search signature mismatch and pagination contract (#1)

**Files:** `src/search/search.service.ts`, `test/search/search.service.spec.ts`, `test/api/app.e2e-spec.ts`

`SearchService.search(query, limit, skip)` is correctly 3-arg. All unit test call sites currently pass only 2 args (`search(query, limit)`), leaving `skip` as `undefined`, which causes `slice(NaN, NaN)` to return an empty array — every test that asserts results is asserting on nothing.

**Fix:**
- Update all unit test call sites to pass `skip` (e.g. `service.search('query', 10, 0)`)
- Update test assertions to unwrap `{ results, total }` shape (e.g. `result.results.length`)
- Fix E2E test: change `expect(Array.isArray(res.body)).toBe(true)` to `expect(Array.isArray(res.body.results)).toBe(true)`
- Add `page` validation in `SearchController`: if `body.page` is provided and is not a positive integer, throw `BadRequestException`

### 1.2 `getSinglePost` missing `post_type` and `posts_per_page` (#2)

**File:** `src/wordpress/wordpress.service.ts`

`getSinglePost` omits `post_type: ['any']` and `posts_per_page: 1` from the WP request. Without `post_type: ['any']`, WordPress restricts results to the default post type and silently returns empty arrays for custom post types, causing spurious 404s on `PUT /api/reindex/:id`.

**Fix:** Add `post_type: ['any'], posts_per_page: 1` to the `args` object in `getSinglePost`.

### 1.3 `postToDoc` crashes on absent `post.metadata` (#3)

**File:** `src/wordpress/wordpress.mappers.ts`

`post.metadata.description` throws `TypeError` if `metadata` is `undefined` or `null`. Real-world WP APIs can return inconsistent data.

**Fix:** Use optional chaining: `post.metadata?.description?.[0]`.

### 1.4 `totalDocs: 0` hardcoded at reindex completion (#4)

**File:** `src/index/index.service.ts`

At the end of `runFullReindex`, `this.status` is set with `totalDocs: 0` hardcoded. `getStatus()` corrects it with a live `COUNT(*)` query, but the snapshot is wrong the moment it's set.

**Fix:** Remove `totalDocs` from the status literal assigned at completion. `getStatus()` already computes it dynamically via `{ ...this.status, totalDocs }`.

### 1.5 `deletePost` three DELETEs not wrapped in a transaction (#5)

**File:** `src/index/index.service.ts`

Three sequential `DELETE` statements in `deletePost` are not wrapped in a transaction. If the second DELETE fails, embeddings are gone but the document row remains, leaving the index in an inconsistent state.

**Fix:** Wrap all three DELETE statements in a single `this.db.db.transaction(() => { ... })()`.

### 1.6 `upsertPost` silent fallback for excluded projects (#6)

**File:** `src/index/index.service.ts`

When no project row exists in the DB (because the project was excluded during full reindex), `upsertPost` fabricates a stub `Project` with `"project-type": "book"` and indexes the post anyway, with no warning.

**Fix:** After `getSinglePost`:
1. If `this.excludedSlugs.has(post.post_type)` → throw `NotFoundException("Post belongs to an excluded project")`
2. Look up `projectRow` in DB. If not found → throw `NotFoundException("Post's project is not indexed")`
3. Proceed with upsert using the real `projectRow` data. Remove the fallback stub entirely.

### 1.7 `console.log` in hot scoring path (#8)

**File:** `src/search/search.service.ts`

A `console.log` inside the scored `.map()` call fires once per FTS result per search query, flooding stdout in production.

**Fix:** Remove the `console.log` statement.

### 1.8 Inconsistent query normalization (#9)

**Files:** `src/search/search.service.ts`, `src/search/cache.service.ts`

Query normalization (trim + lowercase) is applied independently in three places: `CacheService.get/set`, `runFts`, and `embedBatch`. This is fragile across refactors.

**Fix:** Normalize once at the top of `SearchService.search()`:
```typescript
const normalized = query.trim().toLowerCase();
```
Pass `normalized` to `cache.get`, `cache.set`, `runFts`, and `embedBatch`. Remove redundant `.trim().toLowerCase()` calls from `CacheService` internal methods and `runFts`. `CacheService` becomes a pure key→value store with no normalization logic.

### 1.9 Error recovery leaves stale `progress` (#10)

**File:** `src/index/index.service.ts`

The `.catch` in `startFullReindex` resets `state` to `'idle'` on error but does not reset `progress` back to `null`, leaving stale progress data visible via `GET /api/status`.

**Fix:** In the catch handler, fully reset the status object:
```typescript
this.status = { state: 'idle', lastIndexedAt: this.status.lastIndexedAt, totalDocs: 0, progress: null };
```

### 1.10 FTS5 exceptions silently swallowed (#11)

**File:** `src/search/search.service.ts`

The `catch` block in `runFts` returns `[]` without logging, so queries containing FTS5 special characters (`"`, `*`, `(`, `-`) silently return empty results.

**Fix:** Add `this.logger.warn('FTS5 query failed', err)` before returning `[]` in the catch block.

### 1.11 N+1 queries in `getMatchedFields` (#12)

**File:** `src/search/search.service.ts`

`getMatchedFields` executes one SQLite query per FTS5 column (7 columns × N results = up to 70 extra queries per search). The marker columns (`m_title` through `m_project_title`) are already returned by the main `runFts` query.

**Fix:**
- Extend `FtsRow` interface to include the 7 marker columns already selected in `runFts`
- Replace `getMatchedFields` with an inline derivation from those marker columns:
  ```typescript
  const matchedFields = FTS5_FIELDS.filter((_, i) => !!row[`m_${FTS5_FIELDS[i]}`]);
  ```
- Use the `snippet_content` and `snippet_excerpt` columns already in `runFts` (increase their fragment length to 64 tokens to match the spec). Eliminate the separate `getSnippets` DB call entirely.

### 1.12 Empty-content chunked document edge case (#13)

**File:** `src/index/embedding.service.ts`

`buildChunks` with empty/null content emits a single chunk with `text: ""` and `embedText` equal to only the prefix (title + authors). The embedding encodes no actual content.

**Fix:** In `buildChunks`, if `content` is empty and no chunks were produced, use `doc.excerpt ?? ''` as the fallback chunk text instead of `""`:
```typescript
chunks.push({ documentId: ..., index: 0, text: doc.excerpt ?? '', embedText: prefix + (doc.excerpt ?? '') });
```

### 1.13 `getSinglePost` missing language filter (#14)

**File:** `src/wordpress/wordpress.service.ts`

`getSinglePost` does not apply the `meta_query` language filter used by `getPosts`, creating inconsistency between the two fetch paths.

**Fix:** Add the same `meta_query` to `getSinglePost`:
```typescript
meta_query: { relation: 'OR', '0': { key: 'lang', value: 'es', compare: '=' }, '1': { key: 'lang', compare: 'NOT EXISTS' } }
```

### 1.14 No global `ValidationPipe`; `page` unvalidated (#15)

**File:** `src/main.ts`, `src/api/search.controller.ts`

`main.ts` does not register a global `ValidationPipe`. A `page: 0` or `page: -5` produces a zero or negative `skip`, causing unexpected `slice` behavior.

**Fix:**
- Register `app.useGlobalPipes(new ValidationPipe({ whitelist: true }))` in `main.ts`
- Add explicit validation in `SearchController.search`: if `body.page !== undefined && (!Number.isInteger(body.page) || body.page < 1)`, throw `BadRequestException("page must be a positive integer")`

---

## 2. Token Overflow Fix (Batching)

**Files:** `src/index/embedding.service.ts`

### Problem

Spanish text with accented characters tokens at approximately 1 char per 3 tokens, not 1 per 4. The current `estimateTokens = Math.ceil(text.length / 4)` underestimates. A 24,000-char Spanish document ≈ 8,000–9,000 actual tokens, exceeding `text-embedding-3-small`'s 8,191-token per-input limit.

Additionally, `embedSingleDoc` calls `embedBatch` directly, bypassing `buildTokenBatches` and its safety guards entirely.

### Fix

1. **Lower `TRUNCATE_LENGTH`** from `24_000` to `20_000` chars (~6,600 estimated tokens at `chars/3`)
2. **Change `estimateTokens`** to `Math.ceil(text.length / 3)`
3. **Add `MAX_TOKENS_PER_ITEM = 7_500`** constant. In `buildTokenBatches`, before adding a text to the current batch, if `estimateTokens(text) > MAX_TOKENS_PER_ITEM`, truncate it to `MAX_TOKENS_PER_ITEM * 3` chars and log a warning
4. **Route `embedSingleDoc` through `embedAll`** instead of calling `embedBatch` directly, so all token safety guards apply

---

## 3. HTML Stripping

**File:** `src/wordpress/wordpress.mappers.ts`

### Problem

WordPress `content` and `excerpt` fields contain raw HTML (paragraph tags, anchor tags, image tags, inline styles, etc.). This HTML noise degrades both FTS5 match quality and embedding semantic quality.

### Fix

Add a `stripHtml(html: string): string` function in `wordpress.mappers.ts`:

```
1. Strip all HTML tags:           /<[^>]*>/g → ''
2. Decode named entities:         &amp; → & , &lt; → < , &gt; → > , &quot; → " , &apos; → ' , &nbsp; → ' '
3. Decode numeric entities:       &#123; → char, &#x7B; → char
4. Collapse whitespace/newlines:  /\s+/g → ' '
5. Trim
```

Apply `stripHtml` in `postToDoc` to both `content` and `excerpt` before storing. Plain text is stored in SQLite — FTS5 tokenizes cleanly, embeddings encode actual prose.

`projectToDoc` does not need stripping since project descriptions come from a static JSON file and are already plain text.

---

## 4. Project Reindex Endpoint

### 4.1 Existing `upsertPost` guard (see §1.6 above)

Already described. Removes the silent exclusion bypass.

### 4.2 New endpoint: `POST /api/reindex/project/:slug`

**File:** `src/api/reindex.controller.ts`, `src/index/index.service.ts`

**Contract:**
```
POST /api/reindex/project/:slug
Header: X-API-Key: <secret>
Returns: 202 { message: 'Project reindex started' }
Errors:  401 (invalid API key), 409 (reindex already running)
```

No 404 is returned synchronously — slug validation happens inside the background job to maintain the 202-immediately pattern.

**Controller change:** Add `@Post('project/:slug')` handler in `ReindexController` guarded by `ApiKeyGuard`. Calls `indexService.startProjectReindex(slug)`.

**`startProjectReindex(slug: string): void` in `IndexService`:**
- Throws `ConflictException` if `state === 'running'`
- Fires `runProjectReindex(slug)` in background via `.catch` error handler (same pattern as `startFullReindex`)

**`runProjectReindex(slug: string): Promise<void>` in `IndexService`:**
1. Set `state: 'running'`, `progress: { current: 0, total: 0 }`
2. Fetch all projects from WP (`getProjects()`). Find by slug. If not found → log error, reset state, return
3. Check `excludedSlugs.has(project.slug) || excludedTypes.has(project['project-type'])` → log warning, reset state, return
4. In a single transaction:
   - Fetch IDs of all documents where `project_slug = slug`
   - Delete from `embeddings` and `chunks` for those IDs
   - Delete from `documents` where `project_slug = slug` (FTS5 triggers cascade)
5. Insert fresh project document via `insertDoc`
6. Fetch all posts for the project via `getPosts(slug)`. Update `progress.total = posts.length`
7. Insert each post, incrementing `progress.current`
8. Run embedding phase scoped to the new document IDs only (query `SELECT id FROM documents WHERE project_slug = slug` after insert)
9. Clear full cache
10. Reset `state: 'idle'`, `lastIndexedAt: new Date().toISOString()`, `progress: null`

**Error handling:** If any step throws, the `.catch` handler in `startProjectReindex` resets state to idle and logs.

---

## 5. API Contract — `POST /api/search` (Pagination)

The response shape remains `{ results: SearchResult[], total: number }` — a deliberate evolution from the original spec's plain array. This is consistent with the `page` parameter added to the request body.

Request body:
```typescript
{ query: string, limit?: number, page?: number }
// limit: integer, 1–50, default 10
// page: positive integer >= 1, default 1
```

Response:
```typescript
{ results: SearchResult[], total: number }
```

---

## 6. Files Changed Summary

| File | Changes |
|------|---------|
| `src/main.ts` | Register global `ValidationPipe` |
| `src/shared/types.ts` | No changes |
| `src/wordpress/wordpress.service.ts` | Fix `getSinglePost`: add `post_type`, `posts_per_page`, language filter |
| `src/wordpress/wordpress.mappers.ts` | Add `stripHtml`; apply to `postToDoc` content + excerpt; fix `metadata` optional chaining |
| `src/index/embedding.service.ts` | Lower `TRUNCATE_LENGTH`; change token estimate to `/3`; add per-item cap; route `embedSingleDoc` through `embedAll` |
| `src/index/index.service.ts` | Fix `deletePost` transaction; fix `upsertPost` exclusion guard; fix `totalDocs` hardcode; fix error recovery progress reset; add `startProjectReindex` + `runProjectReindex` |
| `src/search/search.service.ts` | Normalize query once; remove `console.log`; inline `matchedFields` from marker cols; eliminate `getSnippets` + `getMatchedFields` separate queries; log FTS5 errors |
| `src/search/cache.service.ts` | Remove normalization logic — becomes a pure key→value store |
| `src/api/search.controller.ts` | Add `page` validation |
| `src/api/reindex.controller.ts` | Add `POST project/:slug` handler |
| `test/search/search.service.spec.ts` | Fix all call sites to 3-arg; unwrap `{ results }` |
| `test/api/app.e2e-spec.ts` | Fix `Array.isArray(res.body)` → `Array.isArray(res.body.results)` |
