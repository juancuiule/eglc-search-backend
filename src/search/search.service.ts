import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  EmbeddingService,
  bufferToFloat32,
  cosineSimilarity,
} from "../index/embedding.service";
import { SearchResult } from "../shared/types";
import { CacheService } from "./cache.service";

const FTS5_FIELDS = [
  "title",
  "excerpt",
  "content",
  "authors",
  "author_bios",
  "tags",
  "project_title",
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
      this.logger.warn("Query embedding failed — using FTS5-only ranking");
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
        doc_type: row.doc_type as "project" | "post",
        project_slug: row.project_slug,
        project_title: row.project_title ?? "",
        project_type: row.project_type ?? "",
        title: row.title,
        slug: row.slug,
        permalink: row.permalink ?? "",
        excerpt: row.excerpt ?? "",
        authors: authorArr.join(","),
        tags: tagArr.length > 0 ? tagArr.join(",") : null,
        image_url: row.image_url,
        rank: finalScore,
        snippet_content: row.snippet_content ?? "",
        snippet_excerpt: row.snippet_excerpt ?? "",
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
      this.logger.warn("FTS5 query failed", err);
      return [];
    }
  }

  private cosineForDoc(docId: number, queryEmbedding: Float32Array): number {
    const embRow = this.db.db
      .prepare("SELECT embedding FROM embeddings WHERE document_id = ?")
      .get(docId) as { embedding: Buffer } | undefined;

    if (embRow) {
      return cosineSimilarity(queryEmbedding, bufferToFloat32(embRow.embedding));
    }

    const chunkRows = this.db.db
      .prepare("SELECT embedding FROM chunks WHERE document_id = ?")
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
