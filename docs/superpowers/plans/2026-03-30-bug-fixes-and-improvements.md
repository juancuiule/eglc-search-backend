# Bug Fixes and Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 14 bugs from code review, improve OpenAI token batching for Spanish content, add HTML stripping to improve search quality, and add a `POST /api/reindex/project/:slug` endpoint for partial project reindexing.

**Architecture:** Changes span all layers — WordPress service, mappers, IndexService, EmbeddingService, SearchService, CacheService, and API controllers. The project reindex endpoint requires extracting `CacheService` into its own `CacheModule` to avoid a circular dependency: `SearchModule` imports `IndexModule` (for `EmbeddingService`), so `IndexModule` cannot import `SearchModule` back. `CacheModule` has no dependencies, breaking the cycle cleanly. NestJS's singleton module scope ensures the same `CacheService` instance is shared across `IndexModule` and `SearchModule`.

**Tech Stack:** NestJS 10, TypeScript, SQLite (better-sqlite3), OpenAI SDK v4, Jest, Supertest.

**Spec:** `docs/superpowers/specs/2026-03-30-bug-fixes-and-improvements.md`

---

## File Map

```
Modified:
  src/shared/types.ts                    — make totalDocs optional in IndexStatus
  src/wordpress/wordpress.service.ts     — getSinglePost: add post_type, posts_per_page, language filter
  src/wordpress/wordpress.mappers.ts     — add stripHtml(); apply to postToDoc content+excerpt; fix metadata?.
  src/index/embedding.service.ts         — TRUNCATE_LENGTH 20k, estimateTokens /3, per-item cap, buildChunks fallback
  src/index/index.service.ts             — remove totalDocs literals, deletePost tx, upsertPost guard, error recovery,
                                           embedSingleDoc → embedAll, startProjectReindex, runProjectReindex, inject CacheService
  src/index/index.module.ts              — import CacheModule
  src/search/search.service.ts           — normalize once, remove console.log, extend FtsRow, inline snippets/matchedFields, log FTS5 errors
  src/search/cache.service.ts            — remove normalization (pure key→value store)
  src/api/search.controller.ts           — add page validation
  src/api/reindex.controller.ts          — add POST project/:slug handler
  src/main.ts                            — register global ValidationPipe
  test/wordpress/wordpress.service.spec.ts  — add getSinglePost body assertions
  test/wordpress/wordpress.mappers.spec.ts  — add stripHtml tests, update metadata tests
  test/index/embedding.service.spec.ts   — add TRUNCATE_LENGTH constant test, buildChunks fallback test
  test/index/index.service.spec.ts       — add CacheService mock, upsertPost exclusion tests, deletePost tx test
  test/search/search.service.spec.ts     — fix all search() calls to 3-arg, unwrap { results }
  test/search/cache.service.spec.ts      — remove normalization test, add raw-key test
  test/api/app.e2e-spec.ts               — add ValidationPipe to bootstrap, fix search assertions, add project reindex test

Created:
  src/search/cache.module.ts             — @Module that provides and exports CacheService (shared by IndexModule + SearchModule)
```

---

## Task 1: Fix `getSinglePost`

**Files:**
- Modify: `src/wordpress/wordpress.service.ts`
- Modify: `test/wordpress/wordpress.service.spec.ts`

- [ ] **Step 1: Write a failing test that asserts the request body contains the required fields**

In `test/wordpress/wordpress.service.spec.ts`, add after the existing `getSinglePost` tests:

```typescript
it('getSinglePost sends post_type any, posts_per_page 1, and language filter', async () => {
  let capturedBody: any;
  global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => [] };
  }) as jest.Mock;

  await service.getSinglePost(99);

  const args = JSON.parse(capturedBody.args);
  expect(args.post_type).toEqual(['any']);
  expect(args.posts_per_page).toBe(1);
  expect(args.meta_query).toBeDefined();
  expect(args.meta_query['0'].key).toBe('lang');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npm test -- --testPathPattern=wordpress.service.spec
```

Expected: FAIL — `args.post_type` is undefined.

- [ ] **Step 3: Fix `getSinglePost` in `src/wordpress/wordpress.service.ts`**

Replace the entire `getSinglePost` method:

```typescript
async getSinglePost(wpId: number): Promise<WPPost | null> {
  const res = await fetch(`${this.baseUrl}/wp-json/api/gato_get_posts/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: JSON.stringify({
        post_type: ['any'],
        posts_per_page: 1,
        paged: 1,
        post__in: [wpId],
        meta_query: {
          relation: 'OR',
          '0': { key: 'lang', value: 'es', compare: '=' },
          '1': { key: 'lang', compare: 'NOT EXISTS' },
        },
      }),
      reduced: false,
    }),
  });
  if (!res.ok) throw new Error(`Failed to fetch post ${wpId}: ${res.status}`);
  const data = await res.json();
  const posts: WPPost[] = Array.isArray(data) ? data : [];
  return posts[0] ?? null;
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- --testPathPattern=wordpress.service.spec
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wordpress/wordpress.service.ts test/wordpress/wordpress.service.spec.ts
git commit -m "fix: getSinglePost — add post_type any, posts_per_page 1, language filter"
```

---

## Task 2: HTML Stripping + `postToDoc` metadata fix

**Files:**
- Modify: `src/wordpress/wordpress.mappers.ts`
- Modify: `test/wordpress/wordpress.mappers.spec.ts`

- [ ] **Step 1: Write failing tests for `stripHtml` and the metadata crash**

In `test/wordpress/wordpress.mappers.spec.ts`, change the import at the top to include `stripHtml`:

```typescript
import { postToDoc, projectToDoc, stripHtml } from '../../src/wordpress/wordpress.mappers';
```

Add at the bottom of the file:

```typescript
describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
  });

  it('decodes named entities', () => {
    // &nbsp; becomes a non-breaking space which is whitespace → collapses to ' ', then trim removes it
    expect(stripHtml('&amp;')).toBe('&');
    expect(stripHtml('&lt;')).toBe('<');
    expect(stripHtml('&gt;')).toBe('>');
    expect(stripHtml('&quot;')).toBe('"');
    expect(stripHtml("&apos;")).toBe("'");
    expect(stripHtml('hello&nbsp;world')).toBe('hello world');
  });

  it('decodes numeric entities', () => {
    expect(stripHtml('&#65;')).toBe('A');
    expect(stripHtml('&#x41;')).toBe('A');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('hello   world\n\ntest')).toBe('hello world test');
  });

  it('returns empty string for null input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('strips HTML from content field in postToDoc', () => {
    const post = { ...mockPost, content: '<p>Contenido <strong>del</strong> capítulo</p>' };
    const doc = postToDoc(post, mockProject);
    expect(doc.content).toBe('Contenido del capítulo');
  });
});

