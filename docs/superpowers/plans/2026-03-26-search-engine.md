# Search Engine Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a NestJS REST API that indexes WordPress content into SQLite (FTS5 + OpenAI embeddings) and serves hybrid full-text + semantic search results.

**Architecture:** Four NestJS modules (WordPress, Database, Index, Search) with an API layer on top. Reindexing runs as an in-process background job returning 202 immediately; search combines FTS5 BM25 scores with cosine similarity against stored embeddings.

**Tech Stack:** Node.js 20, NestJS 10, `better-sqlite3`, OpenAI SDK v4, Jest + `@nestjs/testing`, Docker + Traefik.

**Spec:** `docs/superpowers/specs/2026-03-26-search-engine-design.md`

---

## File Map

```
src/
├── main.ts                          — bootstrap NestJS app
├── app.module.ts                    — root module
├── shared/
│   └── types.ts                     — all shared TypeScript types
├── wordpress/
│   ├── wordpress.module.ts
│   ├── wordpress.service.ts         — getProjects(), getPosts(), getSinglePost()
│   └── wordpress.mappers.ts         — postToDoc(), projectToDoc()
├── database/
│   ├── database.module.ts
│   └── database.service.ts          — SQLite connection, WAL mode, schema creation
├── index/
│   ├── index.module.ts
│   ├── index.service.ts             — reindex pipeline, status tracking, upsertPost, deletePost
│   └── embedding.service.ts         — OpenAI batch embed, retry, Float32Array I/O, classification, chunking
├── search/
│   ├── search.module.ts
│   ├── search.service.ts            — FTS5 + cosine rank merge, snippet, SearchResult assembly
│   └── cache.service.ts             — in-memory TTL cache with SHA256 key normalization
└── api/
    ├── api.module.ts
    ├── guards/
    │   └── api-key.guard.ts
    ├── search.controller.ts         — POST /api/search, GET /api/status
    └── reindex.controller.ts        — POST/PUT/DELETE /api/reindex

test/
├── wordpress/
│   ├── wordpress.mappers.spec.ts
│   └── wordpress.service.spec.ts
├── database/
│   └── database.service.spec.ts
├── index/
│   ├── embedding.service.spec.ts
│   └── index.service.spec.ts
├── search/
│   ├── cache.service.spec.ts
│   └── search.service.spec.ts
└── api/
    ├── api-key.guard.spec.ts
    └── app.e2e-spec.ts

Dockerfile
docker-compose.yml
.env.example
.gitignore
package.json
tsconfig.json
tsconfig.build.json
nest-cli.json
jest.config.ts
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `nest-cli.json`
- Create: `jest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "eglc-search-backend",
  "version": "1.0.0",
  "scripts": {
    "build": "nest build",
    "start": "node dist/main",
    "start:dev": "nest start --watch",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:e2e": "jest --config jest.e2e.config.ts",
    "test:cov": "jest --coverage"
  },
  "dependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/config": "^3.2.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/platform-express": "^10.3.0",
    "better-sqlite3": "^9.4.3",
    "openai": "^4.28.0",
    "reflect-metadata": "^0.2.1",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.3.2",
    "@nestjs/testing": "^10.3.0",
    "@types/better-sqlite3": "^7.6.8",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.5",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^6.3.4",
    "ts-jest": "^29.1.2",
    "typescript": "^5.3.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": false,
    "forceConsistentCasingInFileNames": false,
    "noFallthroughCasesInSwitch": false
  }
}
```

- [ ] **Step 3: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

- [ ] **Step 4: Create `nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

- [ ] **Step 5: Create `jest.config.ts`**

```typescript
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/(?!.*e2e).*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
```

- [ ] **Step 6: Create `jest.e2e.config.ts`**

```typescript
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/api/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
};

export default config;
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
dist/
*.db
*.db-shm
*.db-wal
.env
.env.local
coverage/
```

- [ ] **Step 8: Create `.env.example`**

```
WP_BASE_URL=https://pabgon18.dream.press
OPENAI_API_KEY=sk-...
API_KEY=your-secret-api-key
DB_PATH=/data/search.db
PORT=3000
EXCLUDED_SLUGS=nopublicadas,espacio_negativo,clima_proceso
EXCLUDED_TYPES=podcast,collection
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` populated, no errors.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json tsconfig.build.json nest-cli.json jest.config.ts jest.e2e.config.ts .gitignore .env.example
git commit -m "feat: project scaffold — NestJS + SQLite + OpenAI dependencies"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/shared/types.ts`

- [ ] **Step 1: Create `src/shared/types.ts`**

```typescript
// ── WordPress API types ──────────────────────────────────────────────────────

export type ProjectType = 'book' | 'podcast' | 'collection' | 'newsletter' | 'post';

export interface Project {
  tags: string[];
  author: string;
  title: string;
  'short-title'?: string;
  'description-short': string;
  'description-long': string;
  'project-slug': string;
  slug: string;
  'project-type': ProjectType;
  'project-product-image'?: string;
  'og-image'?: string;
}

export interface WPAuthor {
  name: string;
  description: string;
}

export interface WPTag {
  term_id: number;
  name: string;
  slug: string;
}

export interface WPPost {
  id_post: number;
  title: string;
  slug: string;
  post_type: string;
  excerpt: string;
  content?: string;
  permalink: string;
  image: [string, number, number, boolean] | null;
  credits: { autores: WPAuthor[] };
  tags: WPTag[];
}

// ── Database row types ───────────────────────────────────────────────────────

export interface DocumentRow {
  wp_id: number | null;
  doc_type: 'project' | 'post';
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string | null;
  excerpt: string;
  content: string | null;
  authors: string;      // JSON: string[]
  author_bios: string;  // JSON: string[]
  tags: string;         // JSON: string[]
  image_url: string | null;
}

export interface DocumentDbRow extends DocumentRow {
  id: number;
  indexed_at: string;
}

// ── Index status ─────────────────────────────────────────────────────────────

