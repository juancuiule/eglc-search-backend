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
  ): Promise<{
    results: SearchResult[];
    total: number;
  }> {
    const cached = this.cache.get(query);
    if (cached)
      return {
        results: cached.slice(skip, skip + limit),
        total: cached.length,
      };

    // 1. FTS5 match — early return if no results
    const ftsRows = this.runFts(query);
    if (ftsRows.length === 0) {
      this.cache.set(query, []);
      return { results: [], total: 0 };
    }

    // 2. Compute query embedding (only when FTS has results)
    let queryEmbedding: Float32Array | null = null;
    try {
      const [vec] = await this.embeddingService.embedBatch([
        query.trim().toLowerCase(),
      ]);
      queryEmbedding = new Float32Array(vec);
    } catch {
      this.logger.warn("Query embedding failed — using FTS5-only ranking");
    }

    // 3. Normalize BM25 scores (rank is negative; lower = more relevant) — queryEmbedding already computed above
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

    // 5. Build SearchResult[]
    const results: SearchResult[] = scored.map(({ row, finalScore }) => {
      const { snippetContent, snippetExcerpt, matchedFields } =
        this.getSnippets(row.id, query);
      const authorArr: string[] = safeJsonArray(row.authors);
      const tagArr: string[] = safeJsonArray(row.tags);

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
        snippet_content: snippetContent,
        snippet_excerpt: snippetExcerpt,
        matchedFields,
      };
    });

    this.cache.set(query, results);
    return { results: results.slice(skip, skip + limit), total: scored.length };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private runFts(query: string): FtsRow[] {
    try {
      return this.db.db
        .prepare(
          `
          SELECT
            d.id, d.doc_type, d.project_slug, d.project_title, d.project_type,
            d.title, d.slug, d.permalink, d.excerpt, d.authors,
            d.tags, d.image_url,
            bm25(documents_fts, 50, 8, 1, 4, 0.5, 6, 3) as rank,
            snippet(documents_fts, 2, '<mark>', '</mark>', '…', 30) as snippet_content,
            snippet(documents_fts, 1, '<mark>', '</mark>', '…', 30) as snippet_excerpt,
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
        .all(query.trim().toLowerCase()) as FtsRow[];
    } catch {
      return [];
    }
  }

  private cosineForDoc(docId: number, queryEmbedding: Float32Array): number {
    const embRow = this.db.db
      .prepare("SELECT embedding FROM embeddings WHERE document_id = ?")
      .get(docId) as { embedding: Buffer } | undefined;

    if (embRow) {
      return cosineSimilarity(
        queryEmbedding,
        bufferToFloat32(embRow.embedding),
      );
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

  private getSnippets(
    docId: number,
    query: string,
  ): {
    snippetContent: string;
    snippetExcerpt: string;
    matchedFields: string[];
  } {
    try {
      const row = this.db.db
        .prepare(
          `
          SELECT
            snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snip_content,
            snippet(documents_fts, 1, '<mark>', '</mark>', '...', 64) as snip_excerpt
          FROM documents_fts
          WHERE documents_fts MATCH ? AND rowid = ?
        `,
        )
        .get(query.trim().toLowerCase(), docId) as
        | { snip_content: string; snip_excerpt: string }
        | undefined;

      const matchedFields = this.getMatchedFields(docId, query);

      return {
        snippetContent: row?.snip_content ?? "",
        snippetExcerpt: row?.snip_excerpt ?? "",
        matchedFields,
      };
    } catch {
      return { snippetContent: "", snippetExcerpt: "", matchedFields: [] };
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
