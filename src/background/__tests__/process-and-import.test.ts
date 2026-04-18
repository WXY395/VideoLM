import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AIProvider, VideoContent, UserSettings, TranscriptSegment, Chapter } from '@/types';
import { processAndImport, type ProcessDeps } from '../process-and-import';

// ---------------------------------------------------------------------------
// Sample video — 10 segments spanning 30 seconds, arranged into 3 chapters
// ---------------------------------------------------------------------------
const SAMPLE_VIDEO: VideoContent = {
  videoId: 'abc123',
  title: 'Sample Video',
  author: 'Test Author',
  platform: 'youtube',
  transcript: [
    { start: 0, duration: 3, text: 'Hello and welcome' },
    { start: 3, duration: 3, text: 'Today we will discuss' },
    { start: 6, duration: 4, text: 'three important topics' },
    { start: 10, duration: 3, text: 'First topic is A' },
    { start: 13, duration: 4, text: 'which involves X' },
    { start: 17, duration: 3, text: 'Second topic is B' },
    { start: 20, duration: 4, text: 'which involves Y' },
    { start: 24, duration: 3, text: 'Third topic is C' },
    { start: 27, duration: 3, text: 'which wraps up things' },
    { start: 30, duration: 2, text: 'Thanks for watching' },
  ],
  duration: 32,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=abc123',
  metadata: { publishDate: '2026-04-01', viewCount: 1000, tags: [] },
};

function makeMockProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    name: 'mock',
    summarize: vi.fn(async (t: string, _videoTitle: string, _mode: string, _language: string) => `SUMMARY: ${t.substring(0, 20)}...`),
    splitChapters: vi.fn(async (_transcript: string, segments: TranscriptSegment[], _language: string) => [
      {
        title: 'Chapter One',
        startTime: 0,
        endTime: 10,
        segments: segments.filter((s) => s.start >= 0 && s.start < 10),
      },
      {
        title: 'Chapter Two',
        startTime: 10,
        endTime: 20,
        segments: segments.filter((s) => s.start >= 10 && s.start < 20),
      },
      {
        title: 'Chapter Three',
        startTime: 20,
        endTime: 32,
        segments: segments.filter((s) => s.start >= 20 && s.start < 32),
      },
    ]),
    translate: vi.fn(async (content: string, lang: string) => `[${lang}] ${content}`),
    ...overrides,
  };
}

