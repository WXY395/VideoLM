import { describe, it, expect } from 'vitest';
import { isYouTubeUrl, extractVideoIdFromUrl } from '@/utils/url-sanitizer';
import {
  createVideoSourceRecord,
  buildFingerprintIndex,
  resolveCitation,
} from '@/utils/source-resolution';
import type { CitationConfidence } from '@/utils/notion-sync';

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

      const citationMap: Record<string, { url: string; confidence?: CitationConfidence }> = {};

      for (const csn of citations) {
        const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
        if (match.record?.url) {
          const algoConfidence: CitationConfidence = match.type === 'matched' ? 'high'
            : match.type === 'uncertain' ? 'medium'
            : 'low';
          citationMap[String(csn.id)] = { url: match.record.url, confidence: algoConfidence };
        }

        // ── User-provided source override (same logic as handleQuickFix) ──
        const key = String(csn.id);
        if (!citationMap[key]?.url && csn.sourceName === fixingSourceName) {
          citationMap[key] = { url: userUrl, confidence: 'medium' };
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
      // Unrelated citation does NOT get the user-provided URL
      expect(citationMap['11']?.url).toBeUndefined();
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

    it('does not assign confidence to unresolved citations (no entry)', () => {
      const record = createVideoSourceRecord(
        'v3', 'Python 教學', 'Ch', 'https://youtube.com/watch?v=v3',
      );
      const sourceIndex = [record];
      const fpIndex = buildFingerprintIndex(sourceIndex);

      const citationMap: Record<string, { url: string; confidence?: CitationConfidence }> = {};
      const match = resolveCitation('React Native 開發指南', fpIndex, sourceIndex);
      if (match.record?.url) {
        citationMap['99'] = { url: match.record.url, confidence: 'high' };
      }

      // not_found → no entry in citationMap at all
      expect(match.type).toBe('not_found');
      expect(citationMap['99']).toBeUndefined();
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