export interface IndexStatus {
  state: 'idle' | 'running';
  lastIndexedAt: string | null;
  totalDocs: number;
  progress: { current: number; total: number } | null;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
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
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: shared TypeScript types"
```

---

## Task 3: Database Service

**Files:**
- Create: `src/database/database.service.ts`
- Create: `src/database/database.module.ts`
- Create: `test/database/database.service.spec.ts`

- [ ] **Step 1: Write the failing test**

`test/database/database.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from '../../src/database/database.service';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService],
    })
      .overrideProvider('DB_PATH')
      .useValue(':memory:')
      .compile();

    // override DB_PATH to use in-memory SQLite
    service = new DatabaseService(':memory:');
    service.onModuleInit();
  });

  afterEach(() => service.onModuleDestroy());

  it('creates the documents table', () => {
    const row = service.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
      .get();
    expect(row).toBeDefined();
  });

  it('creates the documents_fts virtual table', () => {
    const row = service.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .get();
    expect(row).toBeDefined();
  });

  it('creates the embeddings table', () => {
    const row = service.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .get();
    expect(row).toBeDefined();
  });

  it('creates the chunks table', () => {
    const row = service.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
      .get();
    expect(row).toBeDefined();
  });

  it('FTS5 insert trigger populates documents_fts on document insert', () => {
    service.db.prepare(
      `INSERT INTO documents (doc_type, project_slug, title, slug, excerpt, authors, author_bios, tags)
       VALUES ('post', 'test-project', 'Hello World', 'hello-world', 'An excerpt', '[]', '[]', '[]')`
    ).run();

    const result = service.db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'Hello'")
      .get();
    expect(result).toBeDefined();
  });

  it('FTS5 delete trigger removes from documents_fts on document delete', () => {
    const { lastInsertRowid } = service.db.prepare(
      `INSERT INTO documents (doc_type, project_slug, title, slug, excerpt, authors, author_bios, tags)
       VALUES ('post', 'test-project', 'Unique Title XYZ', 'slug', '', '[]', '[]', '[]')`
    ).run();

    service.db.prepare('DELETE FROM documents WHERE id = ?').run(lastInsertRowid);

    const result = service.db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'XYZ'")
      .get();
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/database/database.service.spec.ts
```

Expected: FAIL — `DatabaseService` not found.

- [ ] **Step 3: Create `src/database/database.service.ts`**

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  db!: Database.Database;

  constructor(
    private readonly dbPath: string,
  ) {}

  static fromConfig(config: ConfigService): DatabaseService {
    return new DatabaseService(config.get<string>('DB_PATH', './search.db'));
  }

  onModuleInit(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();
    this.logger.log(`Database opened: ${this.dbPath}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wp_id         INTEGER,
        doc_type      TEXT NOT NULL,
        project_slug  TEXT NOT NULL,
        project_title TEXT,
        project_type  TEXT,
        title         TEXT NOT NULL,
        slug          TEXT NOT NULL,
        permalink     TEXT,
        excerpt       TEXT DEFAULT '',
        content       TEXT,
        authors       TEXT DEFAULT '[]',
        author_bios   TEXT DEFAULT '[]',
        tags          TEXT DEFAULT '[]',
        image_url     TEXT,
        indexed_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_wp_id
        ON documents(wp_id) WHERE wp_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_project_slug
        ON documents(project_slug);

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, excerpt, content, authors, author_bios, tags, project_title,
        content=documents,
        content_rowid=id,
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, title, excerpt, content, authors, author_bios, tags, project_title)
        VALUES (new.id, new.title, new.excerpt, new.content, new.authors, new.author_bios, new.tags, new.project_title);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, excerpt, content, authors, author_bios, tags, project_title)
        VALUES ('delete', old.id, old.title, old.excerpt, old.content, old.authors, old.author_bios, old.tags, old.project_title);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, excerpt, content, authors, author_bios, tags, project_title)
        VALUES ('delete', old.id, old.title, old.excerpt, old.content, old.authors, old.author_bios, old.tags, old.project_title);
        INSERT INTO documents_fts(rowid, title, excerpt, content, authors, author_bios, tags, project_title)
        VALUES (new.id, new.title, new.excerpt, new.content, new.authors, new.author_bios, new.tags, new.project_title);
      END;

      CREATE TABLE IF NOT EXISTS embeddings (
        document_id INTEGER PRIMARY KEY,
        embedding   BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        text        TEXT NOT NULL,
        embedding   BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks(document_id);

      CREATE TABLE IF NOT EXISTS vocabulary (term TEXT PRIMARY KEY, freq INTEGER);
    `);
  }

  /** Drop and recreate all tables — used at start of full reindex. */
  resetSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS documents_fts;
      DROP TRIGGER IF EXISTS documents_ai;
      DROP TRIGGER IF EXISTS documents_ad;
      DROP TRIGGER IF EXISTS documents_au;
      DROP TABLE IF EXISTS vocabulary;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS embeddings;
      DROP TABLE IF EXISTS documents;
    `);
    this.createSchema();
  }
}
```

- [ ] **Step 4: Create `src/database/database.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service';

@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (config: ConfigService) => DatabaseService.fromConfig(config),
      inject: [ConfigService],
    },
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
```

- [ ] **Step 5: Fix test — update spec to instantiate `DatabaseService` directly**

Update `test/database/database.service.spec.ts` — replace the `beforeEach` to instantiate directly (no DI needed for unit test):

```typescript
beforeEach(() => {
  service = new DatabaseService(':memory:');
  service.onModuleInit();
});
```

Remove the `Test.createTestingModule` block.

- [ ] **Step 6: Run tests to verify they pass**

```bash
npm test -- test/database/database.service.spec.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/database/ test/database/
git commit -m "feat: DatabaseService — SQLite schema with FTS5 and triggers"
```

---

## Task 4: WordPress Service & Mappers

**Files:**
- Create: `src/wordpress/wordpress.mappers.ts`
- Create: `src/wordpress/wordpress.service.ts`
- Create: `src/wordpress/wordpress.module.ts`
- Create: `test/wordpress/wordpress.mappers.spec.ts`
- Create: `test/wordpress/wordpress.service.spec.ts`

- [ ] **Step 1: Write failing tests for mappers**

`test/wordpress/wordpress.mappers.spec.ts`:
```typescript
import { postToDoc, projectToDoc } from '../../src/wordpress/wordpress.mappers';
import { WPPost, Project } from '../../src/shared/types';

const mockProject: Project = {
  title: 'El libro',
  slug: 'el-libro',
  'project-slug': 'el-libro-slug',
  'project-type': 'book',
  author: 'Juan Pérez',
  tags: ['ciencia', 'ensayo'],
  'description-short': 'Descripción corta',
  'description-long': 'Descripción larga',
  'og-image': 'https://example.com/img.jpg',
};

const mockPost: WPPost = {
  id_post: 42,
  title: 'Capítulo 1',
  slug: 'capitulo-1',
  post_type: 'el-libro',
  excerpt: 'Un extracto',
  content: 'Contenido del capítulo',
  permalink: 'https://example.com/cap-1',
  image: ['https://example.com/cover.jpg', 800, 600, false],
  credits: { autores: [{ name: 'Ana García', description: 'Escritora' }] },
  tags: [{ term_id: 1, name: 'ficción', slug: 'ficcion' }],
};

describe('projectToDoc', () => {
  it('sets doc_type to project', () => {
    expect(projectToDoc(mockProject).doc_type).toBe('project');
  });

  it('sets wp_id to null', () => {
    expect(projectToDoc(mockProject).wp_id).toBeNull();
  });

  it('serializes tags as JSON array', () => {
    const doc = projectToDoc(mockProject);
    expect(JSON.parse(doc.tags)).toEqual(['ciencia', 'ensayo']);
  });

  it('uses og-image as image_url', () => {
    expect(projectToDoc(mockProject).image_url).toBe('https://example.com/img.jpg');
  });

  it('uses description-short as excerpt', () => {
    expect(projectToDoc(mockProject).excerpt).toBe('Descripción corta');
  });
});

