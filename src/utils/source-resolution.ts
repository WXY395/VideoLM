import type { VideoSourceRecord, SourceMatchResult } from '@/types';

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
