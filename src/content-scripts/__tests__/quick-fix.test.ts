import { describe, it, expect } from 'vitest';
import { isYouTubeUrl, extractVideoIdFromUrl } from '@/utils/url-sanitizer';
import {
  createVideoSourceRecord,
  buildFingerprintIndex,
  resolveCitation,
} from '@/utils/source-resolution';

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

      const citationMap: Record<string, { url: string }> = {};

      for (const csn of citations) {
        const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
        if (match.record?.url) {
          citationMap[String(csn.id)] = { url: match.record.url };
        }

        // ── User-provided source override (same logic as handleQuickFix) ──
        const key = String(csn.id);
        if (!citationMap[key]?.url && csn.sourceName === fixingSourceName) {
          citationMap[key] = { url: userUrl };
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