describe('postToDoc', () => {
  it('sets doc_type to post', () => {
    expect(postToDoc(mockPost, mockProject).doc_type).toBe('post');
  });

  it('sets wp_id from id_post', () => {
    expect(postToDoc(mockPost, mockProject).wp_id).toBe(42);
  });

  it('serializes author names as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.authors)).toEqual(['Ana García']);
  });

  it('serializes author bios as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.author_bios)).toEqual(['Escritora']);
  });

  it('serializes tag names as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.tags)).toEqual(['ficción']);
  });

  it('uses image[0] as image_url', () => {
    expect(postToDoc(mockPost, mockProject).image_url).toBe('https://example.com/cover.jpg');
  });

  it('defaults excerpt to empty string when missing', () => {
    const post = { ...mockPost, excerpt: undefined } as unknown as WPPost;
    expect(postToDoc(post, mockProject).excerpt).toBe('');
  });

  it('sets image_url to null when image is null', () => {
    const post = { ...mockPost, image: null };
    expect(postToDoc(post, mockProject).image_url).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/wordpress/wordpress.mappers.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/wordpress/wordpress.mappers.ts`**

```typescript
import { DocumentRow, Project, WPPost } from '../shared/types';

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
  return {
    wp_id: post.id_post,
    doc_type: 'post',
    project_slug: project.slug,
    project_title: project.title,
    project_type: project['project-type'],
    title: post.title,
    slug: post.slug,
    permalink: post.permalink ?? null,
    excerpt: post.excerpt ?? '',
    content: post.content ?? null,
    authors: JSON.stringify(post.credits?.autores?.map((a) => a.name) ?? []),
    author_bios: JSON.stringify(post.credits?.autores?.map((a) => a.description) ?? []),
    tags: JSON.stringify(post.tags?.map((t) => t.name) ?? []),
    image_url: post.image ? post.image[0] : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/wordpress/wordpress.mappers.spec.ts
```

Expected: PASS — 13 tests.

- [ ] **Step 5: Create `src/wordpress/wordpress.service.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Project, WPPost } from '../shared/types';

@Injectable()
export class WordPressService {
  private readonly logger = new Logger(WordPressService.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('WP_BASE_URL');
  }

  async getProjects(): Promise<Project[]> {
    const res = await fetch(
      `${this.baseUrl}/wp-content/uploads/projects.json`,
    );
    if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
    return res.json() as Promise<Project[]>;
  }

  async getPosts(projectSlug: string): Promise<WPPost[]> {
    const res = await fetch(`${this.baseUrl}/wp-json/api/gato_get_posts/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        args: JSON.stringify({
          post_type: [projectSlug],
          posts_per_page: -1,
          paged: 1,
          meta_query: {
            relation: 'OR',
            '0': { key: 'lang', value: 'es', compare: '=' },
            '1': { key: 'lang', compare: 'NOT EXISTS' },
          },
        }),
        reduced: false,
      }),
    });
    if (!res.ok) throw new Error(`Failed to fetch posts for ${projectSlug}: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

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
        }),
        reduced: false,
      }),
    });
    if (!res.ok) throw new Error(`Failed to fetch post ${wpId}: ${res.status}`);
    const data = await res.json();
    const posts: WPPost[] = Array.isArray(data) ? data : [];
    return posts[0] ?? null;
  }
}
```

- [ ] **Step 6: Write test for WordPressService**

`test/wordpress/wordpress.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WordPressService } from '../../src/wordpress/wordpress.service';

describe('WordPressService', () => {
  let service: WordPressService;

  beforeEach(async () => {
    process.env.WP_BASE_URL = 'https://mock.example.com';
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [WordPressService],
    }).compile();
    service = module.get(WordPressService);
  });

  it('getPosts returns empty array when WP returns non-array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'not found' }),
    }) as jest.Mock;

    const result = await service.getPosts('some-slug');
    expect(result).toEqual([]);
  });

  it('getSinglePost returns null when WP returns empty array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as jest.Mock;

    const result = await service.getSinglePost(99);
    expect(result).toBeNull();
  });

  it('getSinglePost returns the first post', async () => {
    const mockPost = { id_post: 99, title: 'Test' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [mockPost],
    }) as jest.Mock;

    const result = await service.getSinglePost(99);
    expect(result).toEqual(mockPost);
  });
});
```

- [ ] **Step 7: Create `src/wordpress/wordpress.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { WordPressService } from './wordpress.service';

@Module({
  providers: [WordPressService],
  exports: [WordPressService],
})
export class WordPressModule {}
```

- [ ] **Step 8: Run all WordPress tests**

```bash
npm test -- test/wordpress/
```

Expected: PASS — all tests.

- [ ] **Step 9: Commit**

```bash
git add src/wordpress/ test/wordpress/
git commit -m "feat: WordPressService + mappers (postToDoc, projectToDoc)"
```

---

## Task 5: Embedding Service

**Files:**
- Create: `src/index/embedding.service.ts`
- Create: `test/index/embedding.service.spec.ts`

- [ ] **Step 1: Write failing tests**

`test/index/embedding.service.spec.ts`:
```typescript
import {
  float32ToBuffer,
  bufferToFloat32,
  cosineSimilarity,
  classifyDoc,
  buildChunks,
} from '../../src/index/embedding.service';

describe('float32ToBuffer / bufferToFloat32', () => {
  it('round-trips a Float32Array', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.9]);
    const buf = float32ToBuffer(original);
    const recovered = bufferToFloat32(buf);
    expect(recovered.length).toBe(4);
    // float32 precision tolerance
    expect(Math.abs(recovered[0] - 0.1)).toBeLessThan(1e-6);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1);
  });
});

describe('classifyDoc', () => {
  it('classifies short doc as single', () => {
    const doc = { title: 'T', authors: '', excerpt: '', content: 'short' };
    expect(classifyDoc(doc)).toBe('single');
  });

  it('classifies doc over threshold as chunked', () => {
    const doc = { title: 'T', authors: '', excerpt: '', content: 'x'.repeat(30_000) };
    expect(classifyDoc(doc)).toBe('chunked');
  });

  it('uses total text length (title + authors + excerpt + content)', () => {
    // individually small but collectively large
    const doc = {
      title: 'x'.repeat(10_000),
      authors: 'x'.repeat(10_000),
      excerpt: 'x'.repeat(9_000),
      content: 'x',
    };
    // total = 29_001 > threshold
    expect(classifyDoc(doc)).toBe('chunked');
  });
});

