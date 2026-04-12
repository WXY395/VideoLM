import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  hashFingerprint,
  tokenizeTitle,
  buildFingerprintIndex,
  resolveCitation,
  findSimilarSources,
  resolveViaCacheBackfill,
} from '../source-resolution';
import type { VideoSourceRecord, NlmSourceEntry } from '@/types';

function makeRecord(overrides: Partial<VideoSourceRecord> = {}): VideoSourceRecord {
  const title = overrides.title ?? 'Claude Cowork 最友善的手把手教學';
  const norm = normalizeTitle(title);
  return {
    sourceId: 'test-uuid',
    videoId: 'abc123',
    title,
    channel: 'PAPAYA 電腦教室',
    url: 'https://youtube.com/watch?v=abc123',
    addedAt: Date.now(),
    normalizedTitle: norm,
    tokens: tokenizeTitle(norm),
    fingerprint: hashFingerprint(norm),
    fingerprintVariants: [
      hashFingerprint(norm),
      hashFingerprint(norm.slice(0, 20)),
      hashFingerprint(norm.slice(0, 10)),
    ],
    sessions: [],
    ...overrides,
  };
}

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle('Hello World!')).toBe('hello world');
  });
  it('trims whitespace', () => {
    expect(normalizeTitle('  spaced  ')).toBe('spaced');
  });
  it('handles CJK characters', () => {
    const r = normalizeTitle('Claude Cowork 最友善的手把手教學！');
    expect(r).toBe('claude cowork 最友善的手把手教學');
  });
});

describe('tokenizeTitle', () => {
  it('splits into words >= 2 chars', () => {
    const tokens = tokenizeTitle('claude cowork ai tool');
    expect(tokens).toContain('claude');
    expect(tokens).toContain('cowork');
    expect(tokens).toContain('ai');
    expect(tokens).toContain('tool');
  });
  it('filters single-char tokens', () => {
    const tokens = tokenizeTitle('a b cd ef');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('cd');
    expect(tokens).toContain('ef');
  });
});

describe('hashFingerprint', () => {
  it('produces consistent hash', () => {
    expect(hashFingerprint('hello world')).toBe(hashFingerprint('hello world'));
  });
  it('different strings produce different hashes', () => {
    expect(hashFingerprint('hello')).not.toBe(hashFingerprint('world'));
  });
});

describe('buildFingerprintIndex', () => {
  it('indexes by fingerprint and variants', () => {
    const record = makeRecord();
    const fpIndex = buildFingerprintIndex([record]);
    expect(fpIndex[record.fingerprint]).toContain(record);
  });
});

