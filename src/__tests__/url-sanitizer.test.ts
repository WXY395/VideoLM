import { describe, it, expect } from 'vitest';
import {
  sanitizeYouTubeUrl,
  deduplicateUrls,
  extractVideoIdFromUrl,
  isYouTubeUrl,
} from '@/utils/url-sanitizer';

// ---------------------------------------------------------------------------
// isYouTubeUrl
// ---------------------------------------------------------------------------

describe('isYouTubeUrl', () => {
  it('accepts standard watch URL', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts short URL', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts shorts URL', () => {
    expect(isYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts URL with extra params', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=abc123&list=PLxyz')).toBe(true);
  });

  it('accepts http (non-https)', () => {
    expect(isYouTubeUrl('http://youtube.com/watch?v=abc123')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isYouTubeUrl('')).toBe(false);
  });

  it('rejects non-YouTube URL', () => {
    expect(isYouTubeUrl('https://vimeo.com/123456')).toBe(false);
  });

  it('rejects random text', () => {
    expect(isYouTubeUrl('not a url')).toBe(false);
  });

  it('rejects YouTube URL without video ID', () => {
    expect(isYouTubeUrl('https://youtube.com/watch')).toBe(false);
  });

  it('rejects YouTube channel URL', () => {
    expect(isYouTubeUrl('https://youtube.com/@channelname')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractVideoIdFromUrl
// ---------------------------------------------------------------------------

describe('extractVideoIdFromUrl', () => {
  it('extracts ID from standard watch URL', () => {
    expect(extractVideoIdFromUrl('https://www.youtube.com/watch?v=abc123')).toBe('abc123');
  });

  it('extracts ID from watch URL with extra params', () => {
    expect(
      extractVideoIdFromUrl('https://www.youtube.com/watch?v=abc123&list=PLxxx&index=5'),
    ).toBe('abc123');
  });

  it('extracts ID from youtu.be short link', () => {
    expect(extractVideoIdFromUrl('https://youtu.be/abc123?si=xxx')).toBe('abc123');
  });

  it('extracts ID from embed URL', () => {
    expect(extractVideoIdFromUrl('https://www.youtube.com/embed/abc123')).toBe('abc123');
  });

  it('extracts ID from shorts URL', () => {
    expect(extractVideoIdFromUrl('https://www.youtube.com/shorts/abc123')).toBe('abc123');
  });

  it('returns null for non-YouTube URL', () => {
    expect(extractVideoIdFromUrl('https://example.com/page')).toBeNull();
  });

  it('returns null for playlist-only URL with no v param', () => {
    expect(extractVideoIdFromUrl('https://www.youtube.com/playlist?list=PLxxx')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(extractVideoIdFromUrl('not a url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeYouTubeUrl
// ---------------------------------------------------------------------------

describe('sanitizeYouTubeUrl', () => {
  it('strips list and index params', () => {
    expect(sanitizeYouTubeUrl('https://www.youtube.com/watch?v=abc123&list=PLxxx&index=5')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('strips pp and si params', () => {
    expect(sanitizeYouTubeUrl('https://www.youtube.com/watch?v=abc123&pp=xxx&si=yyy')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('normalises youtu.be to canonical form', () => {
    expect(sanitizeYouTubeUrl('https://youtu.be/abc123?si=xxx')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('normalises embed URL', () => {
    expect(sanitizeYouTubeUrl('https://www.youtube.com/embed/xyz789')).toBe(
      'https://www.youtube.com/watch?v=xyz789',
    );
  });

  it('strips feature and ab_channel params', () => {
    expect(
      sanitizeYouTubeUrl(
        'https://www.youtube.com/watch?v=abc123&feature=share&ab_channel=SomeChannel',
      ),
    ).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('returns null for non-video URL', () => {
    expect(sanitizeYouTubeUrl('https://www.youtube.com/playlist?list=PLxxx')).toBeNull();
  });

  it('handles already-clean URL', () => {
    expect(sanitizeYouTubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });
});

// ---------------------------------------------------------------------------
// deduplicateUrls
// ---------------------------------------------------------------------------

describe('deduplicateUrls', () => {
  it('removes duplicate URLs with the same video ID', () => {
    const input = [
      'https://www.youtube.com/watch?v=abc123',
      'https://www.youtube.com/watch?v=abc123&list=PLxxx',
      'https://www.youtube.com/watch?v=def456',
    ];
    expect(deduplicateUrls(input)).toEqual([
      'https://www.youtube.com/watch?v=abc123',
      'https://www.youtube.com/watch?v=def456',
    ]);
  });

  it('preserves order (first occurrence wins)', () => {
    const input = [
      'https://www.youtube.com/watch?v=bbb',
      'https://www.youtube.com/watch?v=aaa',
      'https://www.youtube.com/watch?v=bbb',
    ];
    expect(deduplicateUrls(input)).toEqual([
      'https://www.youtube.com/watch?v=bbb',
      'https://www.youtube.com/watch?v=aaa',
    ]);
  });

  it('deduplicates across URL formats', () => {
    const input = [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123?si=xxx',
      'https://www.youtube.com/embed/abc123',
    ];
    expect(deduplicateUrls(input)).toEqual(['https://www.youtube.com/watch?v=abc123']);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateUrls([])).toEqual([]);
  });
});
