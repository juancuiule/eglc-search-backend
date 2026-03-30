import { CacheService } from '../../src/search/cache.service';

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => { cache = new CacheService(); });

  it('returns undefined for a cache miss', () => {
    expect(cache.get('some query')).toBeUndefined();
  });

  it('returns cached value for a cache hit', () => {
    const results = [{ id: 1 }] as any;
    cache.set('hello world', results);
    expect(cache.get('hello world')).toEqual(results);
  });

  it('uses the key as-is — no normalization, caller must normalize', () => {
    cache.set('hello world', [{ id: 1 }] as any);
    expect(cache.get('hello world')).toBeDefined();
    // different casing is a cache miss — caller is responsible
    expect(cache.get('Hello World')).toBeUndefined();
    expect(cache.get('  hello world  ')).toBeUndefined();
  });

  it('returns undefined for expired entries', async () => {
    jest.useFakeTimers();
    cache.set('test', [{ id: 1 }] as any);
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(cache.get('test')).toBeUndefined();
    jest.useRealTimers();
  });

  it('clear() removes all entries', () => {
    cache.set('query1', [{ id: 1 }] as any);
    cache.set('query2', [{ id: 2 }] as any);
    cache.clear();
    expect(cache.get('query1')).toBeUndefined();
    expect(cache.get('query2')).toBeUndefined();
  });
});
