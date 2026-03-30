import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { SearchResult } from '../shared/types';

const TTL_MS = 60 * 60 * 1_000; // 1 hour

interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
}

@Injectable()
export class CacheService {
  private readonly store = new Map<string, CacheEntry>();

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  get(key: string): SearchResult[] | undefined {
    const h = this.hash(key);
    const entry = this.store.get(h);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(h);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[]): void {
    const h = this.hash(key);
    this.store.set(h, { results, expiresAt: Date.now() + TTL_MS });
  }

  clear(): void {
    this.store.clear();
  }
}
