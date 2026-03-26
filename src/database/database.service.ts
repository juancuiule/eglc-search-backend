import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database = require('better-sqlite3');

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  db!: Database.Database;

  constructor(private readonly dbPath: string) {}

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