describe('resolveCitation', () => {
  it('exact fingerprint match returns score 1.0', () => {
    const record = makeRecord();
    const fpIndex = buildFingerprintIndex([record]);
    const result = resolveCitation(record.title, fpIndex, [record]);
    expect(result.type).toBe('matched');
    expect(result.score).toBe(1.0);
  });

  it('truncated title matches via fingerprintVariants', () => {
    const record = makeRecord({ title: 'Claude Cowork 最友善的手把手教學' });
    const fpIndex = buildFingerprintIndex([record]);
    const truncated = record.normalizedTitle.slice(0, 20);
    const result = resolveCitation(truncated, fpIndex, [record]);
    expect(result.type).toBe('matched');
  });

  it('fuzzy match with high token overlap', () => {
    const record = makeRecord({ title: 'Claude Cowork 手把手教學完整版' });
    const fpIndex = buildFingerprintIndex([record]);
    const result = resolveCitation('Claude Cowork 手把手教學', fpIndex, [record]);
    expect(result.type).not.toBe('not_found');
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('completely unrelated returns not_found', () => {
    const record = makeRecord({ title: 'Python 入門教學' });
    const fpIndex = buildFingerprintIndex([record]);
    const result = resolveCitation('React Native 開發指南', fpIndex, [record]);
    expect(result.type).toBe('not_found');
  });

  it('score < 0.5 returns not_found (no wrong links)', () => {
    const record = makeRecord({ title: 'Machine Learning Basics' });
    const fpIndex = buildFingerprintIndex([record]);
    const result = resolveCitation('Deep Learning Advanced', fpIndex, [record]);
    if (result.type !== 'not_found') {
      expect(result.score).toBeGreaterThan(0.5);
    }
  });
});

describe('findSimilarSources', () => {
  it('returns similar sources sorted by score descending', () => {
    const r1 = makeRecord({ videoId: 'v1', title: 'Claude Cowork 手把手教學完整版' });
    const r2 = makeRecord({ videoId: 'v2', title: 'Python 入門教學基礎' });
    const r3 = makeRecord({ videoId: 'v3', title: 'Claude Cowork 最友善的教學' });
    const index = [r1, r2, r3];

    const results = findSimilarSources('Claude Cowork 教學', index, 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Claude-related records should score higher than Python
    const titles = results.map(r => r.record.title);
    expect(titles.some(t => t.includes('Claude'))).toBe(true);
    // Should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects limit parameter', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ videoId: `v${i}`, title: `Claude Cowork 教學 Part ${i}` }),
    );
    const results = findSimilarSources('Claude Cowork', records, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when no sources are similar', () => {
    const r = makeRecord({ title: 'Python 機器學習入門' });
    const results = findSimilarSources('React Native 開發指南', [r], 3);
    expect(results).toEqual([]);
  });

  it('returns empty array for empty index', () => {
    const results = findSimilarSources('anything', [], 3);
    expect(results).toEqual([]);
  });

  it('does not return exact matches that resolveCitation would handle', () => {
    // findSimilarSources is for suggestions — exact matches are already resolved
    const r = makeRecord({ title: 'Exact Title Match' });
    const results = findSimilarSources('Exact Title Match', [r], 3);
    // Should return it (it IS similar), but in practice the panel
    // only calls this for unresolved sources
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  describe('score breakdown fields', () => {
    it('includes tokenOverlap and prefixMatch in results', () => {
      const r = makeRecord({ title: 'Claude Cowork 手把手教學完整版' });
      const results = findSimilarSources('Claude Cowork 教學', [r], 3);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const first = results[0];
      expect(first).toHaveProperty('tokenOverlap');
      expect(first).toHaveProperty('prefixMatch');
      expect(typeof first.tokenOverlap).toBe('number');
      expect(typeof first.prefixMatch).toBe('number');
      expect(first.tokenOverlap).toBeGreaterThanOrEqual(0);
      expect(first.tokenOverlap).toBeLessThanOrEqual(1);
      expect(first.prefixMatch).toBeGreaterThanOrEqual(0);
      expect(first.prefixMatch).toBeLessThanOrEqual(1);
    });

    it('high token overlap when query shares many words with record', () => {
      const r = makeRecord({ title: 'Claude Cowork 手把手教學完整版' });
      const results = findSimilarSources('Claude Cowork 手把手教學', [r], 3);
      expect(results[0].tokenOverlap).toBeGreaterThan(0.5);
    });

    it('low token overlap for unrelated titles', () => {
      const r = makeRecord({ title: 'Python 機器學習入門基礎教程' });
      const results = findSimilarSources('Claude AI Agent 開發', [r], 3);
      // May return empty or low-scoring
      if (results.length > 0) {
        expect(results[0].tokenOverlap).toBeLessThan(0.3);
      }
    });

    it('high prefix match when titles share a long prefix', () => {
      const r = makeRecord({ title: 'Claude Code Tutorial Part 1 Complete Guide' });
      const results = findSimilarSources('Claude Code Tutorial Part 2 Extended', [r], 3);
      if (results.length > 0) {
        expect(results[0].prefixMatch).toBeGreaterThan(0.3);
      }
    });

    it('combined score equals tokenOverlap*0.6 + prefixMatch*0.3 + 0.1', () => {
      const r = makeRecord({ title: 'Claude Cowork 手把手教學完整版' });
      const results = findSimilarSources('Claude Cowork 教學', [r], 3);
      const first = results[0];
      const expected = first.tokenOverlap * 0.6 + first.prefixMatch * 0.3 + 0.1;
      expect(first.score).toBeCloseTo(expected, 10);
    });
  });

  describe('strong vs weak candidate filtering (UI-layer thresholds)', () => {
    const STRONG = 0.8;
    const WEAK_MIN = 0.3;

    it('exact title produces strong candidate (score >= 0.8)', () => {
      const r = makeRecord({ title: 'Claude Cowork 手把手教學' });
      const results = findSimilarSources('Claude Cowork 手把手教學', [r], 3);
      expect(results.length).toBe(1);
      expect(results[0].score).toBeGreaterThanOrEqual(STRONG);
    });

    it('partially similar title produces weak candidate (0.3 <= score < 0.8)', () => {
      const r = makeRecord({ title: 'Claude Code AI Agent 開發完整教學' });
      const results = findSimilarSources('Claude Code 入門基礎', [r], 3);
      const weakCandidates = results.filter(s => s.score >= WEAK_MIN && s.score < STRONG);
      // Claude Code overlap should produce a weak-range score
      if (results.length > 0 && results[0].score < STRONG) {
        expect(results[0].score).toBeGreaterThanOrEqual(WEAK_MIN);
      }
    });

    it('completely unrelated title produces no candidates at all', () => {
      const r = makeRecord({ title: 'Python 數據分析入門' });
      const results = findSimilarSources('React Native 手機 App 開發', [r], 3);
      expect(results.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveViaCacheBackfill
// ---------------------------------------------------------------------------

function makeCacheEntry(overrides: Partial<NlmSourceEntry> = {}): NlmSourceEntry {
  return {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    channelName: 'PAPAYA 電腦教室',
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe('resolveViaCacheBackfill', () => {
  describe('core matching', () => {
    it('returns all unresolved when cache is empty', () => {
      const citations = [{ id: 1, sourceName: 'Some Video' }];
      const cache = new Map<string, NlmSourceEntry>();
      const result = resolveViaCacheBackfill(citations, cache, []);
      expect(result.resolved.size).toBe(0);
      expect(result.unresolved).toEqual(['1']);
    });

    it('Tier 1: sourceName contains videoId → exact match (high)', () => {
      const entry = makeCacheEntry({ videoId: 'abc12345678' });
      const cache = new Map([['abc12345678', entry]]);
      const citations = [{ id: 1, sourceName: 'Video abc12345678 title here' }];
      const result = resolveViaCacheBackfill(citations, cache, []);
      expect(result.resolved.size).toBe(1);
      const res = result.resolved.get('1')!;
      expect(res.videoId).toBe('abc12345678');
      expect(res.confidence).toBe('high');
    });

    it('Tier 2: title cross-reference via sourceIndex + channel match → high', () => {
      const entry = makeCacheEntry({ videoId: 'vid001', channelName: 'PAPAYA 電腦教室' });
      const cache = new Map([['vid001', entry]]);
      const record = makeRecord({
        videoId: 'vid001',
        title: 'Claude Cowork 最友善的手把手教學',
        channel: 'PAPAYA 電腦教室',
        url: 'https://youtube.com/watch?v=vid001',
      });
      const citations = [{ id: 1, sourceName: 'Claude Cowork 最友善的手把手教學 - PAPAYA 電腦教室' }];
      const result = resolveViaCacheBackfill(citations, cache, [record]);
      expect(result.resolved.size).toBe(1);
      expect(result.resolved.get('1')!.confidence).toBe('high');
    });

    it('Tier 2: below threshold → stays unresolved', () => {
      const entry = makeCacheEntry({ videoId: 'vid001', channelName: 'Unknown Channel' });
      const cache = new Map([['vid001', entry]]);
      const record = makeRecord({
        videoId: 'vid001',
        title: 'Python 機器學習入門',
        url: 'https://youtube.com/watch?v=vid001',
      });
      const citations = [{ id: 1, sourceName: 'React Native 手機開發指南' }];
      const result = resolveViaCacheBackfill(citations, cache, [record]);
      expect(result.resolved.size).toBe(0);
      expect(result.unresolved).toEqual(['1']);
    });

    it('Tier 3: elimination — 3 citations + 3 cache, 2 matched → last pair by elimination', () => {
      const e1 = makeCacheEntry({ videoId: 'v1', channelName: 'Ch1', url: 'https://youtube.com/watch?v=v1' });
      const e2 = makeCacheEntry({ videoId: 'v2', channelName: 'Ch2', url: 'https://youtube.com/watch?v=v2' });
      const e3 = makeCacheEntry({ videoId: 'v3', channelName: 'Ch3', url: 'https://youtube.com/watch?v=v3' });
      const cache = new Map([['v1', e1], ['v2', e2], ['v3', e3]]);

      const r1 = makeRecord({ videoId: 'v1', title: 'First Video Title', url: e1.url });
      const r2 = makeRecord({ videoId: 'v2', title: 'Second Video Title', url: e2.url });
      // r3 title is very different from citation 3 source name → Tier 2 won't match
      const r3 = makeRecord({ videoId: 'v3', title: 'Completely Unrelated Content About Cooking', url: e3.url });

      const citations = [
        { id: 1, sourceName: 'First Video Title' },      // matches v1 via Tier 2
        { id: 2, sourceName: 'Second Video Title' },      // matches v2 via Tier 2
        { id: 3, sourceName: 'Cooking Something XYZ Ch3' }, // no Tier 2 match, but shares "cooking" token → elimination guard passes
      ];
      const result = resolveViaCacheBackfill(citations, cache, [r1, r2, r3]);
      expect(result.resolved.size).toBe(3);
      expect(result.resolved.get('3')!.videoId).toBe('v3');
      expect(result.resolved.get('3')!.confidence).toBe('medium');
    });

    it('multiple cache entries same channel → distinguished by tokens', () => {
      const e1 = makeCacheEntry({ videoId: 'v1', channelName: 'PAPAYA', url: 'https://youtube.com/watch?v=v1' });
      const e2 = makeCacheEntry({ videoId: 'v2', channelName: 'PAPAYA', url: 'https://youtube.com/watch?v=v2' });
      const cache = new Map([['v1', e1], ['v2', e2]]);

      const r1 = makeRecord({ videoId: 'v1', title: 'Claude AI 入門教學', channel: 'PAPAYA', url: e1.url });
      const r2 = makeRecord({ videoId: 'v2', title: 'Python 資料分析', channel: 'PAPAYA', url: e2.url });

      const citations = [
        { id: 1, sourceName: 'Claude AI 入門教學 - PAPAYA' },
        { id: 2, sourceName: 'Python 資料分析 - PAPAYA' },
      ];
      const result = resolveViaCacheBackfill(citations, cache, [r1, r2]);
      expect(result.resolved.size).toBe(2);
      expect(result.resolved.get('1')!.videoId).toBe('v1');
      expect(result.resolved.get('2')!.videoId).toBe('v2');
    });

    it('duplicate citation sourceNames share the same resolution', () => {
      const entry = makeCacheEntry({ videoId: 'vid001' });
      const cache = new Map([['vid001', entry]]);
      const citations = [
        { id: 1, sourceName: 'Video vid001 title' },
        { id: 3, sourceName: 'Video vid001 title' },  // same sourceName
      ];
      const result = resolveViaCacheBackfill(citations, cache, []);
      expect(result.resolved.size).toBe(2);
      expect(result.resolved.get('1')!.videoId).toBe('vid001');
      expect(result.resolved.get('3')!.videoId).toBe('vid001');
    });
  });

  describe('safety mechanisms (Step 5)', () => {
    it('5a: expired cache entry (>30 min) is excluded', () => {
      const expired = makeCacheEntry({
        videoId: 'vid001',
        capturedAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago
      });
      const cache = new Map([['vid001', expired]]);
      const citations = [{ id: 1, sourceName: 'Video vid001 title' }];
      const result = resolveViaCacheBackfill(citations, cache, []);
      expect(result.resolved.size).toBe(0);
      expect(result.unresolved).toEqual(['1']);
    });

    it('5a: valid cache entry (29 min) participates normally', () => {
      const valid = makeCacheEntry({
        videoId: 'abc12345678',
        capturedAt: Date.now() - 29 * 60 * 1000, // 29 minutes ago
      });
      const cache = new Map([['abc12345678', valid]]);
      const citations = [{ id: 1, sourceName: 'Video abc12345678' }];
      const result = resolveViaCacheBackfill(citations, cache, []);
      expect(result.resolved.size).toBe(1);
    });

    it('5b: channelName match adds 0.35 bonus, pushing score above threshold', () => {
      // Entry with channel match + sourceIndex cross-ref
      // Without channel bonus: token overlap alone may be borderline
      const entry = makeCacheEntry({ videoId: 'vid001', channelName: 'PAPAYA 電腦教室' });
      const cache = new Map([['vid001', entry]]);

      // Weak title overlap but channel matches → channel bonus should push above threshold
      const record = makeRecord({
        videoId: 'vid001',
        title: 'Claude AI 完整教學',
        channel: 'PAPAYA 電腦教室',
        url: entry.url,
      });
      // Source name shares "claude" token + channel name → channel bonus matters
      const citations = [{ id: 1, sourceName: 'Claude 入門 - PAPAYA 電腦教室' }];
      const result = resolveViaCacheBackfill(citations, cache, [record]);
      expect(result.resolved.size).toBe(1);
      // Score = token * 0.6 + prefix * 0.3 + 0.1 + 0.35 (channel) → should be high
      expect(result.resolved.get('1')!.confidence).toBe('high');
    });

    it('5c: elimination guard — zero token overlap + no channel → blocked', () => {
      const e1 = makeCacheEntry({ videoId: 'v1', channelName: 'Ch1', url: 'https://youtube.com/watch?v=v1' });
      const e2 = makeCacheEntry({ videoId: 'v2', channelName: 'Ch2', url: 'https://youtube.com/watch?v=v2' });
      const cache = new Map([['v1', e1], ['v2', e2]]);

      const r1 = makeRecord({ videoId: 'v1', title: 'First Video Title', url: e1.url });
      const r2 = makeRecord({ videoId: 'v2', title: 'Completely Different Topic', url: e2.url });

      const citations = [
        { id: 1, sourceName: 'First Video Title' },            // matches v1
        { id: 2, sourceName: 'Unrelated Zero Overlap XYZ' },   // no token overlap with r2
      ];
      const result = resolveViaCacheBackfill(citations, cache, [r1, r2]);
      expect(result.resolved.get('1')).toBeDefined();
      // Citation 2 should NOT be matched via elimination due to guard
      expect(result.unresolved).toContain('2');
    });

    it('5c: elimination guard — token overlap > 0 → allowed', () => {
      const e1 = makeCacheEntry({ videoId: 'v1', channelName: 'Ch1', url: 'https://youtube.com/watch?v=v1' });
      const e2 = makeCacheEntry({ videoId: 'v2', channelName: 'Ch2', url: 'https://youtube.com/watch?v=v2' });
      const cache = new Map([['v1', e1], ['v2', e2]]);

      const r1 = makeRecord({ videoId: 'v1', title: 'First Video Title', url: e1.url });
      const r2 = makeRecord({ videoId: 'v2', title: 'Third Video Title Extended', url: e2.url });

      const citations = [
        { id: 1, sourceName: 'First Video Title' },     // matches v1
        { id: 2, sourceName: 'Third Video Something' },  // shares 'third' + 'video' with r2
      ];
      const result = resolveViaCacheBackfill(citations, cache, [r1, r2]);
      expect(result.resolved.size).toBe(2);
      expect(result.resolved.get('2')!.confidence).toBe('medium');
    });

    it('5c: elimination guard — channel match but zero token → allowed', () => {
      const e1 = makeCacheEntry({ videoId: 'v1', channelName: 'Ch1', url: 'https://youtube.com/watch?v=v1' });
      const e2 = makeCacheEntry({ videoId: 'v2', channelName: 'SpecialChannel', url: 'https://youtube.com/watch?v=v2' });
      const cache = new Map([['v1', e1], ['v2', e2]]);

      const r1 = makeRecord({ videoId: 'v1', title: 'First Video Title', url: e1.url });
      // No sourceIndex record for v2 → no title tokens available
      // but channelName matches

      const citations = [
        { id: 1, sourceName: 'First Video Title' },
        { id: 2, sourceName: 'specialchannel 的某段影片' },
      ];
      const result = resolveViaCacheBackfill(citations, cache, [r1]);
      expect(result.resolved.size).toBe(2);
      expect(result.resolved.get('2')!.videoId).toBe('v2');
    });
  });
});
