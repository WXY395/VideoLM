import type { Chapter, TranscriptSegment } from '@/types';

/**
 * Raw chapter data from AI, before normalization.
 */
export interface RawChapter {
  chapterTitle: string;
  startTime: number;
  endTime: number;
  content?: string;
}

/**
 * Normalize AI-returned chapters and assign transcript segments.
 *
 * Defensive invariants:
 * 1. Duplicate startTimes are de-duped first — the entry with the smallest
 *    endTime wins (maximises the chance of non-overlap with later chapters).
 * 2. Chapters sorted by startTime ascending.
 * 3. Each chapter's effective endTime clamped to the next chapter's startTime
 *    (prevents overlap, ensures each segment lands in AT MOST one chapter).
 * 4. Chapters with empty segments are dropped (avoids service-worker fallback
 *    to rawText which would duplicate the full transcript).
 * 5. Negative / invalid time bounds are clamped to [0, Infinity).
 *
 * This protects against AI returning overlapping or garbage time ranges,
 * which GPT-4o-mini has been observed to do for short videos.
 */
export function normalizeChapters(
  raw: RawChapter[],
  segments: TranscriptSegment[],
): Chapter[] {
  // Step 1: Dedupe by startTime — keep the entry with the smallest endTime
  //         so that later chapters are less likely to be clamped to zero length.
  const byStart = new Map<number, RawChapter>();
  for (const ch of raw) {
    const s = Math.max(0, ch.startTime ?? 0);
    const endT = ch.endTime ?? Infinity;
    const existing = byStart.get(s);
    const existingEnd = existing?.endTime ?? Infinity;
    if (!existing || endT < existingEnd) {
      byStart.set(s, { ...ch, startTime: s });
    }
  }

  // Step 2: Sort by startTime ascending.
  const sorted = [...byStart.values()].sort(
    (a, b) => (a.startTime ?? 0) - (b.startTime ?? 0),
  );

  // Step 3: Clamp each chapter's endTime to the next chapter's startTime and
  //         assign segments.
  const chapters: Chapter[] = sorted.map((ch, idx) => {
    const startTime = Math.max(0, ch.startTime ?? 0);
    const nextStart = sorted[idx + 1]?.startTime ?? Infinity;
    const endTime = Math.min(ch.endTime ?? Infinity, nextStart);
    const validRange = endTime > startTime;
    return {
      title: ch.chapterTitle,
      startTime,
      endTime,
      segments: validRange
        ? segments.filter((s) => s.start >= startTime && s.start < endTime)
        : [],
    };
  });

  // Step 4: Drop chapters with no segments. This prevents the service-worker
  // from falling back to the full rawText when segments are empty — that
  // fallback was the amplifier of the original duplication bug.
  const nonEmpty = chapters.filter((ch) => ch.segments.length > 0);

  if (raw.length > 0 && nonEmpty.length < raw.length) {
    console.warn(
      `[VideoLM] Normalized ${raw.length} chapters to ${nonEmpty.length} (dropped ${raw.length - nonEmpty.length} with overlap/invalid ranges)`,
    );
  }

  return nonEmpty;
}
