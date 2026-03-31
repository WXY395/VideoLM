/**
 * YouTube URL sanitization utilities.
 *
 * These are pure functions that can be used both inside the service worker
 * (bundled) and tested independently with Vitest.
 */

/**
 * Extract a YouTube video ID from various URL formats:
 *  - https://www.youtube.com/watch?v=VIDEO_ID&list=...
 *  - https://youtu.be/VIDEO_ID?si=...
 *  - https://www.youtube.com/embed/VIDEO_ID
 *  - https://www.youtube.com/shorts/VIDEO_ID
 *
 * Returns `null` if no video ID can be found.
 */
export function extractVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // youtu.be short links
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id || null;
    }

    // Standard watch page
    if (parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v')!;
    }

    // Embed or shorts URLs: /embed/VIDEO_ID, /shorts/VIDEO_ID
    const embedMatch = parsed.pathname.match(/^\/(embed|shorts|v)\/([^/?]+)/);
    if (embedMatch) {
      return embedMatch[2];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a YouTube URL to a canonical form:
 *   `https://www.youtube.com/watch?v=VIDEO_ID`
 *
 * Strips all tracking parameters (list, index, pp, si, feature, ab_channel, etc.).
 * Returns `null` if the URL does not contain a recognisable video ID.
 */
export function sanitizeYouTubeUrl(url: string): string | null {
  const videoId = extractVideoIdFromUrl(url);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Deduplicate an array of YouTube URLs by video ID.
 * Preserves insertion order (first occurrence wins).
 */
export function deduplicateUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const id = extractVideoIdFromUrl(url) ?? url;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(url);
    }
  }
  return result;
}
