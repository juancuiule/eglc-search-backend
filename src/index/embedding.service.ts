import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";

// ── Constants ────────────────────────────────────────────────────────────────
export const CHUNK_THRESHOLD = 28_668;
export const TRUNCATE_LENGTH = 20_000;
export const CHUNK_SIZE = 1_400;
export const CHUNK_OVERLAP = 175;

const EMBED_MODEL = "text-embedding-3-small";
const MAX_TOKENS_PER_BATCH = 8_000;
const MAX_TOKENS_PER_ITEM = 7_500;       // hard cap per single input text
const CONCURRENCY = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Chunking & classification ───────────────────────────────────────────────

// ── Buffer helpers ──────────────────────────────────────────────────────────

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(
    arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength),
  );
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface DocLike {
  title: string;
  authors: string;
  excerpt: string;
  content: string | null;
}

function fullText(doc: DocLike): string {
  return [doc.title, doc.authors, doc.excerpt, doc.content]
    .filter(Boolean)
    .join("\n");
}

export function classifyDoc(doc: DocLike): "single" | "chunked" {
  return fullText(doc).length < CHUNK_THRESHOLD ? "single" : "chunked";
}

export interface ChunkJob {
  documentId: number;
  index: number;
  text: string;
  embedText: string;
}

export function buildChunks(doc: {
  title: string;
  authors: string;
  content: string | null;
  excerpt?: string;
  documentId?: number;
}): ChunkJob[] {
  const content = doc.content ?? "";
  const prefix = `Título: ${doc.title}\nAutores: ${doc.authors}\n\n`;

  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  const chunks: ChunkJob[] = [];

  let start = 0;

  while (start < content.length) {
    const text = content.slice(start, start + CHUNK_SIZE);

    chunks.push({
      documentId: doc.documentId ?? 0,
      index: chunks.length,
      text,
      embedText: prefix + text,
    });

    start += step;
  }

  // edge case: empty content
  if (chunks.length === 0) {
    const fallback = doc.excerpt ?? '';
    chunks.push({
      documentId: doc.documentId ?? 0,
      index: 0,
      text: fallback,
      embedText: prefix + fallback,
    });
  }

  return chunks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);   // conservative for Spanish Unicode (was / 4)
}

function buildTokenBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;

  for (let text of texts) {
    // Per-item hard cap: truncate silently if individual text exceeds limit
    if (estimateTokens(text) > MAX_TOKENS_PER_ITEM) {
      text = text.slice(0, MAX_TOKENS_PER_ITEM * 3);
    }

    const t = estimateTokens(text);

    if (tokens + t > MAX_TOKENS_PER_BATCH && current.length > 0) {
      batches.push(current);
      current = [];
      tokens = 0;
    }

    current.push(text);
    tokens += t;
  }

  if (current.length) batches.push(current);

  return batches;
}

async function parallelLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
) {
  const queue = items.map((item, i) => ({ item, i }));

  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const { item, i } = queue.shift()!;
      await fn(item, i);
    }
  });

  await Promise.all(workers);
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    this.client = new OpenAI({
      apiKey: config.getOrThrow<string>("OPENAI_API_KEY"),
    });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await this.client.embeddings.create({
          model: EMBED_MODEL,
          input: texts,
        });
        return res.data.map((d) => d.embedding);
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          this.logger.warn(
            `Embed failed (attempt ${attempt + 1}), retrying...`,
          );
          await sleep(RETRY_DELAYS_MS[attempt]);
        } else {
          this.logger.error("Embed failed permanently", err);
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Token-safe + concurrency-limited embedding
   */
  async embedAll(texts: string[]): Promise<(number[] | null)[]> {
    const batches = buildTokenBatches(texts);
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    let offset = 0;
    const batchMeta = batches.map((b) => {
      const start = offset;
      offset += b.length;
      return { batch: b, start };
    });

    await parallelLimit(batchMeta, CONCURRENCY, async ({ batch, start }) => {
      try {
        const vectors = await this.embedBatch(batch);

        vectors.forEach((v, i) => {
          results[start + i] = v;
        });
      } catch {
        // already logged
      }
    });

    return results;
  }
}
