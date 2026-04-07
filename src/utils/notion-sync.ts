/**
 * Notion export — Citation-safe Transport Layer (Content Integrity Layer)
 * ========================================================================
 * Pipeline: Extraction → Encapsulation → (Notion AI / protected state) → Decoding → Parity
 *
 * Intermediate representation uses XML-like tags `<VIDEO_CITATION id="n"/>`, never Markdown
 * links `[n]` / `(n)` / `[[n] 📺]` — those are only emitted at the final decode step.
 *
 * Pure functions — no DOM, no Chrome API.
 */

import type {
  TranscriptSegment,
  VideoContent,
  VideoCitation,
  NotionExportOptions,
  NotionExportResult,
} from '@/types';
import { formatTime } from '@/processing/rag-optimizer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FUZZY_THRESHOLD = 0.3;
const TIMESTAMP_PROXIMITY = 200;
const FUZZY_WINDOW_SECONDS = 180;
const MONOTONIC_REVERSE_LIMIT = 600;

/** Resolved citation links: `[[n] 📺](url)` */
const DECODED_CITATION_LINK_RE = /\[\[(\d+)\]\s*\u{1F4FA}\]\([^)]+\)/gu;

/**
 * Citation extraction: `[n]` OR bare `n` (1–3 digits) when delimited by whitespace + punctuation.
 * `\d{1,3}` supports long talks with 100+ source indices without overflow.
 */
export const citationRegex = /(?:\[(\d+)\]|(?<=\s)(\d{1,3})(?=[\s.,;)]))/g;