function makeDefaultDeps(provider: AIProvider): ProcessDeps {
  const settings: UserSettings = {
    tier: 'free',
    byok: { provider: 'anthropic', apiKey: 'fake' },
    defaultMode: 'structured',
    duplicateStrategy: 'ask',
    monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-05-01' },
  };
  return {
    getSettings: vi.fn(async () => settings),
    checkQuota: vi.fn(() => ({ canImport: true, canUseAI: true })),
    incrementUsage: vi.fn(async () => {}),
    resolveProvider: vi.fn(() => provider),
    t: vi.fn((key: string) => key),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processAndImport', () => {
  describe("mode: 'raw'", () => {
    it('returns 1 item with transcript and metadata header', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Sample Video');

      // Timestamps should be present
      expect(result.items[0].content).toContain('[00:00]');
      expect(result.items[0].content).toContain('[00:03]');
      expect(result.items[0].content).toContain('[00:30]');

      // All 10 transcript lines should appear
      for (const seg of SAMPLE_VIDEO.transcript) {
        expect(result.items[0].content).toContain(seg.text);
      }
    });

    it('does NOT call provider.summarize/splitChapters/translate', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(provider.summarize).not.toHaveBeenCalled();
      expect(provider.splitChapters).not.toHaveBeenCalled();
      expect(provider.translate).not.toHaveBeenCalled();
    });

    it('increments imports but not aiCalls', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(deps.incrementUsage).toHaveBeenCalledWith('imports');
      expect(deps.incrementUsage).not.toHaveBeenCalledWith('aiCalls');
    });
  });

  describe("mode: 'summary'", () => {
    it('returns 1 item containing AI summary wrapped by metadata header', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'summary' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toContain('SUMMARY:');
      expect(result.items[0].content).toContain('Source: Sample Video');
    });

    it('calls provider.summarize once with mode=summary', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      await processAndImport(SAMPLE_VIDEO, { mode: 'summary' }, deps);

      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(provider.summarize).toHaveBeenCalledWith(expect.any(String), 'Sample Video', 'summary', expect.any(String));
    });

    it('increments aiCalls', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      await processAndImport(SAMPLE_VIDEO, { mode: 'summary' }, deps);

      expect(deps.incrementUsage).toHaveBeenCalledWith('aiCalls');
      expect(deps.incrementUsage).toHaveBeenCalledWith('imports');
    });
  });

  describe("mode: 'structured'", () => {
    it('returns 1 item and calls summarize with mode=structured', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'structured' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(provider.summarize).toHaveBeenCalledWith(expect.any(String), 'Sample Video', 'structured', expect.any(String));
      expect(deps.incrementUsage).toHaveBeenCalledWith('aiCalls');
    });
  });

  describe("mode: 'chapters' — regression test", () => {
    it('returns 3 items matching the 3 mock chapters', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'chapters' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].title).toBe('Chapter One');
      expect(result.items[1].title).toBe('Chapter Two');
      expect(result.items[2].title).toBe('Chapter Three');
    });

    it('each item contains ONLY segments from its chapter time range', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'chapters' }, deps);

      const [ch1, _ch2, ch3] = result.items;

      // Chapter 1: segments with start < 10
      expect(ch1.content).toContain('Hello and welcome');
      expect(ch1.content).toContain('three important topics');
      expect(ch1.content).not.toContain('Thanks for watching');
      expect(ch1.content).not.toContain('First topic is A');

      // Chapter 3: segments with start >= 20
      expect(ch3.content).toContain('Third topic is C');
      expect(ch3.content).toContain('Thanks for watching');
      expect(ch3.content).not.toContain('Hello and welcome');
      expect(ch3.content).not.toContain('First topic is A');
    });

    it('NO DUPLICATION: unique transcript lines across all chapters == original 10', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'chapters' }, deps);

      // Count how many times each transcript line appears across ALL chapter contents.
      // Expect each original line to appear exactly once.
      const allContents = result.items.map((i) => i.content).join('\n');
      for (const seg of SAMPLE_VIDEO.transcript) {
        const matches = allContents.split(seg.text).length - 1;
        expect(matches, `line "${seg.text}" should appear exactly once`).toBe(1);
      }
    });
  });

  describe("mode: 'chapters' — pre-existing YouTube chapters", () => {
    it('does NOT call provider.splitChapters when videoContent.chapters is present', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const existingChapters: Chapter[] = [
        {
          title: 'Existing Intro',
          startTime: 0,
          endTime: 15,
          segments: SAMPLE_VIDEO.transcript.filter((s) => s.start < 15),
        },
        {
          title: 'Existing Outro',
          startTime: 15,
          endTime: 32,
          segments: SAMPLE_VIDEO.transcript.filter((s) => s.start >= 15),
        },
      ];

      const videoWithChapters: VideoContent = {
        ...SAMPLE_VIDEO,
        chapters: existingChapters,
      };

      const result = await processAndImport(videoWithChapters, { mode: 'chapters' }, deps);

      expect(provider.splitChapters).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Existing Intro');
      expect(result.items[1].title).toBe('Existing Outro');
    });
  });

  describe("mode: 'chapters' — empty provider fallback", () => {
    it('falls back to single item with full transcript when splitChapters returns []', async () => {
      const provider = makeMockProvider({
        splitChapters: vi.fn(async () => []),
      });
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'chapters' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Sample Video');
      // Should contain all 10 lines
      for (const seg of SAMPLE_VIDEO.transcript) {
        expect(result.items[0].content).toContain(seg.text);
      }
    });
  });

  describe('translation', () => {
    it('calls provider.translate on each item and increments aiCalls per item', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(
        SAMPLE_VIDEO,
        { mode: 'chapters', translate: 'zh-TW' },
        deps,
      );

      expect(provider.translate).toHaveBeenCalledTimes(3); // 3 chapters
      expect(result.items[0].content.startsWith('[zh-TW] ')).toBe(true);

      // aiCalls: 1 (splitChapters) + 3 (translations) = 4
      const aiCallsCount = (deps.incrementUsage as any).mock.calls.filter(
        (c: [string]) => c[0] === 'aiCalls',
      ).length;
      expect(aiCallsCount).toBe(4);
    });
  });

  describe('quota enforcement', () => {
    it('returns error when canImport is false', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);
      (deps.checkQuota as any).mockReturnValue({ canImport: false, canUseAI: true });

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe('error_quota_exceeded');
      expect(provider.summarize).not.toHaveBeenCalled();
      expect(provider.splitChapters).not.toHaveBeenCalled();
      expect(provider.translate).not.toHaveBeenCalled();
    });

    it('returns error when AI needed but canUseAI is false', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);
      (deps.checkQuota as any).mockReturnValue({ canImport: true, canUseAI: false });

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'summary' }, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe('error_ai_requires_key');
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("raw mode works even if canUseAI is false (raw doesn't need AI)", async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);
      (deps.checkQuota as any).mockReturnValue({ canImport: true, canUseAI: false });

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('output language propagation', () => {
    it('passes resolved language to provider.summarize based on video language', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);
      const cantoneseVideo: VideoContent = { ...SAMPLE_VIDEO, language: 'yue' };

      await processAndImport(cantoneseVideo, { mode: 'summary' }, deps);

      expect(provider.summarize).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'summary',
        'Cantonese',
      );
    });

    it('honors user outputLanguage override over video language', async () => {
      const provider = makeMockProvider();
      const baseDeps = makeDefaultDeps(provider);
      const baseSettings = await baseDeps.getSettings();
      const overrideDeps: ProcessDeps = {
        ...baseDeps,
        getSettings: async () => ({
          ...baseSettings,
          outputLanguage: 'zh-TW',
        }),
      };
      const cantoneseVideo: VideoContent = { ...SAMPLE_VIDEO, language: 'yue' };

      await processAndImport(cantoneseVideo, { mode: 'summary' }, overrideDeps);

      expect(provider.summarize).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'summary',
        'Traditional Chinese',
      );
    });
  });

  describe('clipboardText assembly', () => {
    it('for 1 item: clipboardText equals item content', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'raw' }, deps);

      expect(result.clipboardText).toBe(result.items[0].content);
      expect(result.message).toContain('Processed "Sample Video"');
      expect(result.message).not.toContain('items.');
    });

    it('for N items: clipboardText joined with \\n\\n---\\n\\n', async () => {
      const provider = makeMockProvider();
      const deps = makeDefaultDeps(provider);

      const result = await processAndImport(SAMPLE_VIDEO, { mode: 'chapters' }, deps);

      expect(result.items).toHaveLength(3);
      const expected = result.items.map((i) => i.content).join('\n\n---\n\n');
      expect(result.clipboardText).toBe(expected);
      expect(result.message).toContain('Processed 3 items');
    });
  });
});
