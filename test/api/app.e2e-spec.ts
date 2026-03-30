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
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].title).toBe('El capítulo uno');
    expect(typeof res.body.total).toBe('number');
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

  // ── POST /api/reindex/project/:slug ─────────────────────────────────────────

  it('POST /api/reindex/project/:slug returns 401 without API key', async () => {
    const res = await request(app.getHttpServer()).post('/api/reindex/project/my-book');
    expect(res.status).toBe(401);
  });

  it('POST /api/reindex/project/:slug returns 202 with valid API key', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/reindex/project/my-book')
      .set('X-API-Key', 'test-api-key');
    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Project reindex started');
  });
});
