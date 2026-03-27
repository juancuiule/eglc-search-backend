import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

// ── Constants ────────────────────────────────────────────────────────────────
export const CHUNK_THRESHOLD = 28_668;
export const TRUNCATE_LENGTH = 24_000;
export const CHUNK_SIZE = 1_400;
export const CHUNK_OVERLAP = 175;
const EMBED_BATCH_SIZE = 100;
const EMBED_MODEL = 'text-embedding-3-small';
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface DocLike { title: string; authors: string; excerpt: string; content: string | null }

function fullText(doc: DocLike): string {
  return [doc.title, doc.authors, doc.excerpt, doc.content]
    .filter(Boolean)
    .join('\n');
}

export function classifyDoc(doc: DocLike): 'single' | 'chunked' {
  return fullText(doc).length < CHUNK_THRESHOLD ? 'single' : 'chunked';
}

export interface ChunkJob {
  documentId: number;
  index: number;
  text: string;       // raw chunk content (no prefix)
  embedText: string;  // prefixed text sent to OpenAI
}

export function buildChunks(
  doc: { title: string; authors: string; content: string | null; excerpt?: string; documentId?: number },
): ChunkJob[] {
  const content = doc.content ?? '';
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

  // edge case: empty content → one empty chunk so document gets an embedding
  if (chunks.length === 0) {
    chunks.push({ documentId: doc.documentId ?? 0, index: 0, text: '', embedText: prefix });
  }

  return chunks;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    this.client = new OpenAI({ apiKey: config.getOrThrow<string>('OPENAI_API_KEY') });
  }

  /** Embed a batch of texts with retry. Returns one vector per input text. */
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
          this.logger.warn(`OpenAI embed failed (attempt ${attempt + 1}), retrying...`);
          await sleep(RETRY_DELAYS_MS[attempt]);
        } else {
          this.logger.error('OpenAI embed failed after all retries', err);
          throw err;
        }
      }
    }
    throw new Error('unreachable');
  }

  /** Embed texts in batches of EMBED_BATCH_SIZE, running batches in parallel. */
  async embedAll(texts: string[]): Promise<(number[] | null)[]> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      batches.push(texts.slice(i, i + EMBED_BATCH_SIZE));
    }

    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    await Promise.all(
      batches.map(async (batch, bi) => {
        try {
          const vectors = await this.embedBatch(batch);
          vectors.forEach((v, vi) => {
            results[bi * EMBED_BATCH_SIZE + vi] = v;
          });
        } catch {
          // already logged in embedBatch; leave nulls in results
        }
      }),
    );

    return results;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