describe('postToDoc metadata safety', () => {
  it('does not crash when metadata is absent and excerpt is empty', () => {
    const post = { ...mockPost, excerpt: '', metadata: undefined } as unknown as WPPost;
    expect(() => postToDoc(post, mockProject)).not.toThrow();
    expect(postToDoc(post, mockProject).excerpt).toBe('');
  });

  it('uses metadata.description[0] as excerpt fallback when excerpt is empty', () => {
    const post = {
      ...mockPost,
      excerpt: '',
      metadata: { description: ['Meta desc'], link: [], project: [] },
    } as WPPost;
    expect(postToDoc(post, mockProject).excerpt).toBe('Meta desc');
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
npm test -- --testPathPattern=wordpress.mappers.spec
```

Expected: FAIL — `stripHtml` is not exported.

- [ ] **Step 3: Implement `stripHtml` and update `postToDoc` in `src/wordpress/wordpress.mappers.ts`**

Replace the entire file:

```typescript
import { DocumentRow, Project, WPPost } from '../shared/types';

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function projectToDoc(project: Project): DocumentRow {
  return {
    wp_id: null,
    doc_type: 'project',
    project_slug: project.slug,
    project_title: project.title,
    project_type: project['project-type'],
    title: project.title,
    slug: project['project-slug'] ?? project.slug,
    permalink: null,
    excerpt: project['description-short'] ?? '',
    content: project['description-long'] ?? null,
    authors: JSON.stringify([project.author].filter(Boolean)),
    author_bios: JSON.stringify([]),
    tags: JSON.stringify(project.tags ?? []),
    image_url: project['og-image'] ?? project['project-product-image'] ?? null,
  };
}

export function postToDoc(post: WPPost, project: Project): DocumentRow {
  const rawExcerpt =
    post.excerpt && post.excerpt.length > 0
      ? post.excerpt
      : post.metadata?.description?.[0] ?? '';

  return {
    wp_id: post.id_post,
    doc_type: 'post',
    project_slug: project.slug,
    project_title: project.title,
    project_type: project['project-type'],
    title: post.title,
    slug: post.slug,
    permalink: post.permalink ?? null,
    excerpt: stripHtml(rawExcerpt),
    content: stripHtml(post.content),
    authors: JSON.stringify(post.credits?.autores?.map((a) => a.name) ?? []),
    author_bios: JSON.stringify(post.credits?.autores?.map((a) => a.description) ?? []),
    tags:
      post.tags === false
        ? JSON.stringify([])
        : JSON.stringify(post.tags?.map((t) => t.name) ?? []),
    image_url: post.image ? post.image[0] : null,
  };
}
```

**Note on `&nbsp;`:** `\u00a0` (non-breaking space) is matched by `\s` in V8/Node.js, so the subsequent `.replace(/\s+/g, ' ')` collapses it to a regular space. The `hello&nbsp;world` test correctly expects `'hello world'`.

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- --testPathPattern=wordpress.mappers.spec
```

Expected: all PASS. Note: the existing test `'defaults excerpt to empty string when missing'` (which spreads `mockPost` without `metadata`) now exercises the `metadata?.description?.[0]` optional chaining — ensure it still passes (it will, because it expects `''`).

- [ ] **Step 5: Commit**

```bash
git add src/wordpress/wordpress.mappers.ts test/wordpress/wordpress.mappers.spec.ts
git commit -m "feat: add stripHtml, apply to postToDoc content/excerpt, fix metadata optional chaining"
```

---

## Task 3: CacheService — remove normalization

**Files:**
- Modify: `src/search/cache.service.ts`
- Modify: `test/search/cache.service.spec.ts`

**Context:** After this task, `CacheService.get/set` hash their input string as-is (no trim/lowercase). Callers must pass an already-normalized string. The existing test `'normalizes query — same key for different casing/whitespace'` tests behavior we are removing — replace it.

- [ ] **Step 1: Update the cache test to match new behavior**

In `test/search/cache.service.spec.ts`, replace the normalization test:

```typescript
// Remove:
// it('normalizes query — same key for different casing/whitespace', () => { ... });

// Add:
it('uses the key as-is — no normalization, caller must normalize', () => {
  cache.set('hello world', [{ id: 1 }] as any);
  expect(cache.get('hello world')).toBeDefined();
  // different casing is a cache miss — caller is responsible
  expect(cache.get('Hello World')).toBeUndefined();
  expect(cache.get('  hello world  ')).toBeUndefined();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npm test -- --testPathPattern=cache.service.spec
```

Expected: FAIL — cache still normalizes, so `'Hello World'` incorrectly hits.

- [ ] **Step 3: Remove normalization from `src/search/cache.service.ts`**

Replace the file:

```typescript
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { SearchResult } from '../shared/types';

const TTL_MS = 60 * 60 * 1_000; // 1 hour

interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
}

@Injectable()
export class CacheService {
  private readonly store = new Map<string, CacheEntry>();

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  get(key: string): SearchResult[] | undefined {
    const h = this.hash(key);
    const entry = this.store.get(h);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(h);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[]): void {
    const h = this.hash(key);
    this.store.set(h, { results, expiresAt: Date.now() + TTL_MS });
  }

  clear(): void {
    this.store.clear();
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- --testPathPattern=cache.service.spec
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/cache.service.ts test/search/cache.service.spec.ts
git commit -m "refactor: CacheService — remove normalization, callers pass normalized key"
```

---

## Task 4: SearchService fixes

**Files:**
- Modify: `src/search/search.service.ts`
- Modify: `test/search/search.service.spec.ts`

**Context:** (1) Normalize query once at top of `search()`, pass `normalized` everywhere; (2) remove `console.log`; (3) extend `FtsRow` with all marker/snippet columns already in the SELECT; (4) bump snippet fragment to 64 tokens; (5) delete `getSnippets` and `getMatchedFields` methods — derive both inline in `scored.map()`; (6) log FTS5 errors before returning `[]`.

- [ ] **Step 1: Update `test/search/search.service.spec.ts` — fix all call sites and assertions**

Replace the entire test file:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { SearchService } from '../../src/search/search.service';
import { DatabaseService } from '../../src/database/database.service';
import { EmbeddingService } from '../../src/index/embedding.service';
import { CacheService } from '../../src/search/cache.service';

describe('SearchService', () => {
  let service: SearchService;
  let db: DatabaseService;

  const mockEmbeddingService = {
    embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    db = new DatabaseService(':memory:');
    db.onModuleInit();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        SearchService,
        CacheService,
        { provide: DatabaseService, useValue: db },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
      ],
    }).compile();

    service = module.get(SearchService);
  });

  afterEach(() => {
    db.onModuleDestroy();
    jest.clearAllMocks();
  });

  it('returns empty results when no documents are indexed', async () => {
    const result = await service.search('anything', 10, 0);
    expect(result).toEqual({ results: [], total: 0 });
  });

  it('returns FTS5 results for matching query', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, project_title, project_type, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Project', 'book', 'El gato mágico', 'el-gato', '[]', '[]', '[]', 'Extracto', 'Contenido sobre gatos')
    `).run();

    const result = await service.search('gato', 10, 0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].title).toBe('El gato mágico');
    expect(result.total).toBeGreaterThan(0);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      db.db.prepare(`
        INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
        VALUES ('post', 'proj', 'Test doc ${i}', 'slug-${i}', '[]', '[]', '[]', 'test content', 'test content common')
      `).run();
    }

    const result = await service.search('test', 2, 0);
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.total).toBeGreaterThan(0);
  });

  it('skip offsets results correctly', async () => {
    for (let i = 0; i < 3; i++) {
      db.db.prepare(`
        INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
        VALUES ('post', 'proj', 'Page doc ${i}', 'slug-p${i}', '[]', '[]', '[]', 'paging text', 'paging text common')
      `).run();
    }

    const page1 = await service.search('paging', 2, 0);
    const page2 = await service.search('paging', 2, 2);
    expect(page1.results.length).toBe(2);
    expect(page2.results.length).toBeGreaterThanOrEqual(1);
    const ids1 = page1.results.map((r) => r.id);
    const ids2 = page2.results.map((r) => r.id);
    expect(ids1.every((id) => !ids2.includes(id))).toBe(true);
  });

  it('serializes authors JSON array to comma-joined string', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Libro', 'libro', '["Ana García","Pedro López"]', '[]', '[]', 'libro texto', 'libro texto')
    `).run();

    const result = await service.search('libro', 10, 0);
    expect(result.results[0]?.authors).toBe('Ana García,Pedro López');
  });

  it('returns null for tags when tags array is empty', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Notag', 'notag', '[]', '[]', '[]', 'notag text', 'notag text')
    `).run();

    const result = await service.search('notag', 10, 0);
    expect(result.results[0]?.tags).toBeNull();
  });

  it('uses cache on second call with same query', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'cached query result', 'cached', '[]', '[]', '[]', 'cached query', 'cached query text')
    `).run();

    await service.search('cached', 10, 0);
    await service.search('cached', 10, 0);
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalledTimes(1);
  });

  it('normalizes query before caching — UPPERCASE hits same cache entry', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'normalización test', 'norm', '[]', '[]', '[]', 'normalizacion', 'normalizacion texto')
    `).run();

    await service.search('normalizacion', 10, 0);
    await service.search('NORMALIZACION', 10, 0);
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test -- --testPathPattern=search.service.spec
```

