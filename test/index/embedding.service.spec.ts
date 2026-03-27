import {
  float32ToBuffer,
  bufferToFloat32,
  cosineSimilarity,
  classifyDoc,
  buildChunks,
} from '../../src/index/embedding.service';

describe('float32ToBuffer / bufferToFloat32', () => {
  it('round-trips a Float32Array', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.9]);
    const buf = float32ToBuffer(original);
    const recovered = bufferToFloat32(buf);
    expect(recovered.length).toBe(4);
    // float32 precision tolerance
    expect(Math.abs(recovered[0] - 0.1)).toBeLessThan(1e-6);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1);
  });
});

describe('classifyDoc', () => {
  it('classifies short doc as single', () => {
    const doc = { title: 'T', authors: '', excerpt: '', content: 'short' };
    expect(classifyDoc(doc)).toBe('single');
  });

  it('classifies doc over threshold as chunked', () => {
    const doc = { title: 'T', authors: '', excerpt: '', content: 'x'.repeat(30_000) };
    expect(classifyDoc(doc)).toBe('chunked');
  });

  it('uses total text length (title + authors + excerpt + content)', () => {
    const doc = {
      title: 'x'.repeat(10_000),
      authors: 'x'.repeat(10_000),
      excerpt: 'x'.repeat(9_000),
      content: 'x',
    };
    // total = 29_001 > threshold
    expect(classifyDoc(doc)).toBe('chunked');
  });
});

describe('buildChunks', () => {
  it('returns one chunk for content shorter than CHUNK_SIZE', () => {
    const doc = { title: 'Title', authors: 'Author', content: 'short content' };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(1);
  });

  it('includes all content when chunked', () => {
    const content = 'a'.repeat(3_000);
    const doc = { title: 'T', authors: 'A', content };
    const chunks = buildChunks(doc);
    const combined = chunks.map((c) => c.text).join('');
    expect(combined.length).toBeGreaterThanOrEqual(content.length);
  });

  it('each chunk embedText has the title/author prefix', () => {
    const doc = { title: 'My Title', authors: 'My Author', content: 'x'.repeat(2_000) };
    const chunks = buildChunks(doc);
    for (const chunk of chunks) {
      expect(chunk.embedText).toContain('My Title');
      expect(chunk.embedText).toContain('My Author');
    }
  });

  it('last chunk is included even if shorter than overlap', () => {
    const content = 'a'.repeat(1_450); // 1400 + 50 remainder
    const doc = { title: 'T', authors: 'A', content };
    const chunks = buildChunks(doc);
    expect(chunks.length).toBe(2);
  });
});
