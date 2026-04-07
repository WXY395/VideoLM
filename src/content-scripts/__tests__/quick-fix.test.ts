import { describe, it, expect } from 'vitest';
import { isYouTubeUrl, extractVideoIdFromUrl } from '@/utils/url-sanitizer';
import {
  createVideoSourceRecord,
  buildFingerprintIndex,
  resolveCitation,
} from '@/utils/source-resolution';
import type { CitationConfidence, CitationStatus } from '@/utils/notion-sync';

describe('Quick Fix data flow', () => {
  describe('URL validation gate', () => {
    it('blocks non-YouTube URLs from entering pipeline', () => {
      expect(isYouTubeUrl('https://vimeo.com/123')).toBe(false);
      expect(isYouTubeUrl('')).toBe(false);
      expect(isYouTubeUrl('random text')).toBe(false);
    });

    it('allows valid YouTube URLs', () => {
      expect(isYouTubeUrl('https://youtube.com/watch?v=abc123')).toBe(true);
      expect(isYouTubeUrl('https://youtu.be/abc123')).toBe(true);
    });
  });

  describe('store → re-resolve cycle', () => {
    it('newly stored record is findable by resolveCitation', () => {
      const record = createVideoSourceRecord('abc123', 'My Test Video', 'TestChannel', 'https://youtube.com/watch?v=abc123');
      const index = [record];
      const fpIndex = buildFingerprintIndex(index);

      const result = resolveCitation('My Test Video', fpIndex, index);
      expect(result.type).toBe('matched');
      expect(result.score).toBe(1.0);
      expect(result.record?.url).toBe('https://youtube.com/watch?v=abc123');
    });

    it('record with empty title still stores but may not match truncated NLM name', () => {
      const record = createVideoSourceRecord('xyz789', '', '', 'https://youtube.com/watch?v=xyz789');
      const index = [record];
      const fpIndex = buildFingerprintIndex(index);

      const result = resolveCitation('Some Video Title', fpIndex, index);
      expect(result.type).toBe('not_found');
    });

    it('does not interfere with existing records in the index', () => {
      const existing = createVideoSourceRecord('old1', 'Existing Video', 'Channel', 'https://youtube.com/watch?v=old1');
      const added = createVideoSourceRecord('new1', '', '', 'https://youtube.com/watch?v=new1');

      const index = [existing, added];
      const fpIndex = buildFingerprintIndex(index);

      const r1 = resolveCitation('Existing Video', fpIndex, index);
      expect(r1.type).toBe('matched');
      expect(r1.record?.videoId).toBe('old1');
    });
  });

  describe('user-provided source override (loop prevention)', () => {
    /**
     * Simulates the citationMap override logic from handleQuickFix.
     * This is extracted here because the real function is DOM-coupled,
     * but the data contract is testable independently.
     */
    function simulateOverrideLoop(
      fixingSourceName: string,
      userUrl: string,
      citations: { id: number; sourceName: string }[],
    ) {
      // Build source index with the user-provided record
      const record = createVideoSourceRecord(
        extractVideoIdFromUrl(userUrl) ?? 'unknown',
        fixingSourceName,
        '',
        userUrl,
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);

      const citationMap: Record<string, { url: string | null; confidence?: CitationConfidence; status?: CitationStatus }> = {};

      for (const csn of citations) {
        const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
        if (match.record?.url) {
          const algoConfidence: CitationConfidence = match.type === 'matched' ? 'high'
            : match.type === 'uncertain' ? 'medium'
            : 'low';
          citationMap[String(csn.id)] = { url: match.record.url, confidence: algoConfidence, status: 'resolved' };
        }

        // ── User-provided source override (same logic as handleQuickFix) ──
        const key = String(csn.id);
        if (!citationMap[key]?.url && csn.sourceName === fixingSourceName) {
          citationMap[key] = { url: userUrl, confidence: 'medium', status: 'resolved' };
        }
      }

      // Ensure every citation ID has an entry — unresolved get fallback
      // NEVER overrides existing entries
      for (const csn of citations) {
        const key = String(csn.id);
        if (citationMap[key] === undefined) {
          citationMap[key] = { url: null, confidence: 'low', status: 'unresolved' };
        }
      }

      return citationMap;
    }

    it('should not ask again after user provides source (no loop)', () => {
      // User fixed "Claude AI 深度教學" — after re-resolve, it should be in citationMap
      const citationMap = simulateOverrideLoop(
        'Claude AI 深度教學',
        'https://youtube.com/watch?v=abc123',
        [
          { id: 1, sourceName: 'Claude AI 深度教學' },
          { id: 2, sourceName: 'Claude AI 深度教學' }, // duplicate citation
        ],
      );

      // Both citation IDs referencing the same source should have URLs
      expect(citationMap['1']?.url).toBe('https://youtube.com/watch?v=abc123');
      expect(citationMap['2']?.url).toBe('https://youtube.com/watch?v=abc123');
    });

    it('should override previous unknown state with user-provided URL', () => {
      // Source name that algorithmic matching cannot resolve
      const unresolvedName = '完全無法匹配的來源名稱 XYZ';
      const citationMap = simulateOverrideLoop(
        unresolvedName,
        'https://youtube.com/watch?v=override1',
        [{ id: 5, sourceName: unresolvedName }],
      );

      // Even though resolveCitation returns not_found, user override kicks in
      expect(citationMap['5']).toBeDefined();
      expect(citationMap['5'].url).toBe('https://youtube.com/watch?v=override1');
    });

    it('should proceed even with low-confidence input', () => {
      // User provides URL for a source where token overlap is near-zero
      const citationMap = simulateOverrideLoop(
        'React Native 手機開發',
        'https://youtube.com/watch?v=lowconf',
        [
          { id: 10, sourceName: 'React Native 手機開發' },
          { id: 11, sourceName: 'Python 機器學習' }, // unrelated, should NOT get override
        ],
      );

      // The fixing source gets the URL
      expect(citationMap['10']?.url).toBe('https://youtube.com/watch?v=lowconf');
      // Unrelated citation gets fallback entry with null url (not the user-provided URL)
      expect(citationMap['11']).toBeDefined();
      expect(citationMap['11'].url).toBeNull();
      expect(citationMap['11'].status).toBe('unresolved');
    });

    it('does not override citations already resolved by algorithm', () => {
      // If resolveCitation already matched, the override should not overwrite
      const record = createVideoSourceRecord(
        'algo1',
        'Already Matched Video',
        'Channel',
        'https://youtube.com/watch?v=algo1',
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);

      const citationMap: Record<string, { url: string }> = {};
      const csn = { id: 1, sourceName: 'Already Matched Video' };
      const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);

      if (match.record?.url) {
        citationMap[String(csn.id)] = { url: match.record.url };
      }
      // Override check — should NOT replace since already resolved
      const key = String(csn.id);
      if (!citationMap[key]?.url && csn.sourceName === 'Already Matched Video') {
        citationMap[key] = { url: 'https://youtube.com/watch?v=WRONG' };
      }

      expect(citationMap['1'].url).toBe('https://youtube.com/watch?v=algo1');
    });
  });

  describe('confidence flag assignment', () => {
    it('assigns "high" confidence for algorithm-matched citations', () => {
      const record = createVideoSourceRecord(
        'v1', 'Claude AI 完整教學', 'Channel', 'https://youtube.com/watch?v=v1',
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);

      const citationMap: Record<string, { url: string; confidence?: CitationConfidence }> = {};
      const match = resolveCitation('Claude AI 完整教學', fpIndex, sourceIndex);
      if (match.record?.url) {
        const confidence: CitationConfidence = match.type === 'matched' ? 'high'
          : match.type === 'uncertain' ? 'medium' : 'low';
        citationMap['1'] = { url: match.record.url, confidence };
      }

      expect(match.type).toBe('matched');
      expect(citationMap['1'].confidence).toBe('high');
    });

    it('assigns "medium" confidence for user-override citations', () => {
      // Unresolvable source name — user override kicks in with 'medium'
      const record = createVideoSourceRecord(
        'v2', '完全不同的標題', '', 'https://youtube.com/watch?v=v2',
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);
      const fixingSourceName = '無法匹配的來源';

      const citationMap: Record<string, { url: string; confidence?: CitationConfidence }> = {};
      const csn = { id: 3, sourceName: fixingSourceName };
      const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
      if (match.record?.url) {
        citationMap[String(csn.id)] = { url: match.record.url, confidence: 'high' };
      }
      const key = String(csn.id);
      if (!citationMap[key]?.url && csn.sourceName === fixingSourceName) {
        citationMap[key] = { url: 'https://youtube.com/watch?v=user1', confidence: 'medium' };
      }

      expect(citationMap['3'].confidence).toBe('medium');
    });

    it('assigns "low" confidence for DOM-fallback citations', () => {
      // Simulate DOM-extracted href fallback
      const citationMap: Record<string, { url: string; confidence?: CitationConfidence }> = {};
      const hint = { id: 7, href: 'https://youtube.com/watch?v=dom1' };
      const key = String(hint.id);
      if (!citationMap[key]?.url && hint.href) {
        citationMap[key] = { url: hint.href, confidence: 'low' };
      }

      expect(citationMap['7'].confidence).toBe('low');
    });

    it('assigns "low" confidence with "unresolved" status for unresolved citations', () => {
      const record = createVideoSourceRecord(
        'v3', 'Python 教學', 'Ch', 'https://youtube.com/watch?v=v3',
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);

      const citationMap: Record<string, { url: string | null; confidence?: CitationConfidence; status?: CitationStatus }> = {};
      const csn = { id: 99, sourceName: 'React Native 開發指南' };
      const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
      if (match.record?.url) {
        citationMap[String(csn.id)] = { url: match.record.url, confidence: 'high', status: 'resolved' };
      }
      // Fallback for unresolved
      if (!citationMap[String(csn.id)]) {
        citationMap[String(csn.id)] = { url: null, confidence: 'low', status: 'unresolved' };
      }

      expect(match.type).toBe('not_found');
      expect(citationMap['99']).toBeDefined();
      expect(citationMap['99'].url).toBeNull();
      expect(citationMap['99'].confidence).toBe('low');
      expect(citationMap['99'].status).toBe('unresolved');
    });
  });

  describe('citationMap completeness (no missing entries)', () => {
    /**
     * Simulates the full citationMap construction with fallback entries,
     * mirroring the logic in both the main pipeline and handleQuickFix.
     */
    function buildCompleteCitationMap(
      citations: { id: number; sourceName: string }[],
      sourceIndex: ReturnType<typeof createVideoSourceRecord>[],
    ) {
      const fpIndex = buildFingerprintIndex(sourceIndex);
      const citationMap: Record<string, { url: string | null; confidence?: CitationConfidence; status?: CitationStatus }> = {};

      for (const csn of citations) {
        const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
        if (match.record?.url) {
          const confidence: CitationConfidence = match.type === 'matched' ? 'high'
            : match.type === 'uncertain' ? 'medium' : 'low';
          citationMap[String(csn.id)] = { url: match.record.url, confidence, status: 'resolved' };
        }
      }

      // Ensure every citation ID has an entry — NEVER overrides existing
      for (const csn of citations) {
        const key = String(csn.id);
        if (citationMap[key] === undefined) {
          citationMap[key] = { url: null, confidence: 'low', status: 'unresolved' };
        }
      }

      return citationMap;
    }

    it('existing url must never be replaced by fallback', () => {
      const record = createVideoSourceRecord(
        'v1', 'Claude AI 教學', 'Ch', 'https://youtube.com/watch?v=v1',
      );
      const citations = [
        { id: 1, sourceName: 'Claude AI 教學' },
        { id: 2, sourceName: '無法匹配的來源' },
      ];

      const citationMap = buildCompleteCitationMap(citations, [record]);

      // id 1: algorithm-resolved → must keep original url, NOT null
      expect(citationMap['1'].url).toBe('https://youtube.com/watch?v=v1');
      expect(citationMap['1'].confidence).toBe('high');
      expect(citationMap['1'].status).toBe('resolved');

      // id 2: unresolved → gets fallback
      expect(citationMap['2'].url).toBeNull();
      expect(citationMap['2'].confidence).toBe('low');
      expect(citationMap['2'].status).toBe('unresolved');

      // Run fallback sweep AGAIN to prove idempotency — must not overwrite
      for (const csn of citations) {
        const key = String(csn.id);
        if (citationMap[key] === undefined) {
          citationMap[key] = { url: null, confidence: 'low', status: 'unresolved' };
        }
      }

      // id 1 still intact after second sweep
      expect(citationMap['1'].url).toBe('https://youtube.com/watch?v=v1');
      expect(citationMap['1'].confidence).toBe('high');
    });

    it('should not produce missing citationMap entry', () => {
      const record = createVideoSourceRecord(
        'v1', 'Claude AI 教學', 'Ch', 'https://youtube.com/watch?v=v1',
      );
      const citations = [
        { id: 1, sourceName: 'Claude AI 教學' },      // will match
        { id: 2, sourceName: '完全不相關的來源' },       // will NOT match
        { id: 3, sourceName: '另一個無法匹配的來源' },   // will NOT match
      ];

      const citationMap = buildCompleteCitationMap(citations, [record]);

      // Every citation ID must have an entry — no gaps
      expect(citationMap['1']).toBeDefined();
      expect(citationMap['2']).toBeDefined();
      expect(citationMap['3']).toBeDefined();

      // Matched entry has url + resolved
      expect(citationMap['1'].url).toBe('https://youtube.com/watch?v=v1');
      expect(citationMap['1'].status).toBe('resolved');

      // Unmatched entries have null url + unresolved
      expect(citationMap['2'].url).toBeNull();
      expect(citationMap['2'].status).toBe('unresolved');
      expect(citationMap['3'].url).toBeNull();
      expect(citationMap['3'].status).toBe('unresolved');
    });

    it('all citation ids must exist in citationMap', () => {
      // Stress test: 10 citations, only 2 resolvable
      const records = [
        createVideoSourceRecord('v1', 'Python 入門', 'Ch', 'https://youtube.com/watch?v=v1'),
        createVideoSourceRecord('v2', 'React 基礎', 'Ch', 'https://youtube.com/watch?v=v2'),
      ];
      const citations = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        sourceName: i === 0 ? 'Python 入門' : i === 5 ? 'React 基礎' : `Unknown Source ${i}`,
      }));

      const citationMap = buildCompleteCitationMap(citations, records);

      // Every single ID from 1–10 must be present
      for (let i = 1; i <= 10; i++) {
        expect(citationMap[String(i)]).toBeDefined();
        expect(citationMap[String(i)]).toHaveProperty('url');
        expect(citationMap[String(i)]).toHaveProperty('status');
      }

      // Verify the two matched ones are resolved
      expect(citationMap['1'].url).toContain('v1');
      expect(citationMap['1'].status).toBe('resolved');
      expect(citationMap['6'].url).toContain('v2');
      expect(citationMap['6'].status).toBe('resolved');

      // Verify all others are unresolved
      for (const id of ['2', '3', '4', '5', '7', '8', '9', '10']) {
        expect(citationMap[id].url).toBeNull();
        expect(citationMap[id].confidence).toBe('low');
        expect(citationMap[id].status).toBe('unresolved');
      }
    });
  });

  describe('extractVideoIdFromUrl integration', () => {
    it('extracts ID from standard URL', () => {
      expect(extractVideoIdFromUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts ID from short URL', () => {
      expect(extractVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('returns null for invalid URL', () => {
      expect(extractVideoIdFromUrl('not-a-url')).toBeNull();
    });
  });
});