describe('buildChunks', () => {
  it('returns one chunk for content shorter than CHUNK_SIZE', () => {
    const doc = { title: 'Title', authors: 'Author', content: 'short content' };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(1);
  });

  it('includes all content when chunked', () => {
    const content = 'a'.repeat(3_000); // > CHUNK_SIZE(1400), requires 3 chunks
    const doc = { title: 'T', authors: 'A', content };
    const chunks = buildChunks(doc);
    const combined = chunks.map((c) => c.text).join('');
    // all chars from content appear somewhere across chunks
    expect(combined.length).toBeGreaterThanOrEqual(content.length);
  });

  it('each chunk embedText has the title/author prefix', () => {
    const doc = { title: 'My Title', authors: 'My Author', content: 'x'.repeat(2_000) };
    const chunks = buildChunks(doc);
    for (const chunk of chunks) {
      expect(chunk.embedText).toContain('My Title');
      expect(chunk.embedText).toContain('My Author');
    }
  });

  it('last chunk is included even if shorter than overlap', () => {
    const content = 'a'.repeat(1_450); // 1400 + 50 remainder
    const doc = { title: 'T', authors: 'A', content };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/index/embedding.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/index/embedding.service.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

// ── Constants ────────────────────────────────────────────────────────────────
export const CHUNK_THRESHOLD = 28_668;
export const TRUNCATE_LENGTH = 24_000;
export const CHUNK_SIZE = 1_400;
export const CHUNK_OVERLAP = 175;
const EMBED_BATCH_SIZE = 100;
const EMBED_MODEL = 'text-embedding-3-small';
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface DocLike { title: string; authors: string; excerpt: string; content: string | null }

function fullText(doc: DocLike): string {
  return [doc.title, doc.authors, doc.excerpt, doc.content]
    .filter(Boolean)
    .join('\n');
}

export function classifyDoc(doc: DocLike): 'single' | 'chunked' {
  return fullText(doc).length < CHUNK_THRESHOLD ? 'single' : 'chunked';
}

export interface ChunkJob {
  documentId: number;
  index: number;
  text: string;       // raw chunk content (no prefix)
  embedText: string;  // prefixed text sent to OpenAI
}

export function buildChunks(
  doc: DocLike & { documentId?: number },
): ChunkJob[] {
  const content = doc.content ?? '';
  const prefix = `Título: ${doc.title}\nAutores: ${doc.authors}\n\n`;
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  const chunks: ChunkJob[] = [];

  let start = 0;
  while (start < content.length) {
    const text = content.slice(start, start + CHUNK_SIZE);
    chunks.push({
      documentId: doc.documentId ?? 0,
      index: chunks.length,
      text,
      embedText: prefix + text,
    });
    start += step;
  }

  // edge case: empty content → one empty chunk so document gets an embedding
  if (chunks.length === 0) {
    chunks.push({ documentId: doc.documentId ?? 0, index: 0, text: '', embedText: prefix });
  }

  return chunks;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    this.client = new OpenAI({ apiKey: config.getOrThrow<string>('OPENAI_API_KEY') });
  }

  /** Embed a batch of texts with retry. Returns one vector per input text. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await this.client.embeddings.create({
          model: EMBED_MODEL,
          input: texts,
        });
        return res.data.map((d) => d.embedding);
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          this.logger.warn(`OpenAI embed failed (attempt ${attempt + 1}), retrying...`);
          await sleep(RETRY_DELAYS_MS[attempt]);
        } else {
          this.logger.error('OpenAI embed failed after all retries', err);
          throw err;
        }
      }
    }
    throw new Error('unreachable');
  }

  /** Embed texts in batches of EMBED_BATCH_SIZE, running batches in parallel. */
  async embedAll(texts: string[]): Promise<(number[] | null)[]> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      batches.push(texts.slice(i, i + EMBED_BATCH_SIZE));
    }

    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    await Promise.all(
      batches.map(async (batch, bi) => {
        try {
          const vectors = await this.embedBatch(batch);
          vectors.forEach((v, vi) => {
            results[bi * EMBED_BATCH_SIZE + vi] = v;
          });
        } catch {
          // already logged in embedBatch; leave nulls in results
        }
      }),
    );

    return results;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/index/embedding.service.spec.ts
```

Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/index/embedding.service.ts test/index/embedding.service.spec.ts
git commit -m "feat: EmbeddingService — OpenAI batching, retry, cosine similarity, chunking"
```

---

## Task 6: Index Service

**Files:**
- Create: `src/index/index.service.ts`
- Create: `src/index/index.module.ts`
- Create: `test/index/index.service.spec.ts`

- [ ] **Step 1: Write failing tests**

`test/index/index.service.spec.ts`:
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { IndexService } from '../../src/index/index.service';
import { DatabaseService } from '../../src/database/database.service';
import { WordPressService } from '../../src/wordpress/wordpress.service';
import { EmbeddingService } from '../../src/index/embedding.service';

function makeDbService() {
  const db = new DatabaseService(':memory:');
  db.onModuleInit();
  return db;
}

const mockWpService = {
  getProjects: jest.fn(),
  getPosts: jest.fn(),
  getSinglePost: jest.fn(),
};

const mockEmbeddingService = {
  embedAll: jest.fn().mockResolvedValue([]),
  embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2]]),
};

