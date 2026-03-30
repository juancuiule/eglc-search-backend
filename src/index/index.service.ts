import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../database/database.service";
import { WordPressService } from "../wordpress/wordpress.service";
import {
  EmbeddingService,
  buildChunks,
  classifyDoc,
  float32ToBuffer,
  TRUNCATE_LENGTH,
} from "./embedding.service";
import { postToDoc, projectToDoc } from "../wordpress/wordpress.mappers";
import { IndexStatus, Project, WPPost } from "../shared/types";

const CONCURRENCY = 5;

@Injectable()
export class IndexService {
  private readonly logger = new Logger(IndexService.name);
  private readonly excludedSlugs: Set<string>;
  private readonly excludedTypes: Set<string>;

  private status: IndexStatus = {
    state: "idle",
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
      (config.get<string>("EXCLUDED_SLUGS", "") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.excludedTypes = new Set(
      (config.get<string>("EXCLUDED_TYPES", "") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  getStatus(): IndexStatus {
    const totalDocs = (
      this.db.db.prepare("SELECT COUNT(*) as c FROM documents").get() as {
        c: number;
      }
    ).c;
    return { ...this.status, totalDocs };
  }

  startFullReindex(): void {
    if (this.status.state === "running") {
      throw new ConflictException("Reindex already running");
    }
    this.runFullReindex().catch((err) => {
      this.logger.error("Full reindex failed", err);
      this.status.state = "idle";
    });
  }

  async runFullReindex(): Promise<void> {
    this.status = {
      state: "running",
      lastIndexedAt: null,
      totalDocs: 0,
      progress: { current: 0, total: 0 },
    };

    // ── Phase 1: content ─────────────────────────────────────────────────────
    this.db.resetSchema();


    const allProjects = await this.wp.getProjects();
    const projects = allProjects.filter(
      (p) =>
        !this.excludedSlugs.has(p.slug) &&
        !this.excludedTypes.has(p["project-type"]),
    );

    this.logger.log(`Indexing ${projects.length} projects (excluded ${allProjects.length - projects.length})`);
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

      let posts: WPPost[] = [];
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
      state: "idle",
      lastIndexedAt: new Date().toISOString(),
      totalDocs: 0,
      progress: null,
    };
  }

  async upsertPost(wpId: number): Promise<void> {
    const post = await this.wp.getSinglePost(wpId);
    if (!post)
      throw new NotFoundException(`Post ${wpId} not found in WordPress`);

    const projectRow = this.db.db
      .prepare(
        "SELECT project_slug, project_title, project_type FROM documents WHERE doc_type = ? AND project_slug = ?",
      )
      .get("project", post.post_type) as
      | { project_slug: string; project_title: string; project_type: string }
      | undefined;

    const project: Project = projectRow
      ? {
          slug: projectRow.project_slug,
          title: projectRow.project_title ?? post.post_type,
          "project-type": projectRow.project_type as Project["project-type"],
          author: "",
          tags: [],
          "project-slug": projectRow.project_slug,
          "description-short": "",
          "description-long": "",
        }
      : {
          slug: post.post_type,
          title: post.post_type,
          "project-type": "book",
          author: "",
          tags: [],
          "project-slug": post.post_type,
          "description-short": "",
          "description-long": "",
        };

    const doc = postToDoc(post, project);

    this.db.db
      .prepare(
        `
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
      `,
      )
      .run(doc);

    const row = this.db.db
      .prepare(
        "SELECT id, title, authors, excerpt, content FROM documents WHERE wp_id = ?",
      )
      .get(wpId) as
      | {
          id: number;
          title: string;
          authors: string;
          excerpt: string;
          content: string;
        }
      | undefined;

    if (row) await this.embedSingleDoc(row);
  }

  deletePost(wpId: number): void {
    const row = this.db.db
      .prepare("SELECT id FROM documents WHERE wp_id = ?")
      .get(wpId);
    if (!row)
      throw new NotFoundException(`Document with wp_id ${wpId} not in index`);

    this.db.db
      .prepare(
        "DELETE FROM embeddings WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)",
      )
      .run(wpId);
    this.db.db
      .prepare(
        "DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE wp_id = ?)",
      )
      .run(wpId);
    this.db.db.prepare("DELETE FROM documents WHERE wp_id = ?").run(wpId);
  }

  // ── Embedding phase ────────────────────────────────────────────────────────

  private async runEmbeddingPhase(): Promise<void> {
    const rows = this.db.db
      .prepare("SELECT id, title, authors, excerpt, content FROM documents")
      .all() as Array<{
      id: number;
      title: string;
      authors: string;
      excerpt: string;
      content: string;
    }>;

    const docJobs: Array<{ documentId: number; text: string }> = [];
    const chunkJobs: Array<{
      documentId: number;
      index: number;
      text: string;
      embedText: string;
    }> = [];

    for (const row of rows) {
      const authorNames = safeJsonArray(row.authors).join(", ");

      const docLike = {
        title: row.title,
        authors: authorNames,
        excerpt: row.excerpt ?? "",
        content: row.content ?? "",
      };

      if (classifyDoc(docLike) === "single") {
        const text = [row.title, authorNames, row.excerpt, row.content]
          .filter(Boolean)
          .join("\n")
          .slice(0, TRUNCATE_LENGTH);

        docJobs.push({ documentId: row.id, text });
      } else {
        chunkJobs.push(...buildChunks({ ...docLike, documentId: row.id }));
      }
    }

    const insertEmbed = this.db.db.prepare(
      "INSERT OR REPLACE INTO embeddings (document_id, embedding) VALUES (?, ?)",
    );

    const insertChunk = this.db.db.prepare(
      "INSERT INTO chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)",
    );

    // Docs
    const docVectors = await this.embeddings.embedAll(
      docJobs.map((j) => j.text),
    );

    for (let i = 0; i < docJobs.length; i++) {
      const job = docJobs[i];
      const v = docVectors[i];

      if (!job || v == null) continue;

      insertEmbed.run(job.documentId, float32ToBuffer(new Float32Array(v)));
    }

    // Chunks
    const chunkVectors = await this.embeddings.embedAll(
      chunkJobs.map((j) => j.embedText),
    );

    for (let i = 0; i < chunkJobs.length; i++) {
      const j = chunkJobs[i];
      const v = chunkVectors[i];

      if (!j || v == null) continue;

      insertChunk.run(
        j.documentId,
        j.index,
        j.text,
        float32ToBuffer(new Float32Array(v)),
      );
    }
  }

  private async embedSingleDoc(row: {
    id: number;
    title: string;
    authors: string;
    excerpt: string;
    content: string;
  }): Promise<void> {
    const authorNames = safeJsonArray(row.authors).join(", ");

    const docLike = {
      title: row.title,
      authors: authorNames,
      excerpt: row.excerpt ?? "",
      content: row.content ?? "",
    };

    this.db.db
      .prepare("DELETE FROM embeddings WHERE document_id = ?")
      .run(row.id);
    this.db.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(row.id);

    try {
      if (classifyDoc(docLike) === "single") {
        const text = [row.title, authorNames, row.excerpt, row.content]
          .filter(Boolean)
          .join("\n")
          .slice(0, TRUNCATE_LENGTH);

        const vectors = await this.embeddings.embedBatch([text]);
        const vector = vectors[0];

        if (!vector) return;

        this.db.db
          .prepare(
            "INSERT INTO embeddings (document_id, embedding) VALUES (?, ?)",
          )
          .run(row.id, float32ToBuffer(new Float32Array(vector)));
      } else {
        const chunks = buildChunks({ ...docLike, documentId: row.id });

        const vectors = await this.embeddings.embedBatch(
          chunks.map((c) => c.embedText),
        );

        const insertChunk = this.db.db.prepare(
          "INSERT INTO chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)",
        );

        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const v = vectors[i];

          if (!c || !v) continue;

          insertChunk.run(
            c.documentId,
            c.index,
            c.text,
            float32ToBuffer(new Float32Array(v)),
          );
        }
      }
    } catch {
      this.logger.warn(`Failed to embed document ${row.id}`);
    }
  }

  private buildVocabulary(): void {
    const rows = this.db.db
      .prepare("SELECT title, excerpt, content FROM documents")
      .all() as Array<{ title: string; excerpt: string; content: string }>;

    const freq = new Map<string, number>();

    for (const row of rows) {
      const text = [row.title, row.excerpt, row.content]
        .filter(Boolean)
        .join(" ");

      for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (word.length >= 3) {
          freq.set(word, (freq.get(word) ?? 0) + 1);
        }
      }
    }

    const insert = this.db.db.prepare(
      "INSERT OR REPLACE INTO vocabulary (term, freq) VALUES (?, ?)",
    );

    const tx = this.db.db.transaction(() => {
      for (const [term, count] of freq) {
        insert.run(term, count);
      }
    });

    tx();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function parallelLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        await fn(item);
      }
    },
  );

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
