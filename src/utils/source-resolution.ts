import type { VideoSourceRecord, SourceMatchResult, NlmSourceEntry } from '@/types';

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeTitle(normalized: string): string[] {
  return normalized.split(/\s+/).filter(w => w.length >= 2);
}

export function hashFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function createVideoSourceRecord(
  videoId: string,
  title: string,
  channel: string,
  url: string,
): VideoSourceRecord {
  const norm = normalizeTitle(title);
  const tokens = tokenizeTitle(norm);
  const fp = hashFingerprint(norm);
  return {
    sourceId: crypto.randomUUID(),
    videoId,
    title,
    channel,
    url,
    addedAt: Date.now(),
    normalizedTitle: norm,
    tokens,
    fingerprint: fp,
    fingerprintVariants: [
      fp,
      hashFingerprint(norm.slice(0, 20)),
      hashFingerprint(norm.slice(0, 10)),
    ],
    sessions: [],
  };
}

export type FingerprintIndex = Record<string, VideoSourceRecord[]>;

export function buildFingerprintIndex(records: VideoSourceRecord[]): FingerprintIndex {
  const idx: FingerprintIndex = {};
  for (const r of records) {
    (idx[r.fingerprint] ??= []).push(r);
    for (const v of r.fingerprintVariants) {
      if (v !== r.fingerprint) {
        (idx[v] ??= []).push(r);
      }
    }
  }
  return idx;
}

function tokenOverlapScore(normalizedQuery: string, recordTokens: string[]): number {
  const queryTokens = new Set(tokenizeTitle(normalizedQuery));
  if (queryTokens.size === 0 || recordTokens.length === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) {
    if (recordTokens.includes(t)) overlap++;
  }
  return overlap / Math.min(queryTokens.size, recordTokens.length);
}

function prefixMatchScore(normalizedQuery: string, normalizedTitle: string): number {
  const maxLen = Math.min(normalizedQuery.length, normalizedTitle.length);
  if (maxLen === 0) return 0;
  let shared = 0;
  for (let i = 0; i < maxLen; i++) {
    if (normalizedQuery[i] === normalizedTitle[i]) shared++;
    else break;
  }
  return shared / maxLen;
}

const TOKEN_OVERLAP_THRESHOLD = 0.5;
const MATCH_THRESHOLD = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;
const SUGGESTION_THRESHOLD = 0.2;

/** Suggestion result for Quick Fix panel */
export interface SuggestionResult {
  record: VideoSourceRecord;
  score: number;
  /** Individual token overlap score (0–1) for reason heuristic */
  tokenOverlap: number;
  /** Individual prefix match score (0–1) for reason heuristic */
  prefixMatch: number;
}

/**
 * Find the most similar sources from the index for a given source name.
 * Uses the same scoring formula as resolveCitation but with a lower
 * threshold (0.2) since suggestions are advisory, not authoritative.
 *
 * Returns up to `limit` results sorted by score descending.
 * Returns empty array if no candidates score above the threshold.
 */
