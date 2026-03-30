import type { TranscriptSegment, Chapter, VideoContent } from '@/types';

// ---------------------------------------------------------------------------
// extractVideoId
// ---------------------------------------------------------------------------

/**
 * Parse a YouTube URL and return the 11-character video ID, or null.
 * Supports youtube.com/watch, youtu.be, and youtube.com/embed URLs.
 */
export function extractVideoId(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);

    // youtu.be/VIDEO_ID
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }

    // youtube.com/watch?v=VIDEO_ID
    if (parsed.hostname.includes('youtube.com')) {
      // /watch?v=...
      const vParam = parsed.searchParams.get('v');
      if (vParam && /^[\w-]{11}$/.test(vParam)) return vParam;

      // /embed/VIDEO_ID
      const embedMatch = parsed.pathname.match(/^\/embed\/([\w-]{11})/);
      if (embedMatch) return embedMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseXMLCaptions
// ---------------------------------------------------------------------------

/** Decode common HTML entities found in YouTube caption XML. */
function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * Parse YouTube's XML caption format into TranscriptSegment[].
 * Handles HTML entity decoding and normalises whitespace.
 *
 * Uses regex parsing as the primary strategy because YouTube's CSP
 * (Trusted Types) blocks DOMParser in content scripts on youtube.com.
 * Falls back to DOMParser in environments where it's available (tests, background).
 */
export function parseXMLCaptions(xml: string): TranscriptSegment[] {
  if (!xml) return [];

  // Primary: regex parsing (works under Trusted Types CSP)
  const segments = parseXMLCaptionsRegex(xml);
  if (segments.length > 0) return segments;

  // Fallback: DOMParser (for tests and non-YouTube environments)
  return parseXMLCaptionsDom(xml);
}

/** Regex-based XML caption parser — CSP-safe, works on YouTube pages. */
function parseXMLCaptionsRegex(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const regex = /<text\s+start="([^"]*?)"\s+dur="([^"]*?)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    let text = match[3];

    text = decodeHTMLEntities(text);
    text = text.replace(/\n/g, ' ').trim();

    if (text) {
      segments.push({ text, start, duration });
    }
  }

  return segments;
}

