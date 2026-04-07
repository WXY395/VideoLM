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