export function findSimilarSources(
  sourceName: string,
  sourceIndex: readonly VideoSourceRecord[],
  limit = 3,
): SuggestionResult[] {
  const normalized = normalizeTitle(sourceName);

  const scored: SuggestionResult[] = [];
  for (const r of sourceIndex) {
    const tokenScore = tokenOverlapScore(normalized, r.tokens);
    const prefixScore = prefixMatchScore(normalized, r.normalizedTitle);
    const total = tokenScore * 0.6 + prefixScore * 0.3 + 0.1;
    if (total > SUGGESTION_THRESHOLD) {
      scored.push({ record: r, score: total, tokenOverlap: tokenScore, prefixMatch: prefixScore });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function resolveCitation(
  sourceName: string,
  fpIndex: FingerprintIndex,
  sourceIndex: readonly VideoSourceRecord[],
): SourceMatchResult {
  const normalized = normalizeTitle(sourceName);
  const fp = hashFingerprint(normalized);

  const fpHits = fpIndex[fp];
  if (fpHits?.length === 1) {
    return { type: 'matched', record: fpHits[0], score: 1.0 };
  }

  const candidates = sourceIndex.filter(
    r => tokenOverlapScore(normalized, r.tokens) > TOKEN_OVERLAP_THRESHOLD,
  );

  if (candidates.length === 0) {
    return { type: 'not_found', score: 0 };
  }

  const scored = candidates.map(r => ({
    record: r,
    score:
      tokenOverlapScore(normalized, r.tokens) * 0.6 +
      prefixMatchScore(normalized, r.normalizedTitle) * 0.3 +
      0.1,
  }));

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < MATCH_THRESHOLD) {
    return { type: 'not_found', score: best?.score ?? 0 };
  }
  if (best.score > HIGH_CONFIDENCE_THRESHOLD) {
    return { type: 'matched', record: best.record, score: best.score };
  }
  return { type: 'uncertain', record: best.record, score: best.score };
}

// ---------------------------------------------------------------------------
// Cache Backfill — resolve citations using NLM batchexecute source cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BACKFILL_THRESHOLD = 0.4;
const BACKFILL_HIGH_CONFIDENCE = 0.7;
const CHANNEL_WEIGHT = 0.35;

/** Result of cache backfill resolution */
export interface CacheBackfillResult {
  resolved: Map<string, { url: string; videoId: string; confidence: 'high' | 'medium' }>;
  unresolved: string[];
}

/**
 * Resolve unresolved citations using the NLM source cache.
 *
 * 3-tier matching algorithm operating on a small universe (3-10 NLM sources):
 *   Tier 1: VideoId embedded in sourceName → exact match
 *   Tier 2: Token overlap cross-referencing sourceIndex titles + channel name
 *   Tier 3: Elimination (last unmatched pair when total counts equal)
 *
 * Includes safety mechanisms:
 *   - Cache TTL: entries older than 30 min are excluded
 *   - Channel weight: +0.35 when channelName appears in sourceName
 *   - Elimination guard: requires token overlap > 0 or channel match
 */
export function resolveViaCacheBackfill(
  citationSourceNames: ReadonlyArray<{ id: number; sourceName: string }>,
  nlmCache: ReadonlyMap<string, NlmSourceEntry>,
  sourceIndex: readonly VideoSourceRecord[],
): CacheBackfillResult {
  const resolved = new Map<string, { url: string; videoId: string; confidence: 'high' | 'medium' }>();
  const unresolved: string[] = [];

  // --- TTL filter (Step 5a) ---
  const now = Date.now();
  const validCache = new Map<string, NlmSourceEntry>();
  for (const [vid, entry] of nlmCache) {
    if (now - entry.capturedAt < CACHE_TTL_MS) {
      validCache.set(vid, entry);
    }
  }
  if (validCache.size === 0) {
    return { resolved, unresolved: citationSourceNames.map(c => String(c.id)) };
  }

  // --- Build title lookup from sourceIndex for cross-reference ---
  const titleLookup = new Map<string, { normalizedTitle: string; tokens: string[] }>();
  for (const r of sourceIndex) {
    if (validCache.has(r.videoId)) {
      titleLookup.set(r.videoId, { normalizedTitle: r.normalizedTitle, tokens: r.tokens });
    }
  }

  // --- Deduplicate citation source names (same sourceName → same resolution) ---
  const uniqueSources = new Map<string, number[]>(); // sourceName → [citation ids]
  for (const csn of citationSourceNames) {
    const ids = uniqueSources.get(csn.sourceName) ?? [];
    ids.push(csn.id);
    uniqueSources.set(csn.sourceName, ids);
  }

  const matchedVideoIds = new Set<string>();
  const unmatchedSources: Array<{ sourceName: string; ids: number[] }> = [];

  for (const [sourceName, ids] of uniqueSources) {
    const idStr = String(ids[0]);
    let matched = false;

    // --- Tier 1: VideoId embedded in sourceName ---
    for (const [videoId, entry] of validCache) {
      if (matchedVideoIds.has(videoId)) continue;
      if (sourceName.includes(videoId)) {
        const conf = 'high' as const;
        for (const id of ids) {
          resolved.set(String(id), { url: entry.url, videoId, confidence: conf });
        }
        matchedVideoIds.add(videoId);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // --- Tier 2: Token overlap + channel scoring ---
    const sourceNorm = normalizeTitle(sourceName);
    const sourceTokens = tokenizeTitle(sourceNorm);
    let bestScore = 0;
    let bestEntry: NlmSourceEntry | null = null;
    let bestVideoId = '';

    for (const [videoId, entry] of validCache) {
      if (matchedVideoIds.has(videoId)) continue;

      const lookup = titleLookup.get(videoId);
      let score = 0;
      if (lookup) {
        const tokenScore = tokenOverlapScore(sourceNorm, lookup.tokens);
        const prefixScore = prefixMatchScore(sourceNorm, lookup.normalizedTitle);
        score = tokenScore * 0.6 + prefixScore * 0.3 + 0.1;
      } else {
        // Cache-only mode: no sourceIndex record, but interceptor confirmed
        // this videoId exists in the notebook — give base presence score
        score = 0.2;
      }

      // Channel matching — token overlap + substring containment (CJK-friendly)
      if (entry.channelName) {
        const channelNorm = normalizeTitle(entry.channelName);
        const channelTokens = tokenizeTitle(channelNorm);
        let channelScore = 0;
        if (channelTokens.length > 0 && sourceTokens.length > 0) {
          // Tier A: exact token overlap
          const overlap = channelTokens.filter(t => sourceTokens.includes(t)).length;
          if (overlap > 0) {
            channelScore = overlap / channelTokens.length;
          } else {
            // Tier B: substring containment (handles CJK where tokens don't split on spaces)
            // Min length 3 to avoid false positives from short tokens like "ai"
            const hasSubstring =
              channelTokens.some(t => t.length >= 3 && sourceNorm.includes(t)) ||
              sourceTokens.some(t => t.length >= 3 && channelNorm.includes(t));
            if (hasSubstring) {
              channelScore = 0.7; // slightly lower confidence for substring match
            }
          }
        }
        score += CHANNEL_WEIGHT * channelScore;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
        bestVideoId = videoId;
      }
    }

    if (bestEntry && bestScore >= BACKFILL_THRESHOLD) {
      const conf = bestScore >= BACKFILL_HIGH_CONFIDENCE ? 'high' as const : 'medium' as const;
      for (const id of ids) {
        resolved.set(String(id), { url: bestEntry.url, videoId: bestVideoId, confidence: conf });
      }
      matchedVideoIds.add(bestVideoId);
    } else {
      unmatchedSources.push({ sourceName, ids });
    }
  }

  // --- Tier 3: Elimination ---
  const unmatchedCacheEntries = [...validCache.entries()]
    .filter(([vid]) => !matchedVideoIds.has(vid));

  if (
    unmatchedSources.length === 1 &&
    unmatchedCacheEntries.length === 1 &&
    uniqueSources.size === validCache.size
  ) {
    const [lastVideoId, lastEntry] = unmatchedCacheEntries[0];
    const lastSource = unmatchedSources[0];

    // Elimination guard (Step 5c): require minimal semantic overlap
    const sourceNorm = normalizeTitle(lastSource.sourceName);
    const lookup = titleLookup.get(lastVideoId);
    const candidateTitle = lookup?.normalizedTitle ?? '';
    const tokenOverlap = tokenizeTitle(sourceNorm)
      .filter(t => candidateTitle.includes(t)).length;
    const channelTokens = lastEntry.channelName
      ? tokenizeTitle(normalizeTitle(lastEntry.channelName))
      : [];
    const sourceTokensElim = tokenizeTitle(sourceNorm);
    const channelNormElim = lastEntry.channelName ? normalizeTitle(lastEntry.channelName) : '';
    const channelMatch = channelTokens.length > 0 && (
      channelTokens.some(t => sourceTokensElim.includes(t)) ||
      channelTokens.some(t => t.length >= 3 && sourceNorm.includes(t)) ||
      sourceTokensElim.some(t => t.length >= 3 && channelNormElim.includes(t))
    );

    if (tokenOverlap > 0 || channelMatch) {
      for (const id of lastSource.ids) {
        resolved.set(String(id), { url: lastEntry.url, videoId: lastVideoId, confidence: 'medium' });
      }
      matchedVideoIds.add(lastVideoId);
    } else {
      for (const id of lastSource.ids) {
        unresolved.push(String(id));
      }
    }
  } else {
    for (const src of unmatchedSources) {
      for (const id of src.ids) {
        unresolved.push(String(id));
      }
    }
  }

  return { resolved, unresolved };
}
