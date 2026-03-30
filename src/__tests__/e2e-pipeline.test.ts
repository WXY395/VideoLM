/**
 * End-to-end pipeline integration test.
 *
 * Simulates the full flow: YouTube extraction → AI processing → NLM import,
 * using mock data to verify the entire pipeline works together.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseXMLCaptions, formatTranscript, extractVideoId, extractCaptionTracks, extractChapters, extractVideoMetadata } from '@/extractors/youtube-extractor';
import { resolveProvider } from '@/ai/provider-manager';
import { addMetadataHeader } from '@/processing/rag-optimizer';
import { checkDuplicateByTitle } from '@/processing/duplicate-detector';
import { ImportOrchestrator } from '@/nlm/import-orchestrator';
import type { VideoContent, UserSettings, DynamicConfig } from '@/types';

// ─── Realistic YouTube XML caption data ──────────────────────────

const REAL_YOUTUBE_XML = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0.48" dur="3.04">Welcome to this tutorial on Python programming.</text>
  <text start="3.52" dur="2.96">In this video, we&#39;ll cover the basics of Python,</text>
  <text start="6.48" dur="3.2">including variables, data types, &amp; control flow.</text>
  <text start="9.68" dur="2.88">Let&#39;s start with what Python is.</text>
  <text start="12.56" dur="4.16">Python is a high-level, interpreted programming language</text>
  <text start="16.72" dur="3.44">created by Guido van Rossum in 1991.</text>
  <text start="20.16" dur="3.68">It&apos;s known for its readability and simplicity.</text>
  <text start="23.84" dur="2.72">Now let&#39;s look at variables.</text>
  <text start="26.56" dur="3.84">A variable is a name that refers to a value in memory.</text>
  <text start="30.4" dur="3.12">You can create a variable by simply assigning a value.</text>
</transcript>`;

const REAL_PLAYER_RESPONSE = {
  videoDetails: {
    videoId: 'rfscVS0vtbw',
    title: 'Learn Python - Full Course for Beginners',
    author: 'freeCodeCamp.org',
    lengthSeconds: '14400',
    keywords: ['python', 'programming', 'tutorial', 'beginners'],
  },
  microformat: {
    playerMicroformatRenderer: {
      publishDate: '2018-07-11',
      viewCount: '45000000',
    },
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { languageCode: 'en', name: { simpleText: 'English' }, kind: '', baseUrl: 'https://example.com/captions' },
        { languageCode: 'en', name: { simpleText: 'English (auto)' }, kind: 'asr', baseUrl: 'https://example.com/auto' },
        { languageCode: 'zh-TW', name: { simpleText: 'Chinese (Traditional)' }, kind: '', baseUrl: 'https://example.com/zh' },
      ],
    },
  },
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: {
            multiMarkersPlayerBarRenderer: {
              markersMap: [{
                value: {
                  chapters: [
                    { chapterRenderer: { title: { simpleText: 'Introduction' }, timeRangeStartMillis: 0 } },
                    { chapterRenderer: { title: { simpleText: 'Variables & Data Types' }, timeRangeStartMillis: 23000 } },
                  ],
                },
              }],
            },
          },
        },
      },
    },
  },
};

// ─── E2E Tests ───────────────────────────────────────────────────

describe('E2E Pipeline: YouTube → Processing → NLM Import', () => {

  describe('Phase 1: YouTube Extraction', () => {
    it('parses real YouTube XML captions with regex parser', () => {
      const segments = parseXMLCaptions(REAL_YOUTUBE_XML);
      expect(segments).toHaveLength(10);
      expect(segments[0].text).toBe('Welcome to this tutorial on Python programming.');
      expect(segments[0].start).toBeCloseTo(0.48);
      expect(segments[0].duration).toBeCloseTo(3.04);
    });

    it('decodes HTML entities in real captions', () => {
      const segments = parseXMLCaptions(REAL_YOUTUBE_XML);
      expect(segments[1].text).toContain("we'll cover");    // &#39; → '
      expect(segments[2].text).toContain('& control flow'); // &amp; → &
      expect(segments[6].text).toContain("It's known");     // &apos; → '
    });

    it('formats transcript with timestamps', () => {
      const segments = parseXMLCaptions(REAL_YOUTUBE_XML);
      const formatted = formatTranscript(segments, { timestamps: true });
      expect(formatted).toContain('[00:00]');
      expect(formatted).toContain('[00:26]');
      expect(formatted).toContain('Welcome to this tutorial');
    });

    it('extracts video metadata from playerResponse', () => {
      const meta = extractVideoMetadata(REAL_PLAYER_RESPONSE);
      expect(meta.title).toBe('Learn Python - Full Course for Beginners');
      expect(meta.author).toBe('freeCodeCamp.org');
      expect(meta.duration).toBe(14400);
      expect(meta.metadata?.publishDate).toBe('2018-07-11');
      expect(meta.metadata?.viewCount).toBe(45000000);
      expect(meta.metadata?.tags).toContain('python');
    });

    it('extracts caption tracks and prefers manual over auto', () => {
      const tracks = extractCaptionTracks(REAL_PLAYER_RESPONSE);
      expect(tracks).toHaveLength(3);
      const manual = tracks.find(t => !t.isAutoGenerated && t.languageCode === 'en');
      expect(manual).toBeDefined();
      expect(manual!.name).toBe('English');
    });

    it('extracts chapter markers', () => {
      const chapters = extractChapters(REAL_PLAYER_RESPONSE);
      expect(chapters).toHaveLength(2);
      expect(chapters[0].title).toBe('Introduction');
      expect(chapters[0].startTime).toBe(0);
      expect(chapters[1].title).toBe('Variables & Data Types');
      expect(chapters[1].startTime).toBe(23);
    });
  });

  describe('Phase 2: AI Processing Pipeline', () => {
    it('resolves NoAI provider for free tier without BYOK', () => {
      const settings: UserSettings = {
        tier: 'free',
        defaultMode: 'raw',
        monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-05-01' },
      };
      const provider = resolveProvider(settings);
      expect(provider.name).toBe('no-ai');
    });

    it('resolves OpenAI provider with BYOK key', () => {
      const settings: UserSettings = {
        tier: 'free',
        byok: { provider: 'openai', apiKey: 'sk-test-key', model: 'gpt-4o-mini' },
        defaultMode: 'structured',
        monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-05-01' },
      };
      const provider = resolveProvider(settings);
      expect(provider.name).toBe('openai-direct');
    });

    it('adds metadata header with correct format', () => {
      const result = addMetadataHeader('Content here', {
        title: 'Learn Python',
        author: 'freeCodeCamp',
        platform: 'youtube',
        publishDate: '2018-07-11',
        duration: 14400,
        url: 'https://youtube.com/watch?v=rfscVS0vtbw',
      });
      expect(result).toContain('---');
      expect(result).toContain('Source: Learn Python');
      expect(result).toContain('Author: freeCodeCamp');
      expect(result).toContain('Platform: youtube');
      expect(result).toContain('Content here');
    });
  });

  describe('Phase 3: Duplicate Detection', () => {
    const existingSources = [
      { title: 'Learn Python - Full Course', url: 'https://youtube.com/watch?v=rfscVS0vtbw' },
      { title: 'JavaScript Tutorial for Beginners' },
    ];

    it('detects exact video ID match', () => {
      const result = checkDuplicateByTitle('rfscVS0vtbw', 'Some Title', existingSources);
      expect(result.isDuplicate).toBe(true);
      expect(result.matchType).toBe('exact');
    });

    it('detects fuzzy title match', () => {
      // "Learn Python - Full Course" vs "Learn Python - Full Courses" — high similarity
      const result = checkDuplicateByTitle('xyz', 'Learn Python - Full Courses', existingSources);
      expect(result.isDuplicate).toBe(true);
      expect(result.matchType).toBe('fuzzy');
    });

    it('allows unique content', () => {
      const result = checkDuplicateByTitle('abc', 'Rust Programming Tutorial', existingSources);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('Phase 4: NLM Three-Tier Fallback', () => {
    const baseConfig: DynamicConfig = {
      version: '0.2.0',
      nlm: {
        selectors: {
          addSourceButton: [], sourceTypeMenu: [], copiedTextOption: [],
          textInput: [], urlInput: [], submitButton: [],
          notebookList: [], sourceList: [],
        },
        apiPatterns: { addSource: 'batchexecute', listNotebooks: '' },
      },
      features: { fetchInterceptEnabled: true, domAutomationEnabled: true, maxBatchSize: 50 },
    };

    it('tier 1 succeeds when fetch replay works', async () => {
      const orchestrator = new ImportOrchestrator({
        fetchInterceptor: {
          isArmed: () => true,
          replay: vi.fn().mockResolvedValue({ success: true }),
        } as any,
        domAutomation: { addSource: vi.fn() } as any,
        config: baseConfig,
        clipboardWrite: vi.fn(),
      });

      const result = await orchestrator.importContent('Test content');
      expect(result.success).toBe(true);
      expect(result.tier).toBe(1);
    });

    it('falls through to tier 3 clipboard when all fail', async () => {
      const clipboardWrite = vi.fn().mockResolvedValue(undefined);
      const orchestrator = new ImportOrchestrator({
        fetchInterceptor: {
          isArmed: () => false,
        } as any,
        domAutomation: {
          addSource: vi.fn().mockResolvedValue({ success: false }),
        } as any,
        config: baseConfig,
        clipboardWrite,
      });

      const result = await orchestrator.importContent('Fallback content');
      expect(result.success).toBe(true);
      expect(result.tier).toBe(3);
      expect(result.manual).toBe(true);
      expect(clipboardWrite).toHaveBeenCalledWith('Fallback content');
    });

    it('progressive batch import with progress callback', async () => {
      const progress: Array<{ idx: number; tier: number }> = [];
      const orchestrator = new ImportOrchestrator({
        config: { ...baseConfig, features: { ...baseConfig.features, fetchInterceptEnabled: false, domAutomationEnabled: false } },
        clipboardWrite: vi.fn().mockResolvedValue(undefined),
      });

      const results = await orchestrator.importBatch(
        [
          { title: 'Ch 1', content: 'Content 1' },
          { title: 'Ch 2', content: 'Content 2' },
        ],
        (idx, result) => { progress.push({ idx, tier: result.tier }); },
      );

      expect(results).toHaveLength(2);
      expect(progress).toHaveLength(2);
      expect(progress[0].tier).toBe(3); // All go to clipboard
    });
  });

  describe('Phase 5: Full Pipeline Integration', () => {
    it('processes a raw import end-to-end', () => {
      // Simulate: parse XML → format → add metadata
      const segments = parseXMLCaptions(REAL_YOUTUBE_XML);
      const transcript = formatTranscript(segments, { timestamps: true });
      const content = addMetadataHeader(transcript, {
        title: 'Learn Python',
        author: 'freeCodeCamp',
        platform: 'youtube',
        publishDate: '2018-07-11',
        duration: 14400,
        url: 'https://youtube.com/watch?v=rfscVS0vtbw',
      });

      // Verify the output is NLM-ready
      expect(content).toContain('---'); // Metadata header
      expect(content).toContain('Source: Learn Python');
      expect(content).toContain('[00:00] Welcome to this tutorial');
      expect(content).toContain('[00:26] A variable is a name');
      expect(content.length).toBeGreaterThan(200);
    });

    it('processes chapter split with real chapter markers', () => {
      const segments = parseXMLCaptions(REAL_YOUTUBE_XML);
      const chapters = extractChapters(REAL_PLAYER_RESPONSE);

      // Assign segments to chapters
      const populated = chapters.map(ch => ({
        ...ch,
        segments: segments.filter(s => s.start >= ch.startTime && s.start < ch.endTime),
      }));

      expect(populated[0].title).toBe('Introduction');
      expect(populated[0].segments.length).toBeGreaterThan(0);
      expect(populated[0].segments[0].text).toContain('Welcome');

      expect(populated[1].title).toBe('Variables & Data Types');
      expect(populated[1].segments.length).toBeGreaterThan(0);
      expect(populated[1].segments[0].text).toContain('variables');

      // Each chapter should produce a separate NLM source
      const sources = populated.map(ch => ({
        title: `Learn Python — ${ch.title}`,
        content: addMetadataHeader(
          formatTranscript(ch.segments, { timestamps: true }),
          {
            title: `Learn Python — ${ch.title}`,
            author: 'freeCodeCamp',
            platform: 'youtube',
            publishDate: '2018-07-11',
            duration: ch.endTime - ch.startTime,
            url: 'https://youtube.com/watch?v=rfscVS0vtbw',
          },
        ),
      }));

      expect(sources).toHaveLength(2);
      expect(sources[0].title).toContain('Introduction');
      expect(sources[1].title).toContain('Variables');
      expect(sources[0].content).toContain('---'); // Has metadata
      expect(sources[1].content).toContain('---');
    });
  });
});
