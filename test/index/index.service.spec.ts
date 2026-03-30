import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { IndexService } from '../../src/index/index.service';
import { DatabaseService } from '../../src/database/database.service';
import { WordPressService } from '../../src/wordpress/wordpress.service';
import { EmbeddingService } from '../../src/index/embedding.service';
import { CacheService } from '../../src/search/cache.service';

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

const mockCacheService = { clear: jest.fn() };

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
        { provide: CacheService, useValue: mockCacheService },
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
      id_post: 77, title: 'Test Post', slug: 'test-post', post_type: 'my-book', status: true, post_status: 'publish',
      excerpt: 'ex', content: 'con', permalink: 'https://ex.com/p',
      image: null, credits: { autores: [] }, tags: [], metadata: { description: [], link: [], project: [] },
    };
    mockWpService.getSinglePost.mockResolvedValue(mockPost);
    mockEmbeddingService.embedAll.mockResolvedValue([new Float32Array([0.1, 0.2])]);

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

  it('upsertPost throws 404 when post_type is in excludedSlugs', async () => {
    mockWpService.getSinglePost.mockResolvedValue({
      id_post: 1, title: 'T', slug: 's', post_type: 'nopublicadas', status: true, post_status: 'publish',
      excerpt: '', content: '', permalink: '', image: null,
      credits: { autores: [] }, tags: [], metadata: { description: [], link: [], project: [] },
    });
    await expect(service.upsertPost(1)).rejects.toThrow('excluded');
  });

  it('upsertPost throws 404 when project row is not in the index', async () => {
    mockWpService.getSinglePost.mockResolvedValue({
      id_post: 2, title: 'T', slug: 's', post_type: 'unknown-project', status: true, post_status: 'publish',
      excerpt: '', content: '', permalink: '', image: null,
      credits: { autores: [] }, tags: [], metadata: { description: [], link: [], project: [] },
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
          id_post: 10, title: 'Ch 1', slug: 'ch-1', post_type: 'my-book', status: true, post_status: 'publish',
          excerpt: 'ex', content: 'con', permalink: 'https://ex.com',
          image: null, credits: { autores: [] }, tags: [],
          metadata: { description: [], link: [], project: [] },
        },
      ]);
      mockEmbeddingService.embedAll.mockResolvedValue([new Float32Array([0.1, 0.2])]);

      await service.runProjectReindex('my-book');

      const count = db.db
        .prepare("SELECT COUNT(*) as c FROM documents WHERE project_slug = 'my-book'")
        .get() as { c: number };
      expect(count.c).toBe(2); // project doc + 1 post
      expect(mockCacheService.clear).toHaveBeenCalled();
      expect(service.getStatus().state).toBe('idle');
    });
  });
});