Expected: multiple FAILs — old shape returned, normalization test fails, skip test fails.

- [ ] **Step 3: Rewrite `src/search/search.service.ts`**

Replace the entire file:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  EmbeddingService,
  bufferToFloat32,
  cosineSimilarity,
} from '../index/embedding.service';
import { SearchResult } from '../shared/types';
import { CacheService } from './cache.service';

const FTS5_FIELDS = [
  'title',
  'excerpt',
  'content',
  'authors',
  'author_bios',
  'tags',
  'project_title',
];

interface FtsRow {
  id: number;
  rank: number;
  doc_type: string;
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string;
  excerpt: string;
  authors: string;
  tags: string;
  image_url: string | null;
  content: string | null;
  // snippet columns (fragment length 64 — matches spec)
  snippet_content: string;
  snippet_excerpt: string;
  // matched-field markers: non-empty string means the field matched the query
  m_title: string;
  m_excerpt: string;
  m_content: string;
  m_authors: string;
  m_author_bios: string;
  m_tags: string;
  m_project_title: string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingService: EmbeddingService,
    private readonly cache: CacheService,
  ) {}

  async search(
    query: string,
    limit: number,
    skip: number,
  ): Promise<{ results: SearchResult[]; total: number }> {
    // Normalize once — all downstream calls receive `normalized`
    const normalized = query.trim().toLowerCase();

    const cached = this.cache.get(normalized);
    if (cached) {
      return { results: cached.slice(skip, skip + limit), total: cached.length };
    }

    // 1. FTS5 match — early return if no results
    const ftsRows = this.runFts(normalized);
    if (ftsRows.length === 0) {
      this.cache.set(normalized, []);
      return { results: [], total: 0 };
    }

    // 2. Compute query embedding (only when FTS has results)
    let queryEmbedding: Float32Array | null = null;
    try {
      const [vec] = await this.embeddingService.embedBatch([normalized]);
      queryEmbedding = new Float32Array(vec);
    } catch {
      this.logger.warn('Query embedding failed — using FTS5-only ranking');
    }

    // 3. Normalize BM25 scores (rank is negative; lower = more relevant)
    const ranks = ftsRows.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const rankRange = maxRank - minRank || 1;

    // 4. Score each result
    const scored = ftsRows
      .map((row) => {
        const bm25Norm = 1 - (row.rank - minRank) / rankRange;
        const cosine = queryEmbedding
          ? this.cosineForDoc(row.id, queryEmbedding)
          : 0;
        const finalScore = bm25Norm * 0.4 + cosine * 0.6;
        return { row, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    // 5. Build SearchResult[] — snippets and matchedFields come directly from runFts columns
    //    (no extra DB queries: getSnippets and getMatchedFields are eliminated)
    const results: SearchResult[] = scored.map(({ row, finalScore }) => {
      const authorArr: string[] = safeJsonArray(row.authors);
      const tagArr: string[] = safeJsonArray(row.tags);
      const matchedFields = FTS5_FIELDS.filter((f) => !!(row as any)[`m_${f}`]);

      return {
        id: row.id,
        doc_type: row.doc_type as 'project' | 'post',
        project_slug: row.project_slug,
        project_title: row.project_title ?? '',
        project_type: row.project_type ?? '',
        title: row.title,
        slug: row.slug,
        permalink: row.permalink ?? '',
        excerpt: row.excerpt ?? '',
        authors: authorArr.join(','),
        tags: tagArr.length > 0 ? tagArr.join(',') : null,
        image_url: row.image_url,
        rank: finalScore,
        snippet_content: row.snippet_content ?? '',
        snippet_excerpt: row.snippet_excerpt ?? '',
        matchedFields,
      };
    });

    this.cache.set(normalized, results);
    return { results: results.slice(skip, skip + limit), total: results.length };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private runFts(normalized: string): FtsRow[] {
    try {
      return this.db.db
        .prepare(
          `
          SELECT
            d.id, d.doc_type, d.project_slug, d.project_title, d.project_type,
            d.title, d.slug, d.permalink, d.excerpt, d.authors,
            d.tags, d.image_url,
            bm25(documents_fts, 50, 8, 1, 4, 0.5, 6, 3) as rank,
            snippet(documents_fts, 2, '<mark>', '</mark>', '…', 64) as snippet_content,
            snippet(documents_fts, 1, '<mark>', '</mark>', '…', 64) as snippet_excerpt,
            snippet(documents_fts, 0, '<mark>', '</mark>', '', 1)    as m_title,
            snippet(documents_fts, 1, '<mark>', '</mark>', '', 1)    as m_excerpt,
            snippet(documents_fts, 2, '<mark>', '</mark>', '', 1)    as m_content,
            snippet(documents_fts, 3, '<mark>', '</mark>', '', 1)    as m_authors,
            snippet(documents_fts, 4, '<mark>', '</mark>', '', 1)    as m_author_bios,
            snippet(documents_fts, 5, '<mark>', '</mark>', '', 1)    as m_tags,
            snippet(documents_fts, 6, '<mark>', '</mark>', '', 1)    as m_project_title
          FROM documents_fts
          JOIN documents d ON d.id = documents_fts.rowid
          WHERE documents_fts MATCH ?
          ORDER BY rank
        `,
        )
        .all(normalized) as FtsRow[];
    } catch (err) {
      this.logger.warn('FTS5 query failed', err);
      return [];
    }
  }

  private cosineForDoc(docId: number, queryEmbedding: Float32Array): number {
    const embRow = this.db.db
      .prepare('SELECT embedding FROM embeddings WHERE document_id = ?')
      .get(docId) as { embedding: Buffer } | undefined;

    if (embRow) {
      return cosineSimilarity(queryEmbedding, bufferToFloat32(embRow.embedding));
    }

    const chunkRows = this.db.db
      .prepare('SELECT embedding FROM chunks WHERE document_id = ?')
      .all(docId) as { embedding: Buffer }[];

    if (chunkRows.length === 0) return 0;

    return Math.max(
      ...chunkRows.map((c) =>
        cosineSimilarity(queryEmbedding, bufferToFloat32(c.embedding)),
      ),
    );
  }
}

function safeJsonArray(json: string): string[] {
  try {
    const val = JSON.parse(json);
    return Array.isArray(val) ? val : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- --testPathPattern=search.service.spec
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/search.service.ts test/search/search.service.spec.ts
git commit -m "fix: SearchService — normalize once, inline snippets/matchedFields, remove N+1 queries and console.log"
```

---

## Task 5: IndexService bug fixes

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/index/index.service.ts`
- Modify: `test/index/index.service.spec.ts`

**Context:** Five fixes in this task: (1) make `totalDocs` optional in `IndexStatus` so `this.status` literals don't need to include it; (2) fix error recovery to reset `progress: null`; (3) wrap `deletePost` DELETEs in a transaction; (4) replace `upsertPost` silent fallback with exclusion guard; (5) route `embedSingleDoc` through `embedAll` instead of `embedBatch` so token safety guards apply.

- [ ] **Step 1: Add tests for the new/fixed behaviors**

In `test/index/index.service.spec.ts`, add to the existing `describe('IndexService')` block:

```typescript
it('upsertPost throws 404 when post_type is in excludedSlugs', async () => {
  mockWpService.getSinglePost.mockResolvedValue({
    id_post: 1, title: 'T', slug: 's', post_type: 'nopublicadas',
    excerpt: '', content: '', permalink: '', image: null,
    credits: { autores: [] }, tags: [],
  });
  await expect(service.upsertPost(1)).rejects.toThrow('excluded');
});

it('upsertPost throws 404 when project row is not in the index', async () => {
  mockWpService.getSinglePost.mockResolvedValue({
    id_post: 2, title: 'T', slug: 's', post_type: 'unknown-project',
    excerpt: '', content: '', permalink: '', image: null,
    credits: { autores: [] }, tags: [],
  });
  await expect(service.upsertPost(2)).rejects.toThrow();
});

it('deletePost removes embeddings and document atomically', () => {
  const { lastInsertRowid: docId } = db.db.prepare(
    `INSERT INTO documents (wp_id, doc_type, project_slug, title, slug, authors, author_bios, tags)
     VALUES (88, 'post', 'proj', 'T', 's', '[]', '[]', '[]')`
  ).run();

  db.db.prepare(
    `INSERT INTO embeddings (document_id, embedding) VALUES (?, ?)`
  ).run(docId, Buffer.alloc(4));

  service.deletePost(88);

  expect(db.db.prepare('SELECT * FROM documents WHERE wp_id = 88').get()).toBeUndefined();
  expect(db.db.prepare(`SELECT * FROM embeddings WHERE document_id = ${docId}`).get()).toBeUndefined();
});
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
npm test -- --testPathPattern=index.service.spec
```

Expected: `upsertPost excluded` and `upsertPost unknown project` tests fail (currently uses the fallback stub, no throw).

- [ ] **Step 3: Make `totalDocs` optional in `src/shared/types.ts`**

In `src/shared/types.ts`, change line 86:

```typescript
// Before:
totalDocs: number;

// After:
totalDocs?: number;
```

This makes `this.status` literals valid without `totalDocs`. `getStatus()` always adds the live count via `{ ...this.status, totalDocs }`, so the public API shape is unchanged.

- [ ] **Step 4: Apply all five fixes to `src/index/index.service.ts`**

**Fix 1 — Remove `totalDocs` from constructor's initial status:**
```typescript
private status: IndexStatus = {
  state: 'idle',
  lastIndexedAt: null,
  progress: null,
};
```

**Fix 2 — Remove `totalDocs` from `runFullReindex` completion block** (currently around line 129):
```typescript
this.status = {
  state: 'idle',
  lastIndexedAt: new Date().toISOString(),
  progress: null,
};
```

**Fix 3 — Error recovery: fix the `.catch` handler in `startFullReindex`:**
```typescript
this.runFullReindex().catch((err) => {
  this.logger.error('Full reindex failed', err);
  this.status = {
    state: 'idle',
    lastIndexedAt: this.status.lastIndexedAt,
    progress: null,
  };
});
```

**Fix 4 — `deletePost` transaction.** Replace the entire `deletePost` method:
```typescript
deletePost(wpId: number): void {
  const row = this.db.db
    .prepare('SELECT id FROM documents WHERE wp_id = ?')
    .get(wpId);
  if (!row) throw new NotFoundException(`Document with wp_id ${wpId} not in index`);

  this.db.db.transaction(() => {
    this.db.db
      .prepare('DELETE FROM embeddings WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)')
      .run(wpId);
    this.db.db
      .prepare('DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)')
      .run(wpId);
    this.db.db.prepare('DELETE FROM documents WHERE wp_id = ?').run(wpId);
  })();
}
```

**Fix 5 — `upsertPost` exclusion guard.** Replace the entire `upsertPost` method with:
```typescript
async upsertPost(wpId: number): Promise<void> {
  const post = await this.wp.getSinglePost(wpId);
  if (!post) throw new NotFoundException(`Post ${wpId} not found in WordPress`);

  // post.post_type holds the project slug in this WP endpoint response (not the standard WP post type)
  if (this.excludedSlugs.has(post.post_type)) {
    throw new NotFoundException(`Post belongs to an excluded project: ${post.post_type}`);
  }

  const projectRow = this.db.db
    .prepare(
      'SELECT project_slug, project_title, project_type FROM documents WHERE doc_type = ? AND project_slug = ?',
    )
    .get('project', post.post_type) as
    | { project_slug: string; project_title: string; project_type: string }
    | undefined;

  if (!projectRow) {
    throw new NotFoundException(`Post's project is not indexed: ${post.post_type}`);
  }

  const project: Project = {
    slug: projectRow.project_slug,
    title: projectRow.project_title ?? post.post_type,
    'project-type': projectRow.project_type as Project['project-type'],
    author: '',
    tags: [],
    'project-slug': projectRow.project_slug,
    'description-short': '',
    'description-long': '',
  };

  const doc = postToDoc(post, project);

  this.db.db
    .prepare(
      `INSERT INTO documents
         (wp_id, doc_type, project_slug, project_title, project_type, title, slug,
          permalink, excerpt, content, authors, author_bios, tags, image_url)
       VALUES
         (@wp_id, @doc_type, @project_slug, @project_title, @project_type, @title,
          @slug, @permalink, @excerpt, @content, @authors, @author_bios, @tags, @image_url)
       ON CONFLICT(wp_id) WHERE wp_id IS NOT NULL DO UPDATE SET
         title=excluded.title, slug=excluded.slug, permalink=excluded.permalink,
         excerpt=excluded.excerpt, content=excluded.content, authors=excluded.authors,
         author_bios=excluded.author_bios, tags=excluded.tags, image_url=excluded.image_url,
         indexed_at=datetime('now')`,
    )
    .run(doc);

  const row = this.db.db
    .prepare('SELECT id, title, authors, excerpt, content FROM documents WHERE wp_id = ?')
    .get(wpId) as
    | { id: number; title: string; authors: string; excerpt: string; content: string }
    | undefined;

  if (row) await this.embedSingleDoc(row);
}
```

**Fix 6 — Route `embedSingleDoc` through `embedAll`** (both the `single` and `chunked` branches). Find `embedSingleDoc` and replace both `embedBatch` calls with `embedAll`:

For the `single` branch (around the line that calls `embedBatch([text])`):
```typescript
// Before:
const vectors = await this.embeddings.embedBatch([text]);
const vector = vectors[0];

// After:
const vectors = await this.embeddings.embedAll([text]);
const vector = vectors[0];
```

For the `chunked` branch (around the line that calls `embedBatch(chunks.map(...))`):
```typescript
// Before:
const vectors = await this.embeddings.embedBatch(chunks.map((c) => c.embedText));

// After:
const vectors = await this.embeddings.embedAll(chunks.map((c) => c.embedText));
```

- [ ] **Step 5: Run tests and confirm they pass**

```bash
npm test -- --testPathPattern=index.service.spec
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/index/index.service.ts test/index/index.service.spec.ts
git commit -m "fix: IndexService — totalDocs optional, deletePost tx, upsertPost exclusion guard, error recovery, embedSingleDoc via embedAll"
```

---

## Task 6: Token overflow — EmbeddingService constants and batching

**Files:**
- Modify: `src/index/embedding.service.ts`
- Modify: `test/index/embedding.service.spec.ts`

**Context:** Three changes in `embedding.service.ts`: (1) lower `TRUNCATE_LENGTH` to 20,000; (2) change `estimateTokens` to `chars/3`; (3) add `MAX_TOKENS_PER_ITEM` constant with per-item truncation in `buildTokenBatches` (truncation is silent — `buildTokenBatches` is a module-level function with no logger access); (4) fix `buildChunks` empty-content fallback to use `excerpt`. The `embedSingleDoc` routing to `embedAll` was already done in Task 5.

- [ ] **Step 1: Add tests**

In `test/index/embedding.service.spec.ts`, add a new import for `TRUNCATE_LENGTH` (it should already be imported — check the import line and add if missing), then add new describe blocks:

```typescript
describe('TRUNCATE_LENGTH', () => {
  it('is 20000', () => {
    expect(TRUNCATE_LENGTH).toBe(20_000);
  });
});

describe('buildChunks — empty content fallback', () => {
  it('uses excerpt as fallback text when content is empty', () => {
    const doc = {
      title: 'T',
      authors: 'A',
      content: '',
      excerpt: 'Este es el extracto del documento',
    };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('Este es el extracto del documento');
    expect(chunks[0].embedText).toContain('Este es el extracto del documento');
  });

  it('returns single chunk with empty text when both content and excerpt are absent', () => {
    const doc = { title: 'T', authors: 'A', content: null };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --testPathPattern=embedding.service.spec
```

Expected: `TRUNCATE_LENGTH is 20000` fails (currently 24000), `uses excerpt as fallback` fails.

- [ ] **Step 3: Apply changes to `src/index/embedding.service.ts`**

**Change 1 — Constants:**
```typescript
export const CHUNK_THRESHOLD = 28_668;
export const TRUNCATE_LENGTH = 20_000;   // lowered from 24_000 — Spanish text tokens at ~1/3 chars
export const CHUNK_SIZE = 1_400;
export const CHUNK_OVERLAP = 175;

const EMBED_MODEL = 'text-embedding-3-small';
const MAX_TOKENS_PER_BATCH = 8_000;
const MAX_TOKENS_PER_ITEM = 7_500;       // hard cap per single input text
const CONCURRENCY = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
```

**Change 2 — `estimateTokens`:**
```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);   // conservative for Spanish Unicode (was / 4)
}
```

**Change 3 — `buildTokenBatches` with per-item cap (silent truncation):**
```typescript
function buildTokenBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;

  for (let text of texts) {
    // Per-item hard cap: truncate silently if individual text exceeds limit
    if (estimateTokens(text) > MAX_TOKENS_PER_ITEM) {
      text = text.slice(0, MAX_TOKENS_PER_ITEM * 3);
    }

    const t = estimateTokens(text);

    if (tokens + t > MAX_TOKENS_PER_BATCH && current.length > 0) {
      batches.push(current);
      current = [];
      tokens = 0;
    }

    current.push(text);
    tokens += t;
  }

  if (current.length) batches.push(current);

  return batches;
}
```

**Change 4 — `buildChunks` empty-content fallback:**

In `buildChunks`, replace the edge-case block at the bottom of the function:
```typescript
// Before:
if (chunks.length === 0) {
  chunks.push({
    documentId: doc.documentId ?? 0,
    index: 0,
    text: '',
    embedText: prefix,
  });
}

// After:
if (chunks.length === 0) {
  const fallback = doc.excerpt ?? '';
  chunks.push({
    documentId: doc.documentId ?? 0,
    index: 0,
    text: fallback,
    embedText: prefix + fallback,
  });
}
```

- [ ] **Step 4: Run all tests to confirm they pass**

```bash
npm test -- --testPathPattern=embedding.service.spec
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index/embedding.service.ts test/index/embedding.service.spec.ts
git commit -m "fix: token overflow — TRUNCATE_LENGTH 20k, chars/3 estimate, per-item cap, buildChunks excerpt fallback"
```

---

## Task 7: ValidationPipe + page validation

**Files:**
- Modify: `src/main.ts`
- Modify: `src/api/search.controller.ts`
- Modify: `test/api/app.e2e-spec.ts`

- [ ] **Step 1: Update E2E tests — add ValidationPipe to bootstrap, fix search assertions, add page tests**

In `test/api/app.e2e-spec.ts`:

Add import at the top:
```typescript
import { ValidationPipe } from '@nestjs/common';
```

In `beforeAll`, after `app = moduleFixture.createNestApplication();` add:
```typescript
app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
```

Replace the first search test:
```typescript
it('POST /api/search returns results for matching query', async () => {
  const res = await request(app.getHttpServer())
    .post('/api/search')
    .send({ query: 'capítulo' });

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.results)).toBe(true);
  expect(res.body.results.length).toBeGreaterThan(0);
  expect(res.body.results[0].title).toBe('El capítulo uno');
  expect(typeof res.body.total).toBe('number');
});
```

Add page validation tests:
```typescript
it('POST /api/search returns 400 for page = 0', async () => {
  const res = await request(app.getHttpServer())
    .post('/api/search')
    .send({ query: 'test', page: 0 });
  expect(res.status).toBe(400);
});

it('POST /api/search returns 400 for negative page', async () => {
  const res = await request(app.getHttpServer())
    .post('/api/search')
    .send({ query: 'test', page: -1 });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run E2E tests to confirm they fail**

```bash
npm run test:e2e
```

Expected: `Array.isArray(res.body)` assertion fails, page tests fail (no validation yet).

- [ ] **Step 3: Register `ValidationPipe` in `src/main.ts`**

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Search engine running on port ${port}`);
}

bootstrap();
```

- [ ] **Step 4: Add `page` validation to `src/api/search.controller.ts`**

Replace the `skip` line and add page validation. The relevant section currently reads:
```typescript
const skip = body.page && body.page > 1 ? (body.page - 1) * limit : 0;
```

Replace it with:
```typescript
const page = body.page ?? 1;
if (!Number.isInteger(page) || page < 1) {
  throw new BadRequestException('page must be a positive integer');
}
const skip = (page - 1) * limit;
```

- [ ] **Step 5: Run E2E tests to confirm they pass**

```bash
npm run test:e2e
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/api/search.controller.ts test/api/app.e2e-spec.ts
git commit -m "feat: register global ValidationPipe, add page validation in search controller"
```

---

## Task 8: Project reindex endpoint

**Files:**
- Create: `src/search/cache.module.ts`
- Modify: `src/search/search.module.ts`
- Modify: `src/index/index.module.ts`
- Modify: `src/index/index.service.ts`
- Modify: `src/api/reindex.controller.ts`
- Modify: `test/index/index.service.spec.ts`
- Modify: `test/api/app.e2e-spec.ts`

**Context:** `CacheService` must move into its own `CacheModule` (no dependencies) so both `IndexModule` and `SearchModule` can import it. `SearchModule` re-exports `CacheModule`, so `ApiModule` (which imports `SearchModule`) continues to resolve `CacheService` for `ReindexController` — **`ReindexController`'s existing import and constructor need no changes**. NestJS singleton scope guarantees the same `CacheService` instance is shared between `IndexService` and `ReindexController`.

- [ ] **Step 1: Write tests for the new endpoint and `IndexService` methods**

In `test/index/index.service.spec.ts`, add `CacheService` import and mock:

```typescript
import { CacheService } from '../../src/search/cache.service';

// Add to mock objects at top of file:
const mockCacheService = { clear: jest.fn() };
```

In the `providers` array inside `beforeEach`:
```typescript
{ provide: CacheService, useValue: mockCacheService },
```

Add new tests at the bottom of the describe block:

```typescript
describe('startProjectReindex', () => {
  it('throws ConflictException if already running', () => {
    (service as any).status.state = 'running';
    expect(() => service.startProjectReindex('my-book')).toThrow();
    (service as any).status.state = 'idle';
  });

  it('resets state to idle when slug is not found in projects.json', async () => {
    mockWpService.getProjects.mockResolvedValue([]);
    await service.runProjectReindex('no-such-slug');
    expect(service.getStatus().state).toBe('idle');
  });

  it('resets state to idle when slug is excluded', async () => {
    mockWpService.getProjects.mockResolvedValue([
      {
        slug: 'nopublicadas', 'project-type': 'book', title: 'X',
        author: '', tags: [], 'project-slug': 'nopublicadas',
        'description-short': '', 'description-long': '',
      },
    ]);
    await service.runProjectReindex('nopublicadas');
    expect(service.getStatus().state).toBe('idle');
  });

  it('inserts project doc and posts, clears cache', async () => {
    mockWpService.getProjects.mockResolvedValue([
      {
        slug: 'my-book', 'project-type': 'book', title: 'My Book',
        author: 'A', tags: [], 'project-slug': 'my-book',
        'description-short': '', 'description-long': '',
      },
    ]);
    mockWpService.getPosts.mockResolvedValue([
      {
        id_post: 10, title: 'Ch 1', slug: 'ch-1', post_type: 'my-book',
        excerpt: 'ex', content: 'con', permalink: 'https://ex.com',
        image: null, credits: { autores: [] }, tags: [],
      },
    ]);
    mockEmbeddingService.embedAll.mockResolvedValue([null]);

    await service.runProjectReindex('my-book');

    const count = db.db
      .prepare("SELECT COUNT(*) as c FROM documents WHERE project_slug = 'my-book'")
      .get() as { c: number };
    expect(count.c).toBe(2); // project doc + 1 post
    expect(mockCacheService.clear).toHaveBeenCalled();
    expect(service.getStatus().state).toBe('idle');
  });
});
```

In `test/api/app.e2e-spec.ts`, add:

```typescript
it('POST /api/reindex/project/:slug returns 401 without API key', async () => {
  const res = await request(app.getHttpServer()).post('/api/reindex/project/my-book');
  expect(res.status).toBe(401);
});

it('POST /api/reindex/project/:slug returns 202 with valid API key', async () => {
  const res = await request(app.getHttpServer())
    .post('/api/reindex/project/my-book')
    .set('X-API-Key', 'test-api-key');
  expect(res.status).toBe(202);
  expect(res.body.message).toContain('started');
});
```

- [ ] **Step 2: Run tests to confirm new ones fail**

```bash
npm test -- --testPathPattern=index.service.spec
npm run test:e2e
```

Expected: project reindex tests fail (method doesn't exist), E2E route test fails (endpoint doesn't exist). The existing `index.service.spec` tests will also fail because `CacheService` is now required but not yet provided — that's expected.

- [ ] **Step 3: Create `src/search/cache.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';

@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
```

- [ ] **Step 4: Update `src/search/search.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { CacheModule } from './cache.module';
import { DatabaseModule } from '../database/database.module';
import { IndexModule } from '../index/index.module';

@Module({
  imports: [DatabaseModule, IndexModule, CacheModule],
  providers: [SearchService],
  // Re-export CacheModule so ApiModule (which imports SearchModule) still resolves
  // CacheService for ReindexController — no change needed to ReindexController itself.
  exports: [SearchService, CacheModule],
})
export class SearchModule {}
```

- [ ] **Step 5: Update `src/index/index.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { IndexService } from './index.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModule } from '../database/database.module';
import { WordPressModule } from '../wordpress/wordpress.module';
import { CacheModule } from '../search/cache.module';

@Module({
  imports: [DatabaseModule, WordPressModule, CacheModule],
  providers: [IndexService, EmbeddingService],
  exports: [IndexService, EmbeddingService],
})
export class IndexModule {}
```

- [ ] **Step 6: Add `CacheService` injection and new methods to `src/index/index.service.ts`**

**Add import:**
```typescript
import { CacheService } from '../search/cache.service';
```

**Update constructor to inject `CacheService`:**
```typescript
constructor(
  private readonly config: ConfigService,
  private readonly db: DatabaseService,
  private readonly wp: WordPressService,
  private readonly embeddings: EmbeddingService,
  private readonly cache: CacheService,
) {
```

**Refactor `runEmbeddingPhase` to delegate to a new `runEmbeddingPhaseForRows` helper.** Replace the entire `runEmbeddingPhase` method with:

```typescript
private async runEmbeddingPhase(): Promise<void> {
  const rows = this.db.db
    .prepare('SELECT id, title, authors, excerpt, content FROM documents')
    .all() as Array<{ id: number; title: string; authors: string; excerpt: string; content: string }>;
  await this.runEmbeddingPhaseForRows(rows);
}

private async runEmbeddingPhaseForRows(
  rows: Array<{ id: number; title: string; authors: string; excerpt: string; content: string }>,
): Promise<void> {
  const docJobs: Array<{ documentId: number; text: string }> = [];
  const chunkJobs: Array<{ documentId: number; index: number; text: string; embedText: string }> = [];

  for (const row of rows) {
    const authorNames = safeJsonArray(row.authors).join(', ');
    const docLike = {
      title: row.title,
      authors: authorNames,
      excerpt: row.excerpt ?? '',
      content: row.content ?? '',
    };

    if (classifyDoc(docLike) === 'single') {
      const text = [row.title, authorNames, row.excerpt, row.content]
        .filter(Boolean)
        .join('\n')
        .slice(0, TRUNCATE_LENGTH);
      docJobs.push({ documentId: row.id, text });
    } else {
      chunkJobs.push(...buildChunks({ ...docLike, documentId: row.id }));
    }
  }

  const insertEmbed = this.db.db.prepare(
    'INSERT OR REPLACE INTO embeddings (document_id, embedding) VALUES (?, ?)',
  );
  const insertChunk = this.db.db.prepare(
    'INSERT INTO chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
  );

  const docVectors = await this.embeddings.embedAll(docJobs.map((j) => j.text));
  for (let i = 0; i < docJobs.length; i++) {
    const job = docJobs[i];
    const v = docVectors[i];
    if (!job || v == null) continue;
    insertEmbed.run(job.documentId, float32ToBuffer(new Float32Array(v)));
  }

  const chunkVectors = await this.embeddings.embedAll(chunkJobs.map((j) => j.embedText));
  for (let i = 0; i < chunkJobs.length; i++) {
    const j = chunkJobs[i];
    const v = chunkVectors[i];
    if (!j || v == null) continue;
    insertChunk.run(j.documentId, j.index, j.text, float32ToBuffer(new Float32Array(v)));
  }
}
```

**Add `startProjectReindex` and `runProjectReindex` methods:**

```typescript
startProjectReindex(slug: string): void {
  if (this.status.state === 'running') {
    throw new ConflictException('Reindex already running');
  }
  this.runProjectReindex(slug).catch((err) => {
    this.logger.error(`Project reindex failed for ${slug}`, err);
    this.status = {
      state: 'idle',
      lastIndexedAt: this.status.lastIndexedAt,
      progress: null,
    };
  });
}

async runProjectReindex(slug: string): Promise<void> {
  this.status = { state: 'running', lastIndexedAt: null, progress: { current: 0, total: 0 } };

  // Step 1: validate slug
  const allProjects = await this.wp.getProjects();
  const project = allProjects.find((p) => p.slug === slug);

  if (!project) {
    this.logger.error(`Project reindex: slug '${slug}' not found in projects.json`);
    this.status = { state: 'idle', lastIndexedAt: this.status.lastIndexedAt, progress: null };
    return;
  }

  if (this.excludedSlugs.has(project.slug) || this.excludedTypes.has(project['project-type'])) {
    this.logger.warn(`Project reindex: slug '${slug}' is excluded — aborting`);
    this.status = { state: 'idle', lastIndexedAt: this.status.lastIndexedAt, progress: null };
    return;
  }

  // Step 2: delete all existing documents for this project
  this.db.db.transaction(() => {
    const existingIds = this.db.db
      .prepare('SELECT id FROM documents WHERE project_slug = ?')
      .all(slug) as { id: number }[];

    for (const { id } of existingIds) {
      this.db.db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(id);
      this.db.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
    }

    this.db.db.prepare('DELETE FROM documents WHERE project_slug = ?').run(slug);
  })();

  // Step 3: insert fresh project doc
  const insertDoc = this.db.db.prepare(`
    INSERT INTO documents
      (wp_id, doc_type, project_slug, project_title, project_type, title, slug,
       permalink, excerpt, content, authors, author_bios, tags, image_url)
    VALUES
      (@wp_id, @doc_type, @project_slug, @project_title, @project_type, @title,
       @slug, @permalink, @excerpt, @content, @authors, @author_bios, @tags, @image_url)
  `);

  insertDoc.run(projectToDoc(project));

  // Step 4: fetch and insert posts
  let posts: WPPost[] = [];
  try {
    posts = await this.wp.getPosts(slug);
  } catch (err) {
    this.logger.error(`Project reindex: failed to fetch posts for ${slug}`, err);
  }

  // +1 accounts for the project doc already inserted above
  this.status.progress = { current: 1, total: posts.length + 1 };

  for (const post of posts) {
    insertDoc.run(postToDoc(post, project));
    this.status.progress.current += 1;
  }

  // Step 5: embed all newly inserted docs
  const newRows = this.db.db
    .prepare('SELECT id, title, authors, excerpt, content FROM documents WHERE project_slug = ?')
    .all(slug) as Array<{ id: number; title: string; authors: string; excerpt: string; content: string }>;

  await this.runEmbeddingPhaseForRows(newRows);

  // Step 6: clear cache and finalize
  this.cache.clear();
  this.status = {
    state: 'idle',
    lastIndexedAt: new Date().toISOString(),
    progress: null,
  };
}
```

- [ ] **Step 7: Add `POST project/:slug` handler to `src/api/reindex.controller.ts`**

Add this method to the `ReindexController` class (no changes to imports or constructor needed):

```typescript
@Post('project/:slug')
@HttpCode(HttpStatus.ACCEPTED)
startProjectReindex(@Param('slug') slug: string) {
  this.indexService.startProjectReindex(slug);
  return { message: 'Project reindex started' };
}
```

- [ ] **Step 8: Run all tests to confirm they pass**

```bash
npm test
npm run test:e2e
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  src/search/cache.module.ts \
  src/search/search.module.ts \
  src/index/index.module.ts \
  src/index/index.service.ts \
  src/api/reindex.controller.ts \
  test/index/index.service.spec.ts \
  test/api/app.e2e-spec.ts
git commit -m "feat: POST /api/reindex/project/:slug — async single-project reindex with CacheModule extraction"
```

---

## Final Verification

- [ ] **Run full test suite**

```bash
npm test
```

Expected: all unit tests PASS with no skips.

- [ ] **Run E2E suite**

```bash
npm run test:e2e
```

Expected: all E2E tests PASS.

- [ ] **Confirm no unexpected `console.log` in source**

```bash
grep -r "console\.log" src/ --include="*.ts"
```

Expected: only `src/main.ts` (bootstrap message) and `src/api/wordpress.controller.ts` (left untouched intentionally — out of scope for this plan). No `console.log` in any other file.
