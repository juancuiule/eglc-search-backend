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
    mockWpService.getSinglePost.mockResolvedValue(mockPost);
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
