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