describe('IndexService', () => {
  let service: IndexService;
  let db: DatabaseService;

  beforeEach(async () => {
    db = makeDbService();
    process.env.EXCLUDED_SLUGS = 'nopublicadas,espacio_negativo';
    process.env.EXCLUDED_TYPES = 'podcast,collection';
    process.env.WP_BASE_URL = 'https://mock.example.com';
    process.env.OPENAI_API_KEY = 'test-key';

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        IndexService,
        { provide: DatabaseService, useValue: db },
        { provide: WordPressService, useValue: mockWpService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
      ],
    }).compile();

    service = module.get(IndexService);
  });

  afterEach(() => {
    db.onModuleDestroy();
    jest.clearAllMocks();
  });

  it('initial status is idle with zero docs', () => {
    const status = service.getStatus();
    expect(status.state).toBe('idle');
    expect(status.totalDocs).toBe(0);
    expect(status.lastIndexedAt).toBeNull();
  });

  it('filters out excluded slugs', async () => {
    mockWpService.getProjects.mockResolvedValue([
      { slug: 'nopublicadas', 'project-type': 'book', title: 'X', author: '', tags: [], 'project-slug': 'x', 'description-short': '', 'description-long': '' },
      { slug: 'my-book', 'project-type': 'book', title: 'My Book', author: 'A', tags: [], 'project-slug': 'my-book', 'description-short': '', 'description-long': '' },
    ]);
    mockWpService.getPosts.mockResolvedValue([]);

    await service.runFullReindex();
    // only 'my-book' project should be indexed
    const count = db.db.prepare("SELECT COUNT(*) as c FROM documents WHERE project_slug='my-book'").get() as { c: number };
    expect(count.c).toBe(1);
    const excluded = db.db.prepare("SELECT COUNT(*) as c FROM documents WHERE project_slug='nopublicadas'").get() as { c: number };
    expect(excluded.c).toBe(0);
  });

  it('filters out excluded project types', async () => {
    mockWpService.getProjects.mockResolvedValue([
      { slug: 'my-podcast', 'project-type': 'podcast', title: 'P', author: '', tags: [], 'project-slug': 'my-podcast', 'description-short': '', 'description-long': '' },
    ]);
    mockWpService.getPosts.mockResolvedValue([]);

    await service.runFullReindex();
    const count = db.db.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('upserts a post by wp_id', async () => {
    const mockPost = {
      id_post: 77, title: 'Test Post', slug: 'test-post', post_type: 'my-book',
      excerpt: 'ex', content: 'con', permalink: 'https://ex.com/p',
      image: null, credits: { autores: [] }, tags: [],
    };
    const mockProject = {
      slug: 'my-book', title: 'My Book', 'project-type': 'book', author: 'A',
      tags: [], 'project-slug': 'my-book', 'description-short': '', 'description-long': '',
    };
    mockWpService.getSinglePost.mockResolvedValue(mockPost);
    mockWpService.getProjects.mockResolvedValue([]);
    mockEmbeddingService.embedBatch.mockResolvedValue([[0.1, 0.2]]);

    // seed a project so we can look up its details
    db.db.prepare(
      `INSERT INTO documents (wp_id, doc_type, project_slug, project_title, project_type, title, slug, authors, author_bios, tags)
       VALUES (NULL, 'project', 'my-book', 'My Book', 'book', 'My Book', 'my-book', '[]', '[]', '[]')`
    ).run();

    await service.upsertPost(77);
    const row = db.db.prepare("SELECT * FROM documents WHERE wp_id = 77").get();
    expect(row).toBeDefined();
  });

  it('deletePost removes document by wp_id', () => {
    db.db.prepare(
      `INSERT INTO documents (wp_id, doc_type, project_slug, title, slug, authors, author_bios, tags)
       VALUES (55, 'post', 'proj', 'Title', 'slug', '[]', '[]', '[]')`
    ).run();

    service.deletePost(55);
    const row = db.db.prepare("SELECT * FROM documents WHERE wp_id = 55").get();
    expect(row).toBeUndefined();
  });

  it('throws NotFoundException when deletePost called for unknown wp_id', () => {
    expect(() => service.deletePost(999)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/index/index.service.spec.ts
```

Expected: FAIL — `IndexService` not found.

- [ ] **Step 3: Create `src/index/index.service.ts`**

```typescript
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { WordPressService } from '../wordpress/wordpress.service';
import {
  EmbeddingService,
  buildChunks,
  classifyDoc,
  float32ToBuffer,
  bufferToFloat32,
  CHUNK_THRESHOLD,
  TRUNCATE_LENGTH,
} from './embedding.service';
import { postToDoc, projectToDoc } from '../wordpress/wordpress.mappers';
import { DocumentRow, IndexStatus, Project } from '../shared/types';

const CONCURRENCY = 5;

@Injectable()
export class IndexService {
  private readonly logger = new Logger(IndexService.name);
  private readonly excludedSlugs: Set<string>;
  private readonly excludedTypes: Set<string>;

  private status: IndexStatus = {
    state: 'idle',
    lastIndexedAt: null,
    totalDocs: 0,
    progress: null,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly wp: WordPressService,
    private readonly embeddings: EmbeddingService,
  ) {
    this.excludedSlugs = new Set(
      (config.get<string>('EXCLUDED_SLUGS', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    this.excludedTypes = new Set(
      (config.get<string>('EXCLUDED_TYPES', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  getStatus(): IndexStatus {
    const totalDocs = (
      this.db.db.prepare('SELECT COUNT(*) as c FROM documents').get() as { c: number }
    ).c;
    return { ...this.status, totalDocs };
  }

  startFullReindex(): void {
    if (this.status.state === 'running') {
      throw new ConflictException('Reindex already running');
    }
    // Fire-and-forget
    this.runFullReindex().catch((err) => {
      this.logger.error('Full reindex failed', err);
      this.status.state = 'idle';
    });
  }

  async runFullReindex(): Promise<void> {
    this.status = { state: 'running', lastIndexedAt: null, totalDocs: 0, progress: { current: 0, total: 0 } };

    // ── Phase 1: content ─────────────────────────────────────────────────────
    this.db.resetSchema();

    const allProjects = await this.wp.getProjects();
    const projects = allProjects.filter(
      (p) => !this.excludedSlugs.has(p.slug) && !this.excludedTypes.has(p['project-type']),
    );

    this.status.progress = { current: 0, total: projects.length };

    const insertDoc = this.db.db.prepare(`
      INSERT INTO documents
        (wp_id, doc_type, project_slug, project_title, project_type, title, slug,
         permalink, excerpt, content, authors, author_bios, tags, image_url)
      VALUES
        (@wp_id, @doc_type, @project_slug, @project_title, @project_type, @title,
         @slug, @permalink, @excerpt, @content, @authors, @author_bios, @tags, @image_url)
    `);

    await parallelLimit(projects, CONCURRENCY, async (project) => {
      insertDoc.run(projectToDoc(project));

      let posts = [];
      try {
        posts = await this.wp.getPosts(project.slug);
      } catch (err) {
        this.logger.error(`Failed to fetch posts for ${project.slug}`, err);
      }

      for (const post of posts) {
        insertDoc.run(postToDoc(post, project));
      }

      this.status.progress!.current += 1;
    });

    this.buildVocabulary();

    // ── Phase 2: embeddings ──────────────────────────────────────────────────
    await this.runEmbeddingPhase();

    this.status = {
      state: 'idle',
      lastIndexedAt: new Date().toISOString(),
      totalDocs: 0,
      progress: null,
    };
  }

  async upsertPost(wpId: number): Promise<void> {
    const post = await this.wp.getSinglePost(wpId);
    if (!post) throw new NotFoundException(`Post ${wpId} not found in WordPress`);

    // Find the project this post belongs to from existing index
    const projectRow = this.db.db
      .prepare('SELECT * FROM documents WHERE doc_type = ? AND project_slug = ?')
      .get('project', post.post_type) as { project_slug: string; project_title: string; project_type: string } | undefined;

    // Build a minimal Project object from indexed data (or fall back)
    const project: Project = projectRow
      ? {
          slug: projectRow.project_slug,
          title: projectRow.project_title ?? post.post_type,
          'project-type': projectRow.project_type as Project['project-type'],
          author: '',
          tags: [],
          'project-slug': projectRow.project_slug,
          'description-short': '',
          'description-long': '',
        }
      : {
          slug: post.post_type,
          title: post.post_type,
          'project-type': 'book',
          author: '',
          tags: [],
          'project-slug': post.post_type,
          'description-short': '',
          'description-long': '',
        };

    const doc = postToDoc(post, project);

    this.db.db
      .prepare(`
        INSERT INTO documents
          (wp_id, doc_type, project_slug, project_title, project_type, title, slug,
           permalink, excerpt, content, authors, author_bios, tags, image_url)
        VALUES
          (@wp_id, @doc_type, @project_slug, @project_title, @project_type, @title,
           @slug, @permalink, @excerpt, @content, @authors, @author_bios, @tags, @image_url)
        ON CONFLICT(wp_id) WHERE wp_id IS NOT NULL DO UPDATE SET
          title=excluded.title, slug=excluded.slug, permalink=excluded.permalink,
          excerpt=excluded.excerpt, content=excluded.content, authors=excluded.authors,
          author_bios=excluded.author_bios, tags=excluded.tags, image_url=excluded.image_url,
          indexed_at=datetime('now')
      `)
      .run(doc);

    // Re-embed the upserted document
    const row = this.db.db
      .prepare('SELECT id, title, authors, excerpt, content FROM documents WHERE wp_id = ?')
      .get(wpId) as { id: number; title: string; authors: string; excerpt: string; content: string } | undefined;

    if (row) await this.embedSingleDoc(row);
  }

  deletePost(wpId: number): void {
    const row = this.db.db
      .prepare('SELECT id FROM documents WHERE wp_id = ?')
      .get(wpId);
    if (!row) throw new NotFoundException(`Document with wp_id ${wpId} not in index`);

    this.db.db.prepare('DELETE FROM embeddings WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)').run(wpId);
    this.db.db.prepare('DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)').run(wpId);
    this.db.db.prepare('DELETE FROM documents WHERE wp_id = ?').run(wpId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async runEmbeddingPhase(): Promise<void> {
    const rows = this.db.db
      .prepare('SELECT id, title, authors, excerpt, content FROM documents')
      .all() as Array<{ id: number; title: string; authors: string; excerpt: string; content: string }>;

    const docJobs: Array<{ documentId: number; text: string }> = [];
    const chunkJobs: Array<{ documentId: number; index: number; text: string; embedText: string }> = [];

    for (const row of rows) {
      const authorNames = safeJsonArray(row.authors).join(', ');
      const docLike = { title: row.title, authors: authorNames, excerpt: row.excerpt ?? '', content: row.content ?? '' };

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

    // Embed single-embedding docs
    const docVectors = await this.embeddings.embedAll(docJobs.map((j) => j.text));
    const insertEmbed = this.db.db.prepare(
      'INSERT OR REPLACE INTO embeddings (document_id, embedding) VALUES (?, ?)',
    );
    for (let i = 0; i < docJobs.length; i++) {
      if (docVectors[i]) {
        insertEmbed.run(docJobs[i].documentId, float32ToBuffer(new Float32Array(docVectors[i]!)));
      }
    }

    // Embed chunked docs
    const chunkVectors = await this.embeddings.embedAll(chunkJobs.map((j) => j.embedText));
    const insertChunk = this.db.db.prepare(
      'INSERT INTO chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < chunkJobs.length; i++) {
      if (chunkVectors[i]) {
        const j = chunkJobs[i];
        insertChunk.run(j.documentId, j.index, j.text, float32ToBuffer(new Float32Array(chunkVectors[i]!)));
      }
    }
  }

  private async embedSingleDoc(row: { id: number; title: string; authors: string; excerpt: string; content: string }): Promise<void> {
    const authorNames = safeJsonArray(row.authors).join(', ');
    const docLike = { title: row.title, authors: authorNames, excerpt: row.excerpt ?? '', content: row.content ?? '' };

    // remove old embedding/chunks
    this.db.db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(row.id);
    this.db.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(row.id);

    try {
      if (classifyDoc(docLike) === 'single') {
        const text = [row.title, authorNames, row.excerpt, row.content]
          .filter(Boolean).join('\n').slice(0, TRUNCATE_LENGTH);
        const [vector] = await this.embeddings.embedBatch([text]);
        this.db.db.prepare('INSERT INTO embeddings (document_id, embedding) VALUES (?, ?)').run(
          row.id, float32ToBuffer(new Float32Array(vector)),
        );
      } else {
        const chunks = buildChunks({ ...docLike, documentId: row.id });
        const vectors = await this.embeddings.embedBatch(chunks.map((c) => c.embedText));
        const insertChunk = this.db.db.prepare(
          'INSERT INTO chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
        );
        chunks.forEach((c, i) => {
          insertChunk.run(c.documentId, c.index, c.text, float32ToBuffer(new Float32Array(vectors[i])));
        });
      }
    } catch {
      this.logger.warn(`Failed to embed document ${row.id} — stored FTS-only`);
    }
  }

  private buildVocabulary(): void {
    const rows = this.db.db
      .prepare('SELECT title, excerpt, content FROM documents')
      .all() as Array<{ title: string; excerpt: string; content: string }>;

    const freq = new Map<string, number>();
    for (const row of rows) {
      const text = [row.title, row.excerpt, row.content].filter(Boolean).join(' ');
      for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (word.length >= 3) freq.set(word, (freq.get(word) ?? 0) + 1);
      }
    }

    const insert = this.db.db.prepare(
      'INSERT OR REPLACE INTO vocabulary (term, freq) VALUES (?, ?)',
    );
    const insertAll = this.db.db.transaction(() => {
      for (const [term, count] of freq) insert.run(term, count);
    });
    insertAll();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function parallelLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
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

- [ ] **Step 4: Create `src/index/index.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { IndexService } from './index.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModule } from '../database/database.module';
import { WordPressModule } from '../wordpress/wordpress.module';

@Module({
  imports: [DatabaseModule, WordPressModule],
  providers: [IndexService, EmbeddingService],
  exports: [IndexService],
})
export class IndexModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- test/index/index.service.spec.ts
```

Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
git add src/index/ test/index/index.service.spec.ts
git commit -m "feat: IndexService — full reindex pipeline, upsert, delete, vocabulary"
```

---

## Task 7: Cache Service

**Files:**
- Create: `src/search/cache.service.ts`
- Create: `test/search/cache.service.spec.ts`

- [ ] **Step 1: Write failing tests**

`test/search/cache.service.spec.ts`:
```typescript
import { CacheService } from '../../src/search/cache.service';

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => { cache = new CacheService(); });

  it('returns undefined for a cache miss', () => {
    expect(cache.get('some query')).toBeUndefined();
  });

  it('returns cached value for a cache hit', () => {
    const results = [{ id: 1 }] as any;
    cache.set('hello world', results);
    expect(cache.get('hello world')).toEqual(results);
  });

  it('normalizes query — same key for different casing/whitespace', () => {
    cache.set('Hello World', [{ id: 1 }] as any);
    expect(cache.get('  hello world  ')).toBeDefined();
    expect(cache.get('HELLO WORLD')).toBeDefined();
  });

  it('returns undefined for expired entries', async () => {
    jest.useFakeTimers();
    cache.set('test', [{ id: 1 }] as any);
    // Advance time beyond TTL (1 hour)
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(cache.get('test')).toBeUndefined();
    jest.useRealTimers();
  });

  it('clear() removes all entries', () => {
    cache.set('query1', [{ id: 1 }] as any);
    cache.set('query2', [{ id: 2 }] as any);
    cache.clear();
    expect(cache.get('query1')).toBeUndefined();
    expect(cache.get('query2')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/search/cache.service.spec.ts
```

Expected: FAIL — `CacheService` not found.

- [ ] **Step 3: Create `src/search/cache.service.ts`**

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

  private normalize(query: string): string {
    return query.trim().toLowerCase();
  }

  private hash(query: string): string {
    return createHash('sha256').update(this.normalize(query)).digest('hex');
  }

  get(query: string): SearchResult[] | undefined {
    const key = this.hash(query);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(query: string, results: SearchResult[]): void {
    const key = this.hash(query);
    this.store.set(key, { results, expiresAt: Date.now() + TTL_MS });
  }

  clear(): void {
    this.store.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/search/cache.service.spec.ts
```

Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/search/cache.service.ts test/search/cache.service.spec.ts
git commit -m "feat: CacheService — in-memory TTL cache with SHA256 key normalization"
```

---

## Task 8: Search Service

**Files:**
- Create: `src/search/search.service.ts`
- Create: `src/search/search.module.ts`
- Create: `test/search/search.service.spec.ts`

- [ ] **Step 1: Write failing tests**

`test/search/search.service.spec.ts`:
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

  it('returns empty array when no documents are indexed', async () => {
    const results = await service.search('anything', 10);
    expect(results).toEqual([]);
  });

  it('returns FTS5 results for matching query', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, project_title, project_type, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Project', 'book', 'El gato mágico', 'el-gato', '[]', '[]', '[]', 'Extracto', 'Contenido sobre gatos')
    `).run();

    const results = await service.search('gato', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('El gato mágico');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      db.db.prepare(`
        INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
        VALUES ('post', 'proj', 'Test doc ${i}', 'slug-${i}', '[]', '[]', '[]', 'test content', 'test content common')
      `).run();
    }

    const results = await service.search('test', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('serializes authors JSON array to comma-joined string', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Libro', 'libro', '["Ana García","Pedro López"]', '[]', '[]', 'libro texto', 'libro texto')
    `).run();

    const results = await service.search('libro', 10);
    expect(results[0]?.authors).toBe('Ana García,Pedro López');
  });

  it('returns null for tags when tags array is empty', async () => {
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'proj', 'Notag', 'notag', '[]', '[]', '[]', 'notag text', 'notag text')
    `).run();

    const results = await service.search('notag', 10);
    expect(results[0]?.tags).toBeNull();
  });

  it('uses cache on second call with same query', async () => {
    await service.search('cached query', 10);
    await service.search('cached query', 10);
    // embedBatch should only be called once (second call hits cache)
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/search/search.service.spec.ts
```

Expected: FAIL — `SearchService` not found.

- [ ] **Step 3: Create `src/search/search.service.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EmbeddingService, bufferToFloat32, cosineSimilarity } from '../index/embedding.service';
import { CacheService } from './cache.service';
import { SearchResult } from '../shared/types';

const FTS5_FIELDS = ['title', 'excerpt', 'content', 'authors', 'author_bios', 'tags', 'project_title'];

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
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingService: EmbeddingService,
    private readonly cache: CacheService,
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const cached = this.cache.get(query);
    if (cached) return cached.slice(0, limit);

    // 1. FTS5 match
    const ftsRows = this.runFts(query);
    if (ftsRows.length === 0) return [];

    // 2. Compute query embedding
    let queryEmbedding: Float32Array | null = null;
    try {
      const [vec] = await this.embeddingService.embedBatch([query.trim().toLowerCase()]);
      queryEmbedding = new Float32Array(vec);
    } catch {
      this.logger.warn('Query embedding failed — using FTS5-only ranking');
    }

    // 3. Normalize BM25 scores (rank is negative; lower = better)
    const ranks = ftsRows.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const rankRange = maxRank - minRank || 1;

    // 4. Score each result
    const scored = ftsRows.map((row) => {
      const bm25Norm = 1 - (row.rank - minRank) / rankRange; // invert: higher = better
      const cosine = queryEmbedding ? this.cosineForDoc(row.id, queryEmbedding) : 0;
      const finalScore = bm25Norm * 0.4 + cosine * 0.6;
      return { row, finalScore };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);

    // 5. Build SearchResult[]
    const results: SearchResult[] = scored.slice(0, limit).map(({ row, finalScore }) => {
      const { snippetContent, snippetExcerpt, matchedFields } = this.getSnippets(row.id, query);
      const authorArr: string[] = safeJsonArray(row.authors);
      const tagArr: string[] = safeJsonArray(row.tags);

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
        snippet_content: snippetContent,
        snippet_excerpt: snippetExcerpt,
        matchedFields,
      };
    });

    this.cache.set(query, results);
    return results;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private runFts(query: string): FtsRow[] {
    try {
      return this.db.db
        .prepare(`
          SELECT d.id, f.rank,
            d.doc_type, d.project_slug, d.project_title, d.project_type,
            d.title, d.slug, d.permalink, d.excerpt, d.authors, d.tags,
            d.image_url, d.content
          FROM documents_fts f
          JOIN documents d ON d.id = f.rowid
          WHERE documents_fts MATCH ?
          ORDER BY f.rank
        `)
        .all(query.trim().toLowerCase()) as FtsRow[];
    } catch {
      return [];
    }
  }

  private cosineForDoc(docId: number, queryEmbedding: Float32Array): number {
    // Try single embedding first
    const embRow = this.db.db
      .prepare('SELECT embedding FROM embeddings WHERE document_id = ?')
      .get(docId) as { embedding: Buffer } | undefined;

    if (embRow) {
      return cosineSimilarity(queryEmbedding, bufferToFloat32(embRow.embedding));
    }

    // Try chunks — return max cosine across all chunks
    const chunkRows = this.db.db
      .prepare('SELECT embedding FROM chunks WHERE document_id = ?')
      .all(docId) as { embedding: Buffer }[];

    if (chunkRows.length === 0) return 0;

    return Math.max(
      ...chunkRows.map((c) => cosineSimilarity(queryEmbedding, bufferToFloat32(c.embedding))),
    );
  }

  private getSnippets(
    docId: number,
    query: string,
  ): { snippetContent: string; snippetExcerpt: string; matchedFields: string[] } {
    // FTS5 snippet() args: table, column_index(-1=best), start, end, ellipsis, tokens
    try {
      const row = this.db.db
        .prepare(`
          SELECT
            snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snip_content,
            snippet(documents_fts, 1, '<mark>', '</mark>', '...', 64) as snip_excerpt
          FROM documents_fts
          WHERE documents_fts MATCH ? AND rowid = ?
        `)
        .get(query.trim().toLowerCase(), docId) as
        | { snip_content: string; snip_excerpt: string }
        | undefined;

      const matchedFields = this.getMatchedFields(docId, query);

      return {
        snippetContent: row?.snip_content ?? '',
        snippetExcerpt: row?.snip_excerpt ?? '',
        matchedFields,
      };
    } catch {
      return { snippetContent: '', snippetExcerpt: '', matchedFields: [] };
    }
  }

  private getMatchedFields(docId: number, query: string): string[] {
    const matched: string[] = [];
    for (let i = 0; i < FTS5_FIELDS.length; i++) {
      try {
        const row = this.db.db
          .prepare(
            `SELECT snippet(documents_fts, ${i}, '', '', '', 1) as s FROM documents_fts WHERE documents_fts MATCH ? AND rowid = ?`,
          )
          .get(query.trim().toLowerCase(), docId) as { s: string } | undefined;
        if (row?.s) matched.push(FTS5_FIELDS[i]);
      } catch {
        // column had no match
      }
    }
    return matched;
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

- [ ] **Step 4: Create `src/search/search.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { CacheService } from './cache.service';
import { DatabaseModule } from '../database/database.module';
import { IndexModule } from '../index/index.module';

@Module({
  imports: [DatabaseModule, IndexModule],
  providers: [SearchService, CacheService],
  exports: [SearchService, CacheService],
})
export class SearchModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- test/search/search.service.spec.ts
```

Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
git add src/search/ test/search/search.service.spec.ts
git commit -m "feat: SearchService — FTS5 + cosine similarity, rank merge, snippet, cache"
```

---

## Task 9: API Layer

**Files:**
- Create: `src/api/guards/api-key.guard.ts`
- Create: `src/api/search.controller.ts`
- Create: `src/api/reindex.controller.ts`
- Create: `src/api/api.module.ts`
- Create: `test/api/api-key.guard.spec.ts`

- [ ] **Step 1: Write failing test for guard**

`test/api/api-key.guard.spec.ts`:
```typescript
import { ApiKeyGuard } from '../../src/api/guards/api-key.guard';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function makeContext(headerValue: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: headerValue ? { 'x-api-key': headerValue } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;

  beforeEach(() => {
    const config = { get: () => 'secret-key' } as unknown as ConfigService;
    guard = new ApiKeyGuard(config);
  });

  it('allows request with correct API key', () => {
    expect(guard.canActivate(makeContext('secret-key'))).toBe(true);
  });

  it('rejects request with wrong API key', () => {
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow();
  });

  it('rejects request with missing API key', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/api/api-key.guard.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/api/guards/api-key.guard.ts`**

```typescript
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>('API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const provided = req.headers['x-api-key'];
    if (provided !== this.apiKey) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    return true;
  }
}
```

- [ ] **Step 4: Run guard test to verify it passes**

```bash
npm test -- test/api/api-key.guard.spec.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Create `src/api/search.controller.ts`**

```typescript
import {
  Controller, Post, Get, Body, BadRequestException, HttpCode,
} from '@nestjs/common';
import { SearchService } from '../search/search.service';
import { IndexService } from '../index/index.service';

interface SearchBody {
  query?: string;
  limit?: number;
}

@Controller('api')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly indexService: IndexService,
  ) {}

  @Post('search')
  @HttpCode(200)
  async search(@Body() body: SearchBody) {
    const query = body?.query?.trim();
    if (!query) throw new BadRequestException('query is required');

    const limit = body.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }

    return this.searchService.search(query, limit);
  }

  @Get('status')
  status() {
    const s = this.indexService.getStatus();
    const result: Record<string, unknown> = {
      state: s.state,
      totalDocs: s.totalDocs,
      lastIndexedAt: s.lastIndexedAt,
    };
    if (s.state === 'running' && s.progress) {
      result.progress = s.progress;
    }
    return result;
  }
}
```

- [ ] **Step 6: Create `src/api/reindex.controller.ts`**

```typescript
import {
  Controller, Post, Put, Delete, Param, HttpCode, UseGuards,
  HttpStatus, ParseIntPipe,
} from '@nestjs/common';
import { IndexService } from '../index/index.service';
import { CacheService } from '../search/cache.service';
import { ApiKeyGuard } from './guards/api-key.guard';

@Controller('api/reindex')
@UseGuards(ApiKeyGuard)
export class ReindexController {
  constructor(
    private readonly indexService: IndexService,
    private readonly cache: CacheService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  startReindex() {
    this.indexService.startFullReindex(); // throws 409 if running
    return { message: 'Reindex started' };
  }

  @Put(':id')
  async upsert(@Param('id', ParseIntPipe) id: number) {
    await this.indexService.upsertPost(id); // throws 404 if not found
    this.cache.clear();
    return { message: 'Document reindexed' };
  }

  @Delete(':id')
  delete(@Param('id', ParseIntPipe) id: number) {
    this.indexService.deletePost(id); // throws 404 if not found
    this.cache.clear();
    return { message: 'Document deleted' };
  }
}
```

- [ ] **Step 7: Create `src/api/api.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { ReindexController } from './reindex.controller';
import { SearchModule } from '../search/search.module';
import { IndexModule } from '../index/index.module';
import { ApiKeyGuard } from './guards/api-key.guard';

@Module({
  imports: [SearchModule, IndexModule],
  controllers: [SearchController, ReindexController],
  providers: [ApiKeyGuard],
})
export class ApiModule {}
```

- [ ] **Step 8: Commit**

```bash
git add src/api/ test/api/api-key.guard.spec.ts
git commit -m "feat: API layer — search, status, reindex controllers with API key guard"
```

---

## Task 10: App Bootstrap

**Files:**
- Create: `src/app.module.ts`
- Create: `src/main.ts`

- [ ] **Step 1: Create `src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { WordPressModule } from './wordpress/wordpress.module';
import { IndexModule } from './index/index.module';
import { SearchModule } from './search/search.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    WordPressModule,
    IndexModule,
    SearchModule,
    ApiModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 2: Create `src/main.ts`**

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Search engine running on port ${port}`);
}

bootstrap();
```

- [ ] **Step 3: Verify the app compiles**

```bash
npm run build
```

Expected: `dist/` created, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/app.module.ts src/main.ts
git commit -m "feat: app bootstrap — AppModule wires all modules"
```

---

## Task 11: E2E Tests

**Files:**
- Create: `test/api/app.e2e-spec.ts`

- [ ] **Step 1: Create the E2E test**

`test/api/app.e2e-spec.ts`:
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/database/database.service';
import { EmbeddingService } from '../../src/index/embedding.service';
import { WordPressService } from '../../src/wordpress/wordpress.service';

describe('App E2E', () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    process.env.WP_BASE_URL = 'https://mock.wp.example.com';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.API_KEY = 'test-api-key';
    process.env.DB_PATH = ':memory:';
    process.env.EXCLUDED_SLUGS = 'nopublicadas';
    process.env.EXCLUDED_TYPES = 'podcast';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmbeddingService)
      .useValue({
        embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
        embedAll: jest.fn().mockResolvedValue([]),
      })
      .overrideProvider(WordPressService)
      .useValue({
        getProjects: jest.fn().mockResolvedValue([]),
        getPosts: jest.fn().mockResolvedValue([]),
        getSinglePost: jest.fn().mockResolvedValue(null),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    db = moduleFixture.get(DatabaseService);

    // Seed one document for search tests
    db.db.prepare(`
      INSERT INTO documents (doc_type, project_slug, project_title, project_type, title, slug, authors, author_bios, tags, excerpt, content)
      VALUES ('post', 'test-proj', 'Test Project', 'book', 'El capítulo uno', 'capitulo-1', '["Ana"]', '[]', '[]', 'Extracto aquí', 'Contenido del capítulo')
    `).run();
  });

  afterAll(async () => { await app.close(); });

  // ── POST /api/search ────────────────────────────────────────────────────────

  it('POST /api/search returns results for matching query', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/search')
      .send({ query: 'capítulo' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].title).toBe('El capítulo uno');
  });

  it('POST /api/search returns 400 for missing query', async () => {
    const res = await request(app.getHttpServer()).post('/api/search').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/search returns 400 for limit > 50', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/search')
      .send({ query: 'test', limit: 100 });
    expect(res.status).toBe(400);
  });

  // ── GET /api/status ─────────────────────────────────────────────────────────

  it('GET /api/status returns idle state', async () => {
    const res = await request(app.getHttpServer()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
    expect(typeof res.body.totalDocs).toBe('number');
    expect('lastIndexedAt' in res.body).toBe(true);
  });

  // ── POST /api/reindex ───────────────────────────────────────────────────────

  it('POST /api/reindex returns 401 without API key', async () => {
    const res = await request(app.getHttpServer()).post('/api/reindex');
    expect(res.status).toBe(401);
  });

  it('POST /api/reindex returns 202 with valid API key', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/reindex')
      .set('X-API-Key', 'test-api-key');
    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Reindex started');
  });

  // ── DELETE /api/reindex/:id ─────────────────────────────────────────────────

  it('DELETE /api/reindex/:id returns 401 without API key', async () => {
    const res = await request(app.getHttpServer()).delete('/api/reindex/1');
    expect(res.status).toBe(401);
  });

  it('DELETE /api/reindex/:id returns 404 for unknown wp_id', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/reindex/99999')
      .set('X-API-Key', 'test-api-key');
    expect(res.status).toBe(404);
  });

  // ── PUT /api/reindex/:id ────────────────────────────────────────────────────

  it('PUT /api/reindex/:id returns 404 when WP returns no post', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/reindex/77777')
      .set('X-API-Key', 'test-api-key');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
npm run test:e2e
```

Expected: PASS — all tests.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: PASS — all unit tests.

- [ ] **Step 4: Commit**

```bash
git add test/api/app.e2e-spec.ts
git commit -m "test: E2E tests for all API endpoints"
```

---

## Task 12: Docker & Deployment

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "dist/main"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  search:
    build: .
    restart: unless-stopped
    volumes:
      - search-data:/data
    environment:
      WP_BASE_URL: ${WP_BASE_URL}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      API_KEY: ${API_KEY}
      DB_PATH: /data/search.db
      PORT: 3000
      EXCLUDED_SLUGS: ${EXCLUDED_SLUGS:-nopublicadas,espacio_negativo,clima_proceso}
      EXCLUDED_TYPES: ${EXCLUDED_TYPES:-podcast,collection}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.search.rule=Host(`search.elgatoylacaja.com`)"
      - "traefik.http.routers.search.entrypoints=websecure"
      - "traefik.http.routers.search.tls.certresolver=letsencrypt"
      - "traefik.http.services.search.loadbalancer.server.port=3000"

volumes:
  search-data:
```

- [ ] **Step 3: Verify Docker build**

```bash
docker build -t eglc-search .
```

Expected: image builds successfully.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: Docker + docker-compose deployment config with Traefik labels"
```

---

## Done

Run the full test suite one final time to confirm everything passes:

```bash
npm test && npm run test:e2e
```

Then trigger a first full reindex after deployment:
```bash
curl -X POST https://search.elgatoylacaja.com/api/reindex \
  -H "X-API-Key: <your-api-key>"
```
