import type { DuplicateCheckResult } from '@/types';

/**
 * Compute Levenshtein distance between two strings,
 * normalized to a 0-1 similarity score.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);

  // Build Levenshtein distance matrix (two-row optimization)
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j];
    }
  }

  const distance = prev[b.length];
  return 1 - distance / maxLen;
}

/**
 * Check if a video is a duplicate of an existing source.
 * - Exact match: videoId found in any source URL or title
 * - Fuzzy match: title similarity > 0.8
 */
export function checkDuplicateByTitle(
  videoId: string,
  videoTitle: string,
  existingSources: Array<{ title: string; url?: string }>,
): DuplicateCheckResult {
  // Check exact match by videoId
  for (const source of existingSources) {
    const inUrl = source.url?.includes(videoId);
    const inTitle = source.title.includes(videoId);

    if (inUrl || inTitle) {
      return {
        isDuplicate: true,
        matchType: 'exact',
        existingTitle: source.title,
        suggestion: `This video already exists as "${source.title}".`,
      };
    }
  }

  // Check fuzzy match by title similarity
  for (const source of existingSources) {
    const sim = similarity(videoTitle.toLowerCase(), source.title.toLowerCase());
    if (sim > 0.8) {
      return {
        isDuplicate: true,
        matchType: 'fuzzy',
        existingTitle: source.title,
        suggestion: `A similar source "${source.title}" already exists (${Math.round(sim * 100)}% match).`,
      };
    }
  }

  return { isDuplicate: false };
}
