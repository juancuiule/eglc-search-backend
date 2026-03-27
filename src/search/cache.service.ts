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

  private normalize(query: string): string {
    return query.trim().toLowerCase();
  }

  private hash(query: string): string {
    return createHash('sha256').update(this.normalize(query)).digest('hex');
  }

  get(query: string): SearchResult[] | undefined {
    const key = this.hash(query);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(query: string, results: SearchResult[]): void {
    const key = this.hash(query);
    this.store.set(key, { results, expiresAt: Date.now() + TTL_MS });
  }

  clear(): void {
    this.store.clear();
  }
}
