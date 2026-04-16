import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicDirectProvider } from '../providers/anthropic-direct';
import type { TranscriptSegment } from '@/types';

// Mock prompts module so splitChapters() can build a prompt string
vi.mock('../prompts', () => ({
  buildSummaryPrompt: () => 'mock-summary-prompt',
  buildStructuredPrompt: () => 'mock-structured-prompt',
  buildChapterSplitPrompt: () => 'mock-chapter-prompt',
  buildTranslatePrompt: () => 'mock-translate-prompt',
}));

function makeChapterResponse(chaptersJson: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({ content: [{ type: 'text', text: chaptersJson }] }),
  };
}

describe('splitChapters — segment slicing', () => {
  let provider: AnthropicDirectProvider;

  beforeEach(() => {
    provider = new AnthropicDirectProvider('sk-ant-test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('slices original transcript segments into chapters by [startTime, endTime) bounds', async () => {
    const chaptersJson = JSON.stringify([
      { chapterTitle: 'Intro', startTime: 0, endTime: 60, content: 'ignored' },
      { chapterTitle: 'Main', startTime: 60, endTime: 120, content: 'ignored' },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(
      makeChapterResponse(chaptersJson) as Response,
    );

    const segments: TranscriptSegment[] = [
      { start: 0, duration: 10, text: 'hi' },
      { start: 30, duration: 10, text: 'middle' },
      { start: 90, duration: 10, text: 'end' },
    ];

    const chapters = await provider.splitChapters('full-transcript-text', segments);

    expect(chapters).toHaveLength(2);

    // First chapter [0, 60) should contain segments with start=0 and start=30
    expect(chapters[0].title).toBe('Intro');
    expect(chapters[0].startTime).toBe(0);
    expect(chapters[0].endTime).toBe(60);
    expect(chapters[0].segments).toHaveLength(2);
    expect(chapters[0].segments.map((s) => s.start)).toEqual([0, 30]);

    // Second chapter [60, 120) should contain segment with start=90
    expect(chapters[1].title).toBe('Main');
    expect(chapters[1].startTime).toBe(60);
    expect(chapters[1].endTime).toBe(120);
    expect(chapters[1].segments).toHaveLength(1);
    expect(chapters[1].segments.map((s) => s.start)).toEqual([90]);
  });

  it('assigns each segment to exactly one chapter (no duplicates)', async () => {
    const chaptersJson = JSON.stringify([
      { chapterTitle: 'A', startTime: 0, endTime: 60, content: '' },
      { chapterTitle: 'B', startTime: 60, endTime: 120, content: '' },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(
      makeChapterResponse(chaptersJson) as Response,
    );

    const segments: TranscriptSegment[] = [
      { start: 0, duration: 10, text: 'a1' },
      { start: 30, duration: 10, text: 'a2' },
      { start: 90, duration: 10, text: 'b1' },
    ];

    const chapters = await provider.splitChapters('full-transcript', segments);

    const totalPlaced = chapters.reduce((n, ch) => n + ch.segments.length, 0);
    expect(totalPlaced).toBe(segments.length);

    // No segment should appear in more than one chapter
    for (const seg of segments) {
      const occurrences = chapters.filter((ch) =>
        ch.segments.some((s) => s.start === seg.start),
      ).length;
      expect(occurrences).toBe(1);
    }
  });
});
