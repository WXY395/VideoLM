/**
 * Global dedup cache — tracks ALL imported video IDs in chrome.storage.local.
 *
 * Simple approach: one global Set of video IDs, no per-notebook partitioning.
 * Prevents the same video from being imported twice regardless of which notebook.
 *
 * Trade-off: a user who intentionally wants the same video in two different
 * notebooks would need to use "force import" (future Pro feature).
 * This is acceptable because 99% of duplicate imports are accidental.
 */

const STORAGE_KEY = 'videolm_imported_vids';
const MAX_CACHED_IDS = 2000; // trim oldest if exceeded

/** Extract video ID from a YouTube URL */
function extractVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

/** Get the global set of imported video IDs */
async function loadCache(): Promise<string[]> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || [];
  } catch {
    return [];
  }
}

/**
 * Remove specific video IDs from the cache (for force-reimport).
 */
export async function removeFromDedupCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    const existing = await loadCache();
    const toRemove = new Set<string>();
    for (const url of urls) {
      const vid = extractVideoId(url);
      if (vid) toRemove.add(vid);
    }
    const filtered = existing.filter(id => !toRemove.has(id));
    await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
    console.log(`[VideoLM] Removed ${toRemove.size} IDs from dedup cache`);
  } catch { /* ignore */ }
}

/**
 * Filter out URLs that have already been imported (globally).
 */
export async function deduplicateAgainstCache(
  urls: string[],
): Promise<{ uniqueUrls: string[]; skippedCount: number }> {
  const cached = new Set(await loadCache());
  if (cached.size === 0) return { uniqueUrls: urls, skippedCount: 0 };

  const uniqueUrls = urls.filter(url => {
    const vid = extractVideoId(url);
    return vid ? !cached.has(vid) : true;
  });

  const skippedCount = urls.length - uniqueUrls.length;
  if (skippedCount > 0) {
    console.log(`[VideoLM] Local dedup: ${skippedCount}/${urls.length} already imported`);
  }
  return { uniqueUrls, skippedCount };
}

/**
 * Record video IDs as imported (append to global cache).
 */
export async function addToDedupCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    const existing = await loadCache();
    const existingSet = new Set(existing);
    for (const url of urls) {
      const vid = extractVideoId(url);
      if (vid) existingSet.add(vid);
    }
    // Keep only most recent entries
    const trimmed = [...existingSet].slice(-MAX_CACHED_IDS);
    await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
  } catch { /* ignore */ }
}
