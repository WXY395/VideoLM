import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractVideoId,
  parseXMLCaptions,
  formatTranscript,
  extractCaptionTracks,
  extractChapters,
  extractVideoMetadata,
  extractFullVideoContent,
} from '../youtube-extractor';
import type { TranscriptSegment } from '@/types';

// ---------------------------------------------------------------------------
// extractVideoId
// ---------------------------------------------------------------------------
describe('extractVideoId', () => {
  it('extracts ID from standard watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from short URL', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from embed URL', () => {
    expect(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID when extra params are present', () => {
    expect(
      extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0&t=42')
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from youtu.be with query params', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=120')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-YouTube URLs', () => {
    expect(extractVideoId('https://vimeo.com/123456')).toBeNull();
  });

  it('returns null for YouTube URLs without a video ID', () => {
    expect(extractVideoId('https://www.youtube.com/channel/UC123')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractVideoId('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseXMLCaptions
// ---------------------------------------------------------------------------
describe('parseXMLCaptions', () => {
  it('parses valid YouTube caption XML', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0.0" dur="4.5">Hello world</text>
  <text start="4.5" dur="3.2">Second segment</text>
</transcript>`;
    const segments = parseXMLCaptions(xml);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ text: 'Hello world', start: 0, duration: 4.5 });
    expect(segments[1]).toEqual({ text: 'Second segment', start: 4.5, duration: 3.2 });
  });

  it('decodes HTML entities', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0" dur="1">rock &amp; roll &lt;3 it&#39;s &quot;great&quot;</text>
</transcript>`;
    const segments = parseXMLCaptions(xml);
    expect(segments[0].text).toBe('rock & roll <3 it\'s "great"');
  });

  it('handles newlines in caption text', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0" dur="2">line one\nline two</text>
</transcript>`;
    const segments = parseXMLCaptions(xml);
    expect(segments[0].text).toBe('line one line two');
  });

  it('returns empty array for invalid XML', () => {
    expect(parseXMLCaptions('not xml at all')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseXMLCaptions('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatTranscript
// ---------------------------------------------------------------------------
describe('formatTranscript', () => {
  const segments: TranscriptSegment[] = [
    { text: 'Hello world', start: 0, duration: 4.5 },
    { text: 'Second segment', start: 65, duration: 3 },
    { text: 'Third segment', start: 3661, duration: 2 },
  ];

  it('formats without timestamps by default', () => {
    const result = formatTranscript(segments);
    expect(result).toBe('Hello world\nSecond segment\nThird segment');
  });

  it('formats with MM:SS timestamps', () => {
    const result = formatTranscript(segments.slice(0, 2), { timestamps: true });
    expect(result).toBe('[00:00] Hello world\n[01:05] Second segment');
  });

  it('uses H:MM:SS format for hour-long videos', () => {
    const result = formatTranscript(segments, { timestamps: true });
    expect(result).toContain('[1:01:01] Third segment');
  });

  it('returns empty string for empty segments', () => {
    expect(formatTranscript([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractCaptionTracks
// ---------------------------------------------------------------------------
describe('extractCaptionTracks', () => {
  const makePlayerResponse = (tracks: any[]) => ({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
      },
    },
  });

  it('returns caption tracks from playerResponse', () => {
    const pr = makePlayerResponse([
      { baseUrl: 'https://example.com/en', name: { simpleText: 'English' }, languageCode: 'en' },
    ]);
    const tracks = extractCaptionTracks(pr);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].languageCode).toBe('en');
  });

  it('marks auto-generated tracks', () => {
    const pr = makePlayerResponse([
      { baseUrl: 'url1', name: { simpleText: 'English' }, languageCode: 'en', kind: 'asr' },
      { baseUrl: 'url2', name: { simpleText: 'English' }, languageCode: 'en' },
    ]);
    const tracks = extractCaptionTracks(pr);
    expect(tracks[0].isAutoGenerated).toBe(true);
    expect(tracks[1].isAutoGenerated).toBe(false);
  });

  it('returns empty array when no captions exist', () => {
    expect(extractCaptionTracks({})).toEqual([]);
    expect(extractCaptionTracks({ captions: {} })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractChapters
// ---------------------------------------------------------------------------
describe('extractChapters', () => {
  const makePlayerResponseWithChapters = (chapters: any[]) => ({
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [
                  {
                    value: {
                      chapters: chapters.map((c) => ({
                        chapterRenderer: {
                          title: { simpleText: c.title },
                          timeRangeStartMillis: c.startMs,
                        },
                      })),
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  it('extracts chapter markers', () => {
    const pr = makePlayerResponseWithChapters([
      { title: 'Intro', startMs: 0 },
      { title: 'Main', startMs: 60000 },
      { title: 'Outro', startMs: 300000 },
    ]);
    const chapters = extractChapters(pr);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toEqual({
      title: 'Intro',
      startTime: 0,
      endTime: 60,
      segments: [],
    });
    expect(chapters[1]).toEqual({
      title: 'Main',
      startTime: 60,
      endTime: 300,
      segments: [],
    });
  });

  it('returns empty array when no chapters exist', () => {
    expect(extractChapters({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractVideoMetadata
// ---------------------------------------------------------------------------
describe('extractVideoMetadata', () => {
  it('extracts title, author, duration, and tags', () => {
    const pr = {
      videoDetails: {
        title: 'My Video',
        author: 'Channel Name',
        lengthSeconds: '600',
        keywords: ['tag1', 'tag2'],
        videoId: 'abc123',
      },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: '2024-01-15',
          viewCount: '12345',
        },
      },
    };
    const meta = extractVideoMetadata(pr);
    expect(meta.title).toBe('My Video');
    expect(meta.author).toBe('Channel Name');
    expect(meta.duration).toBe(600);
    expect(meta.metadata?.tags).toEqual(['tag1', 'tag2']);
    expect(meta.metadata?.publishDate).toBe('2024-01-15');
    expect(meta.metadata?.viewCount).toBe(12345);
  });

  it('handles missing fields gracefully', () => {
    const meta = extractVideoMetadata({});
    expect(meta.title).toBe('');
    expect(meta.author).toBe('');
    expect(meta.duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractFullVideoContent (integration-ish)
// ---------------------------------------------------------------------------
describe('extractFullVideoContent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no caption tracks are available', async () => {
    const pr = { videoDetails: { videoId: 'abc', title: 'T', author: 'A', lengthSeconds: '60' } };
    const result = await extractFullVideoContent(pr, 'https://www.youtube.com/watch?v=abc');
    expect(result).toBeNull();
  });

  it('fetches captions and assembles VideoContent', async () => {
    const captionXml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0" dur="5">Hello</text>
  <text start="5" dur="5">World</text>
</transcript>`;

    // Mock global fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(captionXml),
    }));

    const pr = {
      videoDetails: {
        videoId: 'abc123',
        title: 'Test Video',
        author: 'Test Author',
        lengthSeconds: '120',
        keywords: ['test'],
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://example.com/captions', name: { simpleText: 'English' }, languageCode: 'en' },
          ],
        },
      },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: '2024-01-01',
          viewCount: '100',
        },
      },
    };

    const result = await extractFullVideoContent(pr, 'https://www.youtube.com/watch?v=abc123');
    expect(result).not.toBeNull();
    expect(result!.videoId).toBe('abc123');
    expect(result!.title).toBe('Test Video');
    expect(result!.platform).toBe('youtube');
    expect(result!.transcript).toHaveLength(2);
    expect(result!.language).toBe('en');
  });

  it('prefers manual captions over auto-generated', async () => {
    const captionXml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript><text start="0" dur="1">Hi</text></transcript>`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(captionXml),
    }));

    const pr = {
      videoDetails: { videoId: 'x', title: 'T', author: 'A', lengthSeconds: '10' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://auto.com', name: { simpleText: 'English (auto)' }, languageCode: 'en', kind: 'asr' },
            { baseUrl: 'https://manual.com', name: { simpleText: 'English' }, languageCode: 'en' },
          ],
        },
      },
    };

    await extractFullVideoContent(pr, 'https://www.youtube.com/watch?v=x');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://manual.com');
  });
});