/** Tolerant decoder for `<VIDEO_CITATION />` after Notion AI whitespace / case drift */
export const VIDEO_CITATION_TAG_RE =
  /<\s*VIDEO_CITATION\s+id=["'](\d+)["']\s*\/>/gi;

/** Primary transport fence (v1 — do not rename; paired with CITATION_MAP comment) */
export const VIDEO_CITATION_FENCE_ID = 'VIDEO_CITATION_BLOCK_v1_DO_NOT_TOUCH__SYSTEM';

const VIDEO_CITATION_FENCE_PATTERNS = [
  /^```\s*VIDEO_CITATION_BLOCK_v1_DO_NOT_TOUCH__SYSTEM\s*\r?\n([\s\S]*?)\r?\n```\s*/im,
  /^```\s*VIDEO_CITATION_BLOCK\s*\r?\n([\s\S]*?)\r?\n```\s*/im,
] as const;

const CITATION_MAP_COMMENT_RE = /\n?<!--\s*CITATION_MAP[\s\S]*?-->\s*$/i;

/** Structured map: id → resolved YouTube URL (+ optional timestamp in seconds) */
export type CitationConfidence = 'high' | 'medium' | 'low';

export type CitationStatus = 'resolved' | 'unresolved';

export type CitationMap = {
  [id: string]: {
    url: string | null;
    timestamp?: number;
    /** Resolution confidence: high = algorithm, medium = user override, low = unresolved/fallback */
    confidence?: CitationConfidence;
    /** Whether the citation was successfully resolved or remains unresolved */
    status?: CitationStatus;
  };
};

export interface FinalizeNotionOptions {
  /** Default `warn` */
  parityMode?: 'warn' | 'throw';
  /** When parity fails, append CAUTION callout (default true) */
  appendParityCaution?: boolean;
  /** Input is inner payload only (no ```VIDEO_CITATION_BLOCK fence) */
  skipOuterFence?: boolean;
}

// ---------------------------------------------------------------------------
// Timestamp parsing (hallucination-safe: requires colon)
// ---------------------------------------------------------------------------

interface TimestampHit {
  position: number;
  seconds: number;
}

function extractTimestamps(text: string, maxDuration: number): TimestampHit[] {
  const hits: TimestampHit[] = [];
  const patterns: RegExp[] = [
    /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g,
    /\bat\s+(\d{1,2}:\d{2}(?::\d{2})?)\b/gi,
    /\((\d{1,2}:\d{2}(?::\d{2})?)\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const seconds = parseTimestampString(match[1]);
      if (seconds >= 0 && seconds <= maxDuration) {
        hits.push({ position: match.index, seconds });
      }
    }
  }

  hits.sort((a, b) => a.position - b.position);
  return hits;
}

function parseTimestampString(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Citation extraction (Extraction Layer)
// ---------------------------------------------------------------------------

interface CitationHit {
  id: number;
  position: number;
  context: string;
}

export interface CitationMatch {
  id: number;
  index: number;
  length: number;
  raw: string;
}

function parseCitationIdFromExec(m: RegExpExecArray): number {
  const fromBracket = m[1];
  const fromBare = m[2];
  const s = fromBracket ?? fromBare;
  return parseInt(s, 10);
}

/**
 * Collect all citation matches (non-overlapping, left-to-right).
 */
export function collectCitationMatches(text: string): CitationMatch[] {
  const out: CitationMatch[] = [];
  const re = new RegExp(citationRegex.source, citationRegex.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Do not treat `[n](url)` as a citation — that is Markdown link syntax
    if (m[1] !== undefined) {
      const afterIdx = m.index + m[0].length;
      if (text[afterIdx] === '(') continue;
    }
    const id = parseCitationIdFromExec(m);
    if (!Number.isFinite(id) || id < 1) continue;
    out.push({
      id,
      index: m.index,
      length: m[0].length,
      raw: m[0],
    });
  }
  return out;
}

function extractCitations(text: string): CitationHit[] {
  const matches = collectCitationMatches(text);
  return matches.map((cm) => ({
    id: cm.id,
    position: cm.index,
    context: text.slice(
      Math.max(0, cm.index - 100),
      Math.min(text.length, cm.index + cm.length + 100),
    ),
  }));
}

function stripProtectedTagsForContext(s: string): string {
  return s.replace(new RegExp(VIDEO_CITATION_TAG_RE.source, 'gi'), ' ');
}

/** Collect `<VIDEO_CITATION id="n"/>` positions (left-to-right). */
export function collectProtectedCitationMatches(text: string): CitationMatch[] {
  const out: CitationMatch[] = [];
  const re = new RegExp(VIDEO_CITATION_TAG_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = parseInt(m[1], 10);
    if (!Number.isFinite(id) || id < 1) continue;
    out.push({
      id,
      index: m.index,
      length: m[0].length,
      raw: m[0],
    });
  }
  return out;
}

function extractCitationsFromProtected(text: string): CitationHit[] {
  const matches = collectProtectedCitationMatches(text);
  return matches.map((cm) => ({
    id: cm.id,
    position: cm.index,
    context: stripProtectedTagsForContext(
      text.slice(
        Math.max(0, cm.index - 100),
        Math.min(text.length, cm.index + cm.length + 100),
      ),
    ),
  }));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}

function wordOverlapScore(textA: string, textB: string): number {
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const minSize = Math.min(setA.size, setB.size);
  return intersection / minSize;
}

function findBestSegmentMatch(
  context: string,
  segments: readonly TranscriptSegment[],
  anchorSeconds?: number,
): { segment: TranscriptSegment; score: number } | null {
  let searchSegments = segments;
  if (anchorSeconds !== undefined) {
    const windowStart = anchorSeconds - FUZZY_WINDOW_SECONDS;
    const windowEnd = anchorSeconds + FUZZY_WINDOW_SECONDS;
    searchSegments = segments.filter(
      (s) => s.start >= windowStart && s.start <= windowEnd,
    );
  }

  let bestSegment: TranscriptSegment | null = null;
  let bestScore = 0;

  for (const seg of searchSegments) {
    const score = wordOverlapScore(context, seg.text);
    if (score > bestScore) {
      bestScore = score;
      bestSegment = seg;
    }
  }

  if (!bestSegment || bestScore < FUZZY_THRESHOLD) return null;
  return { segment: bestSegment, score: bestScore };
}

// ---------------------------------------------------------------------------
// buildCitationMap
// ---------------------------------------------------------------------------

export function buildCitationMap(
  text: string,
  segments: readonly TranscriptSegment[],
  videoId: string,
  videoDuration: number,
): VideoCitation[] {
  const timestampHits = extractTimestamps(text, videoDuration);
  const citationHits = extractCitations(text);

  if (citationHits.length === 0) return [];

  const citations: VideoCitation[] = [];
  let lastResolvedTimestamp = -1;

  for (const cite of citationHits) {
    let nearestTs: TimestampHit | null = null;
    for (let i = timestampHits.length - 1; i >= 0; i--) {
      const ts = timestampHits[i];
      if (ts.position <= cite.position) {
        const distance = cite.position - ts.position;
        if (distance <= TIMESTAMP_PROXIMITY) {
          nearestTs = ts;
        }
        break;
      }
    }

    if (nearestTs) {
      const reverseJump = lastResolvedTimestamp - nearestTs.seconds;
      if (reverseJump <= MONOTONIC_REVERSE_LIMIT || lastResolvedTimestamp < 0) {
        citations.push({
          id: cite.id,
          timestamp: nearestTs.seconds,
          videoId,
          confidence: 'exact',
        });
        lastResolvedTimestamp = nearestTs.seconds;
        continue;
      }
    }

    const anchorSeconds = nearestTs?.seconds;
    const fuzzyResult = findBestSegmentMatch(cite.context, segments, anchorSeconds);

    if (fuzzyResult) {
      const ts = Math.floor(fuzzyResult.segment.start);
      citations.push({
        id: cite.id,
        timestamp: ts,
        videoId,
        confidence: 'fuzzy',
      });
      lastResolvedTimestamp = ts;
      continue;
    }

    citations.push({
      id: cite.id,
      timestamp: 0,
      videoId,
      confidence: 'none',
    });
  }

  return citations;
}

/**
 * Resolve timestamps for `<VIDEO_CITATION id="n"/>` — same resolver as `buildCitationMap`,
 * but citation positions come from protected tags (not `[n]` text).
 */
export function buildCitationMapFromProtected(
  protectedText: string,
  segments: readonly TranscriptSegment[],
  videoId: string,
  videoDuration: number,
): VideoCitation[] {
  const timestampHits = extractTimestamps(protectedText, videoDuration);
  const citationHits = extractCitationsFromProtected(protectedText);

  if (citationHits.length === 0) return [];

  const citations: VideoCitation[] = [];
  let lastResolvedTimestamp = -1;

  for (const cite of citationHits) {
    let nearestTs: TimestampHit | null = null;
    for (let i = timestampHits.length - 1; i >= 0; i--) {
      const ts = timestampHits[i];
      if (ts.position <= cite.position) {
        const distance = cite.position - ts.position;
        if (distance <= TIMESTAMP_PROXIMITY) {
          nearestTs = ts;
        }
        break;
      }
    }

    if (nearestTs) {
      const reverseJump = lastResolvedTimestamp - nearestTs.seconds;
      if (reverseJump <= MONOTONIC_REVERSE_LIMIT || lastResolvedTimestamp < 0) {
        citations.push({
          id: cite.id,
          timestamp: nearestTs.seconds,
          videoId,
          confidence: 'exact',
        });
        lastResolvedTimestamp = nearestTs.seconds;
        continue;
      }
    }

    const anchorSeconds = nearestTs?.seconds;
    const fuzzyResult = findBestSegmentMatch(cite.context, segments, anchorSeconds);

    if (fuzzyResult) {
      const ts = Math.floor(fuzzyResult.segment.start);
      citations.push({
        id: cite.id,
        timestamp: ts,
        videoId,
        confidence: 'fuzzy',
      });
      lastResolvedTimestamp = ts;
      continue;
    }

    citations.push({
      id: cite.id,
      timestamp: 0,
      videoId,
      confidence: 'none',
    });
  }

  return citations;
}

// ---------------------------------------------------------------------------
// CitationMap + validation
// ---------------------------------------------------------------------------

function youtubeWatchUrl(videoId: string, timestampSeconds?: number): string {
  if (!videoId) return ''; // No videoId → no URL → citation becomes [[MISSING_n]]
  const base = `https://youtube.com/watch?v=${videoId}`;
  if (timestampSeconds !== undefined && timestampSeconds > 0) {
    return `${base}&t=${timestampSeconds}s`;
  }
  return base;
}

/**
 * Build structured CitationMap from resolved VideoCitation rows (one row per occurrence in text).
 */
/**
 * Build structured CitationMap from resolved VideoCitation rows.
 * Citations with empty videoId are **excluded** — they will become [[MISSING_n]] in the decoder.
 */
export function videoCitationsToCitationMap(
  citations: readonly VideoCitation[],
): CitationMap {
  const map: CitationMap = {};
  for (const c of citations) {
    const ts =
      c.confidence !== 'none' && c.timestamp > 0 ? c.timestamp : undefined;
    const url = youtubeWatchUrl(c.videoId, ts);
    if (!url) continue; // Skip — no videoId means no valid URL
    map[String(c.id)] = { url, timestamp: ts };
  }
  return map;
}

/**
 * Every citation id appearing in `text` must exist in `citationMap` with a non-empty `url`.
 */
export function assertCompleteCitationMap(text: string, map: CitationMap): void {
  const matches = collectCitationMatches(text);
  const seen = new Set<string>();
  for (const m of matches) {
    const key = String(m.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = map[key];
    // Entries with status 'unresolved' are expected — skip validation
    if (entry?.status === 'unresolved') continue;
    if (!entry?.url?.length) {
      console.error(
        `[VideoLM] Incomplete CitationMap: missing or empty url for citation id ${m.id}`,
      );
      return;
    }
  }
}

/** Every distinct `<VIDEO_CITATION id="n"/>` in protected text must have a map entry with url. */
export function assertCompleteCitationMapForProtected(text: string, map: CitationMap): void {
  const matches = collectProtectedCitationMatches(text);
  const seen = new Set<string>();
  for (const m of matches) {
    const key = String(m.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = map[key];
    // Entries with status 'unresolved' are expected — skip validation
    if (entry?.status === 'unresolved') continue;
    if (!entry?.url?.length) {
      console.error(
        `[VideoLM] Incomplete CitationMap (protected): missing or empty url for citation id ${m.id}`,
      );
      return;
    }
  }
}

/**
 * Merge DOM-extracted citation hints into an existing CitationMap.
 * Hints with valid hrefs fill in entries that are missing from the map
 * (e.g., when videoContent is unavailable and timestamp-based resolution failed).
 */
export function mergeCitationHints(
  map: CitationMap,
  hints?: readonly { id: number; href?: string }[],
): CitationMap {
  if (!hints?.length) return map;
  const merged = { ...map };
  for (const h of hints) {
    const key = String(h.id);
    if (!merged[key]?.url && h.href) {
      merged[key] = { url: h.href };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Encapsulation + Protection layers
// ---------------------------------------------------------------------------

/**
 * Replace raw citations with `<VIDEO_CITATION id="n"/>`. Returns replacement count for parity.
 */
export function encapsulateCitations(text: string): { text: string; beforeCount: number } {
  const matches = collectCitationMatches(text);
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const cm = matches[i];
    out = `${out.slice(0, cm.index)}<VIDEO_CITATION id="${cm.id}"/>${out.slice(cm.index + cm.length)}`;
  }
  return { text: out, beforeCount: matches.length };
}

/**
 * HTML comment listing id → canonical URL (transport audit; mapping is still SoT in code).
 */
export function formatCitationMapComment(map: CitationMap): string {
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return '';
  const body = keys.map((k) => `${k}: ${map[k].url ?? '(unresolved)'}`).join('\n');
  return `<!-- CITATION_MAP\n${body}\n-->`;
}

/**
 * Fence + optional CITATION_MAP comment — canonical transport container.
 */
export function wrapVideoCitationTransport(inner: string, citationMap: CitationMap): string {
  const fence = `\`\`\`${VIDEO_CITATION_FENCE_ID}\n${inner}\n\`\`\``;
  const comment = formatCitationMapComment(citationMap);
  return comment ? `${fence}\n${comment}` : fence;
}

/**
 * Fence only (legacy tests / minimal wrap). Prefer `wrapVideoCitationTransport` when a map exists.
 */
export function wrapVideoCitationBlock(inner: string): string {
  return `\`\`\`${VIDEO_CITATION_FENCE_ID}\n${inner}\n\`\`\``;
}

export function stripVideoCitationFence(text: string): string {
  let t = text.trim();
  t = t.replace(CITATION_MAP_COMMENT_RE, '').trim();
  for (const p of VIDEO_CITATION_FENCE_PATTERNS) {
    const m = t.match(p);
    if (m) return m[1].trim();
  }
  return t;
}

// ---------------------------------------------------------------------------
// Decoder (finalizeForNotion)
// ---------------------------------------------------------------------------

function countDecodedLinks(markdown: string): number {
  let n = 0;
  const re = new RegExp(DECODED_CITATION_LINK_RE.source, DECODED_CITATION_LINK_RE.flags);
  while (re.exec(markdown) !== null) n++;
  return n;
}

function countMissingPlaceholders(markdown: string): number {
  const re = /\[\[MISSING_(\d+)\]\]/g;
  let n = 0;
  while (re.exec(markdown) !== null) n++;
  return n;
}

/**
 * Decode `<VIDEO_CITATION id="n"/>` → `[[n] 📺](url)` with tolerant tag matching.
 */
export function finalizeForNotion(
  text: string,
  citationMap: CitationMap,
  options?: FinalizeNotionOptions,
): string {
  const parityMode = options?.parityMode ?? 'warn';
  const appendCaution = options?.appendParityCaution !== false;

  let body = text;
  if (!options?.skipOuterFence) {
    body = stripVideoCitationFence(text);
  }

  const tagRe = new RegExp(VIDEO_CITATION_TAG_RE.source, VIDEO_CITATION_TAG_RE.flags);
  const tagMatches = [...body.matchAll(tagRe)];
  const beforeDecodeCount = tagMatches.length;

  const out = body.replace(tagRe, (_full, idStr: string) => {
    const entry = citationMap[idStr];
    if (!entry?.url) {
      return `[[MISSING_${idStr}]]`;
    }
    return `[[${idStr}] \u{1F4FA}](${entry.url})`;
  });

  const afterCount = countDecodedLinks(out) + countMissingPlaceholders(out);
  if (beforeDecodeCount !== afterCount) {
    const msg = `Citation mismatch: expected ${beforeDecodeCount} citation slot(s), got ${afterCount} after decode (parity)`;
    if (parityMode === 'warn') {
      console.warn(`[VideoLM notion-sync] ⚠️ ${msg}`);
    } else {
      console.error(`[VideoLM] ${msg}`);
    }
    if (appendCaution) {
      return `${out.trimEnd()}\n\n> [!CAUTION] 偵測到 Notion AI 修改了引用結構，請手動校核。`;
    }
  }

  return out;
}

/**
 * Decode `<VIDEO_CITATION id="n"/>` into HTML `<a>` tags for Notion paste.
 *
 * Notion's paste handler reads `text/html` and converts `<a href="...">` into
 * clickable links. Markdown `[text](url)` in `text/plain` is NOT auto-linked.
 *
 * Uses the same fence-stripping and parity logic as `finalizeForNotion`.
 */
export function finalizeForNotionHtml(
  text: string,
  citationMap: CitationMap,
  options?: FinalizeNotionOptions,
): string {
  let body = text;
  if (!options?.skipOuterFence) {
    body = stripVideoCitationFence(text);
  }

  // Escape HTML entities in the body text (but NOT in our injected tags)
  // We do replacement first, then escape the surrounding text
  const tagRe = new RegExp(VIDEO_CITATION_TAG_RE.source, VIDEO_CITATION_TAG_RE.flags);

  const html = body.replace(tagRe, (_full, idStr: string) => {
    const entry = citationMap[idStr];
    if (!entry?.url) {
      return `<span style="color:#d93025;font-weight:600">[MISSING_${idStr}]</span>`;
    }
    // HTML anchor — Notion will convert this into a clickable link on paste
    const safeUrl = entry.url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}" target="_blank">[${idStr}] \u{1F4FA}</a>`;
  });

  // Wrap in basic HTML structure with line breaks preserved
  return html.replace(/\n/g, '<br>\n');
}

// ---------------------------------------------------------------------------
// Numbered-parens → Notion checkbox (line-anchored, n ≤ 20)
// ---------------------------------------------------------------------------

/** `(1) Title` at line start, 1–20 only — skips `(2026)`-style (no match: >2 digits in parens). */
export function convertNumberedParensToCheckboxes(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*)\((\d{1,2})\)\s+(.+)$/);
      if (!m) return line;
      const n = parseInt(m[2], 10);
      if (n > 20) return line;
      return `${m[1]}- [ ] ${m[3]}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Legacy-compatible: injectCitationLinks via encapsulate → decode (no fence)
// ---------------------------------------------------------------------------

export function injectCitationLinks(
  text: string,
  citations: VideoCitation[],
): string {
  const map = videoCitationsToCitationMap(citations);
  const { text: enc } = encapsulateCitations(text);
  return finalizeForNotion(enc, map, {
    parityMode: 'warn',
    appendParityCaution: false,
    skipOuterFence: true,
  });
}

// ---------------------------------------------------------------------------
// convertActionItems + callout + spec
// ---------------------------------------------------------------------------

export function convertActionItems(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*#{1,6}\s/.test(line)) return line;
      const listMatch = line.match(/^(\s*)[*-]\s+(?!\[[ x]\])(.*)/);
      if (!listMatch) return line;
      let indent = listMatch[1].replace(/\t/g, '  ');
      if (indent.length % 2 !== 0) {
        indent = ' '.repeat(Math.round(indent.length / 2) * 2);
      }
      return `${indent}- [ ] ${listMatch[2]}`;
    })
    .join('\n');
}

export function buildCalloutBlock(video: {
  title: string;
  author: string;
  duration: number;
  url: string;
  metadata: { publishDate: string };
}): string {
  const lines = [
    '> [!INFO] \u{1F4FA} Video Source',
    `> **Title:** [${escapeMarkdown(video.title)}](${video.url})`,
    `> **Channel:** ${escapeMarkdown(video.author)}`,
    `> **Duration:** ${formatTime(video.duration)}`,
  ];
  if (video.metadata.publishDate) {
    lines.push(`> **Published:** ${video.metadata.publishDate}`);
  }
  lines.push('> **Generated by:** [VideoLM](https://videolm.app)');
  return lines.join('\n');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([[\]()])/g, '\\$1');
}

export function wrapWithSpecScript(markdown: string): string {
  const spec = [
    '<!--',
    '\u2699\uFE0F VideoLM Export Spec',
    `Do not modify \`\`\`${VIDEO_CITATION_FENCE_ID}\`\`\` fences or <VIDEO_CITATION/> tags.`,
    'Preserve <!-- CITATION_MAP --> and checkbox lines: - [ ] item',
    'Do not modify the callout block.',
    '-->',
  ].join('\n');
  return `${spec}\n\n${markdown}`;
}

// ---------------------------------------------------------------------------
// notionExport — main pipeline
// ---------------------------------------------------------------------------

export function notionExport(
  text: string,
  video: VideoContent,
  options: NotionExportOptions,
  citationHints?: readonly { id: number; href?: string }[],
): NotionExportResult {
  let result = text;
  let citationsResolved = 0;
  let citationsTotal = 0;

  // Line-style (1) headings → checkboxes first (does not interact with citation regex)
  result = convertNumberedParensToCheckboxes(result);

  const inputMode = options.citationInputMode ?? 'plain';

  if (options.includeTimestampLinks) {
    const citations =
      inputMode === 'protected'
        ? buildCitationMapFromProtected(
            result,
            video.transcript,
            video.videoId,
            video.duration,
          )
        : buildCitationMap(
            result,
            video.transcript,
            video.videoId,
            video.duration,
          );
    citationsTotal = citations.length;
    citationsResolved = citations.filter((c) => c.confidence !== 'none').length;

    let citationMap = videoCitationsToCitationMap(citations);

    // Merge DOM-extracted citation hints (fills gaps when videoContent is unavailable)
    citationMap = mergeCitationHints(citationMap, citationHints);

    // Recount resolved after merge — any hint-filled entry counts as resolved
    citationsResolved = Object.keys(citationMap).length;

    // Validate map completeness — warn on missing entries (they become [[MISSING_n]])
    // Do NOT throw: incomplete maps are expected when videoContent is unavailable
    try {
      if (inputMode === 'protected') {
        assertCompleteCitationMapForProtected(result, citationMap);
      } else {
        assertCompleteCitationMap(result, citationMap);
      }
    } catch (e) {
      console.warn('[VideoLM notion-export] Incomplete citation map (some citations will show as MISSING):', e);
      // Continue — finalizeForNotion will emit [[MISSING_n]] for unmapped citations
    }

    const parityMode = options.citationParityMode ?? 'warn';

    if (inputMode === 'protected') {
      const protectedPayload = wrapVideoCitationTransport(result, citationMap);
      const beforeTags = collectProtectedCitationMatches(result).length;
      result = finalizeForNotion(protectedPayload, citationMap, {
        parityMode,
        appendParityCaution: true,
        skipOuterFence: false,
      });
      if (beforeTags !== citationsTotal) {
        console.warn(
          `[VideoLM] citation count mismatch: resolver ${citationsTotal} vs protected tags ${beforeTags}`,
        );
      }
    } else {
      const { text: encapsulated, beforeCount } = encapsulateCitations(result);
      const protectedPayload = wrapVideoCitationTransport(encapsulated, citationMap);
      result = finalizeForNotion(protectedPayload, citationMap, {
        parityMode,
        appendParityCaution: true,
        skipOuterFence: false,
      });
      if (beforeCount !== citationsTotal) {
        console.warn(
          `[VideoLM] citation count mismatch: extract ${citationsTotal} vs encapsulate ${beforeCount}`,
        );
      }
    }
  }

  if (options.includeCheckboxes) {
    result = convertActionItems(result);
  }

  if (options.includeCallout) {
    result = `${buildCalloutBlock(video)}\n\n${result}`;
  }

  if (options.includeSpecScript !== false) {
    result = wrapWithSpecScript(result);
  }

  return {
    markdown: result,
    citationsResolved,
    citationsTotal,
  };
}
