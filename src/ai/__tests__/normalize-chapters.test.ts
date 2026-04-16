import { describe, it, expect, vi } from 'vitest';
import { normalizeChapters, type RawChapter } from '../normalize-chapters';
import type { TranscriptSegment } from '@/types';

function makeSegs(starts: number[]): TranscriptSegment[] {
  return starts.map((start) => ({ start, duration: 1, text: `line-${start}` }));
}

describe('normalizeChapters', () => {
  it('non-overlapping chapters: segments partitioned correctly', () => {
    const raw: RawChapter[] = [
      { chapterTitle: 'A', startTime: 0, endTime: 30, content: '' },
      { chapterTitle: 'B', startTime: 30, endTime: 60, content: '' },
      { chapterTitle: 'C', startTime: 60, endTime: 100, content: '' },
    ];
    const segs = makeSegs([0, 10, 30, 45, 60, 80]);
    const result = normalizeChapters(raw, segs);
    expect(result).toHaveLength(3);
    expect(result[0].segments.map((s) => s.start)).toEqual([0, 10]);
    expect(result[1].segments.map((s) => s.start)).toEqual([30, 45]);
    expect(result[2].segments.map((s) => s.start)).toEqual([60, 80]);
  });

  it('bug scenario: overlapping chapters dedupe to non-overlapping set', () => {
    // AI returned 5 chapters for a 1:57 video — 3 of them duplicated full range.
    const raw: RawChapter[] = [
      { chapterTitle: 'Intro', startTime: 0, endTime: 60, content: '' },
      { chapterTitle: 'Key', startTime: 60, endTime: 117, content: '' },
      { chapterTitle: 'Dev', startTime: 0, endTime: 117, content: '' },
      { chapterTitle: 'Eval', startTime: 0, endTime: 117, content: '' },
      { chapterTitle: 'End', startTime: 0, endTime: 117, content: '' },
    ];
    const segs = makeSegs([0, 30, 60, 90]);
    const result = normalizeChapters(raw, segs);

    // After dedup-by-startTime (keep smallest endTime): {0→Intro(0,60)}, {60→Key(60,117)}.
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Intro');
    expect(result[0].startTime).toBe(0);
    expect(result[0].endTime).toBe(60);
    expect(result[0].segments.map((s) => s.start)).toEqual([0, 30]);

    expect(result[1].title).toBe('Key');
    expect(result[1].startTime).toBe(60);
    expect(result[1].endTime).toBe(117);
    expect(result[1].segments.map((s) => s.start)).toEqual([60, 90]);

    // Invariant: no segment appears in more than one chapter.
    const allStarts = result.flatMap((ch) => ch.segments.map((s) => s.start));
    expect(new Set(allStarts).size).toBe(allStarts.length);
  });

  it('partially overlapping: clamps effective endTime to next startTime', () => {
    // ch1 (0-60), ch2 (30-90). After sort: [ch1, ch2].
    // ch1.nextStart = 30 → effectiveEnd = min(60, 30) = 30.
    // ch2.nextStart = Infinity → effectiveEnd = min(90, Infinity) = 90.
    // Final: ch1 (0, 30), ch2 (30, 90).
    const raw: RawChapter[] = [
      { chapterTitle: 'A', startTime: 0, endTime: 60, content: '' },
      { chapterTitle: 'B', startTime: 30, endTime: 90, content: '' },
    ];
    const segs = makeSegs([10, 25, 50, 70]);
    const result = normalizeChapters(raw, segs);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('A');
    expect(result[0].endTime).toBe(30); // clamped
    expect(result[0].segments.map((s) => s.start)).toEqual([10, 25]);

    expect(result[1].title).toBe('B');
    expect(result[1].endTime).toBe(90);
    expect(result[1].segments.map((s) => s.start)).toEqual([50, 70]);
  });

  it('out-of-order input: sorts by startTime and assigns correctly', () => {
    const raw: RawChapter[] = [
      { chapterTitle: 'Second', startTime: 30, endTime: 60, content: '' },
      { chapterTitle: 'First', startTime: 0, endTime: 30, content: '' },
      { chapterTitle: 'Third', startTime: 60, endTime: 100, content: '' },
    ];
    const segs = makeSegs([5, 40, 75]);
    const result = normalizeChapters(raw, segs);

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.title)).toEqual(['First', 'Second', 'Third']);
    expect(result[0].segments.map((s) => s.start)).toEqual([5]);
    expect(result[1].segments.map((s) => s.start)).toEqual([40]);
    expect(result[2].segments.map((s) => s.start)).toEqual([75]);
  });

  it('empty input returns empty array', () => {
    const result = normalizeChapters([], makeSegs([0, 10, 20]));
    expect(result).toEqual([]);
  });

  it('negative startTime is clamped to 0', () => {
    const raw: RawChapter[] = [
      { chapterTitle: 'Weird', startTime: -5, endTime: 20, content: '' },
      { chapterTitle: 'Next', startTime: 20, endTime: 40, content: '' },
    ];
    const segs = makeSegs([0, 15, 30]);
    const result = normalizeChapters(raw, segs);

    expect(result).toHaveLength(2);
    expect(result[0].startTime).toBe(0);
    expect(result[0].segments.map((s) => s.start)).toEqual([0, 15]);
  });

  it('anti-duplication invariant: each segment appears in at most one chapter', () => {
    // Include garbage overlapping chapters to stress the invariant.
    const raw: RawChapter[] = [
      { chapterTitle: 'A', startTime: 0, endTime: 50, content: '' },
      { chapterTitle: 'B', startTime: 20, endTime: 80, content: '' },
      { chapterTitle: 'C', startTime: 10, endTime: 100, content: '' },
      { chapterTitle: 'D', startTime: 40, endTime: 120, content: '' },
    ];
    const segs = makeSegs([0, 5, 15, 25, 45, 65, 85, 95, 110]);
    const result = normalizeChapters(raw, segs);

    const allPlacements = result.flatMap((ch) =>
      ch.segments.map((s) => s.start),
    );
    expect(new Set(allPlacements).size).toBe(allPlacements.length);
  });

  it('sum of segment counts equals input segment count when coverage is complete', () => {
    const raw: RawChapter[] = [
      { chapterTitle: 'A', startTime: 0, endTime: 50, content: '' },
      { chapterTitle: 'B', startTime: 50, endTime: 100, content: '' },
    ];
    const segs = makeSegs([0, 10, 25, 60, 80, 99]);
    const result = normalizeChapters(raw, segs);

    const totalPlaced = result.reduce((n, ch) => n + ch.segments.length, 0);
    expect(totalPlaced).toBe(segs.length);
  });

  it('drops chapters with empty segments after clamping', () => {
    // Two chapters both starting at 0 with the same endTime → after dedup only one survives.
    // Plus a chapter that would have zero segments because no transcript lines fall in its range.
    const raw: RawChapter[] = [
      { chapterTitle: 'Real', startTime: 0, endTime: 50, content: '' },
      { chapterTitle: 'NoSegs', startTime: 200, endTime: 300, content: '' },
    ];
    const segs = makeSegs([0, 10, 40]);
    const result = normalizeChapters(raw, segs);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real');
  });

  it('dedupe-by-startTime keeps the entry with the smallest endTime', () => {
    // Three entries at startTime=0 with different endTimes. Smallest (10) should win.
    const raw: RawChapter[] = [
      { chapterTitle: 'Big', startTime: 0, endTime: 100, content: '' },
      { chapterTitle: 'Small', startTime: 0, endTime: 10, content: '' },
      { chapterTitle: 'Mid', startTime: 0, endTime: 50, content: '' },
      { chapterTitle: 'Tail', startTime: 10, endTime: 100, content: '' },
    ];
    const segs = makeSegs([0, 5, 20, 60, 90]);
    const result = normalizeChapters(raw, segs);

    expect(result.map((c) => c.title)).toEqual(['Small', 'Tail']);
    expect(result[0].endTime).toBe(10);
    expect(result[0].segments.map((s) => s.start)).toEqual([0, 5]);
    expect(result[1].segments.map((s) => s.start)).toEqual([20, 60, 90]);
  });

  it('warns when chapters are dropped during normalization', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw: RawChapter[] = [
      { chapterTitle: 'A', startTime: 0, endTime: 60, content: '' },
      { chapterTitle: 'Dup', startTime: 0, endTime: 117, content: '' },
      { chapterTitle: 'Dup2', startTime: 0, endTime: 117, content: '' },
    ];
    const segs = makeSegs([0, 30]);
    normalizeChapters(raw, segs);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