/** DOMParser-based fallback (blocked by Trusted Types on YouTube pages). */
function parseXMLCaptionsDom(xml: string): TranscriptSegment[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    if (doc.querySelector('parsererror')) return [];

    const textNodes = doc.querySelectorAll('text');
    const segments: TranscriptSegment[] = [];

    textNodes.forEach((node) => {
      const start = parseFloat(node.getAttribute('start') || '0');
      const duration = parseFloat(node.getAttribute('dur') || '0');
      let text = node.textContent || '';

      text = decodeHTMLEntities(text);
      text = text.replace(/\n/g, ' ').trim();

      segments.push({ text, start, duration });
    });

    return segments;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// formatTranscript
// ---------------------------------------------------------------------------

/** Format seconds into [MM:SS] or [H:MM:SS] depending on needsHours. */
function formatTimestamp(seconds: number, needsHours: boolean): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  return needsHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Format transcript segments into readable text.
 * When `timestamps` is true, each line is prefixed with [MM:SS] or [H:MM:SS].
 */
export function formatTranscript(
  segments: TranscriptSegment[],
  options?: { timestamps?: boolean },
): string {
  if (segments.length === 0) return '';

  const withTs = options?.timestamps ?? false;
  const needsHours = segments.some((s) => s.start >= 3600);

  return segments
    .map((s) => {
      if (withTs) {
        return `[${formatTimestamp(s.start, needsHours)}] ${s.text}`;
      }
      return s.text;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// extractCaptionTracks
// ---------------------------------------------------------------------------

export interface CaptionTrack {
  baseUrl: string;
  name: string;
  languageCode: string;
  isAutoGenerated: boolean;
}

/**
 * Extract available caption tracks from ytInitialPlayerResponse.
 */
export function extractCaptionTracks(playerResponse: any): CaptionTrack[] {
  try {
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];

    return tracks.map((t: any) => ({
      baseUrl: t.baseUrl ?? '',
      name: t.name?.simpleText ?? '',
      languageCode: t.languageCode ?? '',
      isAutoGenerated: t.kind === 'asr',
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// extractChapters
// ---------------------------------------------------------------------------

/**
 * Extract YouTube chapter markers from the playerResponse.
 * Chapters are in playerOverlays -> decoratedPlayerBarRenderer -> markersMap.
 */
export function extractChapters(playerResponse: any): Chapter[] {
  try {
    const markersMap =
      playerResponse?.playerOverlays?.playerOverlayRenderer
        ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
        ?.multiMarkersPlayerBarRenderer?.markersMap;

    if (!Array.isArray(markersMap) || markersMap.length === 0) return [];

    const chapterData = markersMap[0]?.value?.chapters;
    if (!Array.isArray(chapterData)) return [];

    const chapters: Chapter[] = chapterData.map(
      (c: any, i: number, arr: any[]) => {
        const startMs = c.chapterRenderer?.timeRangeStartMillis ?? 0;
        const nextStartMs =
          i < arr.length - 1
            ? arr[i + 1].chapterRenderer?.timeRangeStartMillis ?? 0
            : Infinity;

        return {
          title: c.chapterRenderer?.title?.simpleText ?? '',
          startTime: startMs / 1000,
          endTime: nextStartMs / 1000,
          segments: [] as TranscriptSegment[],
        };
      },
    );

    return chapters;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// extractVideoMetadata
// ---------------------------------------------------------------------------

/**
 * Extract title, author, duration, publish date, view count, and tags
 * from ytInitialPlayerResponse.
 */
export function extractVideoMetadata(
  playerResponse: any,
): Partial<VideoContent> {
  const vd = playerResponse?.videoDetails ?? {};
  const mf = playerResponse?.microformat?.playerMicroformatRenderer ?? {};

  return {
    title: vd.title ?? '',
    author: vd.author ?? '',
    duration: parseInt(vd.lengthSeconds ?? '0', 10) || 0,
    metadata: {
      publishDate: mf.publishDate ?? '',
      viewCount: parseInt(mf.viewCount ?? '0', 10) || 0,
      tags: Array.isArray(vd.keywords) ? vd.keywords : [],
    },
  };
}

// ---------------------------------------------------------------------------
// assignSegmentsToChapters
// ---------------------------------------------------------------------------

/** Assign transcript segments into chapters based on time ranges. */
function assignSegmentsToChapters(
  chapters: Chapter[],
  segments: TranscriptSegment[],
): Chapter[] {
  if (chapters.length === 0) return chapters;

  return chapters.map((ch) => ({
    ...ch,
    segments: segments.filter(
      (s) => s.start >= ch.startTime && s.start < ch.endTime,
    ),
  }));
}

// ---------------------------------------------------------------------------
// extractFullVideoContent
// ---------------------------------------------------------------------------

/**
 * Full extraction pipeline:
 * 1. Get caption tracks, prefer manual over auto-generated
 * 2. Fetch the caption XML
 * 3. Parse segments
 * 4. Extract chapters and metadata
 * 5. Assign segments to chapters
 * 6. Return a complete VideoContent object
 */
export async function extractFullVideoContent(
  playerResponse: any,
  url: string,
): Promise<VideoContent | null> {
  // 1. Caption tracks + fetch
  const tracks = extractCaptionTracks(playerResponse);
  let segments: TranscriptSegment[] = [];
  let language = '';

  if (tracks.length > 0) {
    // Prefer manual captions over auto-generated
    const manualTrack = tracks.find((t) => !t.isAutoGenerated);
    const bestTrack = manualTrack ?? tracks[0];
    language = bestTrack.languageCode;

    // 2. Fetch caption XML
    try {
      const resp = await fetch(bestTrack.baseUrl);
      if (resp.ok) {
        const xml = await resp.text();
        if (xml) {
          segments = parseXMLCaptions(xml);
        }
      }
    } catch {
      // Caption fetch failed — continue with empty transcript
    }
  }
  // If no caption tracks at all, the video has no subtitles.
  // We still return the video info so the UI can show it.

  // 3. Metadata & chapters
  const meta = extractVideoMetadata(playerResponse);
  const rawChapters = extractChapters(playerResponse);

  // 4. Assign segments to chapters
  const chapters =
    rawChapters.length > 0
      ? assignSegmentsToChapters(rawChapters, segments)
      : undefined;

  // 5. Build VideoContent
  const videoId =
    extractVideoId(url) ??
    playerResponse?.videoDetails?.videoId ??
    '';

  return {
    videoId,
    title: meta.title ?? '',
    author: meta.author ?? '',
    platform: 'youtube',
    transcript: segments,
    chapters,
    duration: meta.duration ?? 0,
    language: language || 'unknown',
    url,
    metadata: meta.metadata ?? { publishDate: '', viewCount: 0, tags: [] },
  };
}
