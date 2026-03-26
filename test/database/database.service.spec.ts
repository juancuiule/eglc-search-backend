import { DatabaseService } from '../../src/database/database.service';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeEach(() => {
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
