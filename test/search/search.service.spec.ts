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
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalledTimes(1);
  });
});
