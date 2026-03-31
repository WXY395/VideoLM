/**
 * YouTube content script — auto-injected on YouTube watch pages via manifest.json.
 *
 * Two-tier transcript extraction:
 *   Tier 1: Fetch timedtext XML via caption track URL (fast, ms timestamps, silent)
 *   Tier 2: DOM scraping via transcript panel (reliable fallback, silent)
 *
 * SPA-aware: handles YouTube's pushState navigation without requiring page refresh.
 * Uses player API (getPlayerResponse) for SPA navigations, HTML parsing for initial load.
 */

import {
  extractVideoId,
  extractCaptionTracks,
  extractVideoMetadata,
  extractChapters,
  parseXMLCaptions,
} from '@/extractors/youtube-extractor';
import type { VideoContent, TranscriptSegment, Chapter } from '@/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedContent: VideoContent | null = null;
let cachedUrl = '';

// ---------------------------------------------------------------------------
// 1. Get player response (SPA-aware)
// ---------------------------------------------------------------------------

/**
 * Get ytInitialPlayerResponse — works both on initial page load and SPA navigation.
 *
 * Strategy 1: YouTube player API (#movie_player.getPlayerResponse())
 *   - Works after SPA navigation (pushState)
 *   - Returns live, up-to-date data for the current video
 *
 * Strategy 2: Parse from page HTML (<script> tags)
 *   - Works on initial page load before player is ready
 *   - Data may be stale after SPA navigation
 */
function getPlayerResponse(): any {
  // Strategy 1: Player API (preferred — always current)
  try {
    const player = document.querySelector('#movie_player') as any;
    if (player && typeof player.getPlayerResponse === 'function') {
      const pr = player.getPlayerResponse();
      if (pr?.videoDetails?.videoId) {
        return pr;
      }
    }
  } catch { /* player not ready */ }

  // Strategy 2: Parse from HTML (fallback for initial load)
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;

      const idx = text.indexOf('ytInitialPlayerResponse');
      const afterName = text.indexOf('=', idx);
      if (afterName === -1) continue;

      const jsonStart = text.indexOf('{', afterName);
      if (jsonStart === -1) continue;

      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
      if (jsonEnd === -1) continue;

      return JSON.parse(text.substring(jsonStart, jsonEnd));
    }
  } catch (e) {
    console.error('[VideoLM] Failed to parse ytInitialPlayerResponse', e);
  }

  return null;
}

/**
 * Wait until the player response matches the expected videoId.
 * After SPA navigation, the player briefly returns stale data from the previous video.
 * We poll every 300ms until the videoId matches or timeout.
 */
async function waitForCorrectPlayerResponse(
  expectedVideoId: string | null,
  timeoutMs = 5000,
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const pr = getPlayerResponse();

    if (pr) {
      const prVideoId = pr.videoDetails?.videoId;

      // If we don't have an expected ID (URL parsing failed), accept any response
      if (!expectedVideoId || prVideoId === expectedVideoId) {
        return pr;
      }

      // Player still has old video — wait and retry
      console.log(`[VideoLM] Waiting for player to load video ${expectedVideoId} (currently ${prVideoId})`);
    }

    await sleep(300);
  }

  // Timeout — return whatever we have (better than nothing)
  return getPlayerResponse();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForElement(selector: string, timeout = 5000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) { resolve(el); return; }

    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

// ---------------------------------------------------------------------------
// 2. TIER 1: Fetch timedtext XML (silent, millisecond precision)
// ---------------------------------------------------------------------------

async function extractTranscriptTier1(playerResponse: any): Promise<TranscriptSegment[]> {
  try {
    const tracks = extractCaptionTracks(playerResponse);
    if (tracks.length === 0) return [];

    const bestTrack = tracks.find((t) => !t.isAutoGenerated) ?? tracks[0];
    if (!bestTrack.baseUrl) return [];

    const resp = await fetch(bestTrack.baseUrl, { credentials: 'include' });
    if (!resp.ok) return [];

    const xml = await resp.text();
    if (!xml || xml.length < 10) return [];

    return parseXMLCaptions(xml);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3. TIER 2: Silent DOM scraping (reliable fallback)
// ---------------------------------------------------------------------------

async function extractTranscriptTier2(): Promise<TranscriptSegment[]> {
  const wasExpanded = !!document.querySelector('#collapse:not([hidden])');

  try {
    // If transcript panel is already open, close it first.
    // After SPA navigation, the panel may contain STALE data from the previous video.
    // Always close and re-open to ensure fresh content.
    const existingPanel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"],' +
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
    );
    if (existingPanel) {
      const closeBtn = existingPanel.querySelector('#header button') as HTMLElement;
      if (closeBtn) {
        closeBtn.click();
        await sleep(500);
      }
    }

    // Step 1: Wait for description area to be ready (may still be loading after SPA nav)
    await waitForElement('ytd-video-description-transcript-section-renderer, #description #expand', 3000);

    // Expand description silently (needed to access transcript button)
    const expandBtn = document.querySelector('#expand') as HTMLElement;
    if (expandBtn) {
      expandBtn.click();
      await sleep(500);
    }

    // Step 2: Find and click the transcript button
    const transcriptLabels = [
      '轉錄稿', '转录稿', '字幕記錄', '字幕记录',
      'transcript', 'Transcript', '文字起こし',
    ];

    let clicked = false;
    const buttons = document.querySelectorAll(
      '#description button, ytd-video-description-transcript-section-renderer button'
    );
    for (const btn of buttons) {
      const text = btn.textContent?.trim() || '';
      if (transcriptLabels.some((label) => text.includes(label))) {
        (btn as HTMLElement).click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Restore description state
      if (!wasExpanded) {
        const collapseBtn = document.querySelector('#collapse') as HTMLElement;
        if (collapseBtn) collapseBtn.click();
      }
      return [];
    }

    // Step 3: Wait for segments to FULLY load
    // YouTube loads segments progressively — we must wait until the count stabilizes
    const segments = await waitForStableSegments(8000);

    // Step 4: Close panel + restore description state
    // Modern panel uses PAmodern_transcript_view, legacy uses engagement-panel-searchable-transcript
    const closeBtn = (
      document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"] #header button') ||
      document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #header button')
    ) as HTMLElement;
    if (closeBtn) closeBtn.click();

    if (!wasExpanded) {
      await sleep(100);
      const collapseBtn = document.querySelector('#collapse') as HTMLElement;
      if (collapseBtn) collapseBtn.click();
    }

    return segments;
  } catch (e) {
    console.error('[VideoLM] DOM transcript extraction failed', e);
    return [];
  }
}

/**
 * Selectors for transcript segments. YouTube has two DOM formats:
 *
 * Legacy (pre-2026):
 *   ytd-transcript-segment-renderer
 *     .segment-timestamp  → "0:42"
 *     .segment-text       → "caption text"
 *
 * Modern (2026+, PAmodern_transcript_view):
 *   transcript-segment-view-model
 *     .ytwTranscriptSegmentViewModelTimestamp  → "0:42"
 *     span.yt-core-attributed-string           → "caption text"
 */
const SEGMENT_SELECTORS = [
  'transcript-segment-view-model',   // Modern (2026+)
  'ytd-transcript-segment-renderer', // Legacy
];

function getSegmentSelector(): string {
  for (const sel of SEGMENT_SELECTORS) {
    if (document.querySelector(sel)) return sel;
  }
  return SEGMENT_SELECTORS[0]; // Default to modern
}

/**
 * Wait until transcript segments stop appearing (count stabilizes).
 */
async function waitForStableSegments(timeoutMs = 8000): Promise<TranscriptSegment[]> {
  const startTime = Date.now();
  let lastCount = 0;
  let stableSince = 0;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(300);

    // Check both modern and legacy selectors
    const currentCount = SEGMENT_SELECTORS.reduce(
      (sum, sel) => sum + document.querySelectorAll(sel).length, 0
    );

    if (currentCount > 0 && currentCount === lastCount) {
      // Count hasn't changed — check if it's been stable long enough
      if (stableSince === 0) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 500) {
        // Stable for 500ms — all segments are loaded
        break;
      }
    } else {
      // Count changed or first check — reset stability timer
      lastCount = currentCount;
      stableSince = 0;
    }
  }

  // Read whatever we have (even if timeout — partial is better than nothing)
  if (lastCount > 0) {
    console.log(`[VideoLM] Transcript panel loaded ${lastCount} segments`);
    return readTranscriptSegmentsFromDOM();
  }

  return [];
}

function readTranscriptSegmentsFromDOM(): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  // Try modern format first (2026+)
  const modernEls = document.querySelectorAll('transcript-segment-view-model');
  if (modernEls.length > 0) {
    modernEls.forEach((el) => {
      const timestamp = (
        el.querySelector('.ytwTranscriptSegmentViewModelTimestamp') as HTMLElement
      )?.textContent?.trim() || '';
      const text = (
        el.querySelector('span.yt-core-attributed-string') as HTMLElement
      )?.textContent?.trim() || '';

      const start = parseTimestamp(timestamp);
      if (text) {
        segments.push({ text, start, duration: 0 });
      }
    });
    return segments;
  }

  // Fallback: legacy format
  const legacyEls = document.querySelectorAll('ytd-transcript-segment-renderer');
  legacyEls.forEach((el) => {
    const timestamp = (el.querySelector('.segment-timestamp') as HTMLElement)?.textContent?.trim() || '';
    const text = (el.querySelector('.segment-text') as HTMLElement)?.textContent?.trim() || '';

    const start = parseTimestamp(timestamp);
    if (text) {
      segments.push({ text, start, duration: 0 });
    }
  });

  return segments;
}

/** Parse "0:42" or "1:23:45" to seconds */
function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// ---------------------------------------------------------------------------
// 4. Full extraction pipeline
// ---------------------------------------------------------------------------

async function getVideoContent(): Promise<VideoContent | null> {
  const currentUrl = location.href;

  // Return cached if URL unchanged
  if (cachedContent && cachedUrl === currentUrl) {
    return cachedContent;
  }

  cachedUrl = currentUrl;
  cachedContent = null;

  try {
    // Extract expected videoId from URL
    const expectedVideoId = extractVideoId(currentUrl);

    // Wait for player to load the correct video (critical for SPA navigation).
    // After YouTube SPA navigation, the player may still have the OLD video's data
    // for a brief moment. We poll until the player's videoId matches the URL.
    const pr = await waitForCorrectPlayerResponse(expectedVideoId, 5000);
    if (!pr) return null;

    const meta = extractVideoMetadata(pr);
    const tracks = extractCaptionTracks(pr);
    const rawChapters = extractChapters(pr);

    // --- Two-tier transcript extraction ---
    let segments = await extractTranscriptTier1(pr);
    let extractionTier = 1;

    if (segments.length === 0 && tracks.length > 0) {
      segments = await extractTranscriptTier2();
      extractionTier = 2;
    }

    if (segments.length > 0) {
      console.log(`[VideoLM] Extracted ${segments.length} segments via Tier ${extractionTier}`);
    }

    // Assign segments to chapters
    const chapters: Chapter[] | undefined =
      rawChapters.length > 0
        ? rawChapters.map((ch) => ({
            ...ch,
            segments: segments.filter(
              (s) => s.start >= ch.startTime && s.start < ch.endTime,
            ),
          }))
        : undefined;

    const bestTrack = tracks.find((t) => !t.isAutoGenerated) ?? tracks[0];

    const content: VideoContent = {
      videoId: extractVideoId(currentUrl) ?? pr.videoDetails?.videoId ?? '',
      title: meta.title ?? '',
      author: meta.author ?? '',
      platform: 'youtube',
      transcript: segments,
      chapters,
      duration: meta.duration ?? 0,
      language: bestTrack?.languageCode || 'unknown',
      url: currentUrl,
      metadata: meta.metadata ?? { publishDate: '', viewCount: 0, tags: [] },
    };

    cachedContent = content;
    return content;
  } catch (e) {
    console.error('[VideoLM] Extraction failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return false;
  }

  if (message.type === 'GET_VIDEO_CONTENT') {
    getVideoContent()
      .then((content) => {
        sendResponse({ type: 'VIDEO_CONTENT', data: content });
      })
      .catch((err) => {
        sendResponse({
          type: 'VIDEO_CONTENT',
          data: null,
          error: `Extraction error: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// 6. SPA navigation watcher — clears cache on URL change
// ---------------------------------------------------------------------------

let lastUrl = location.href;

/**
 * YouTube is a SPA — navigating between videos uses pushState, not full page loads.
 * We watch for URL changes and clear the cache so the next GET_VIDEO_CONTENT
 * fetches fresh data for the new video.
 *
 * We use both MutationObserver (catches most navigations) and
 * yt-navigate-finish event (YouTube's custom event for SPA transitions).
 */
function onNavigate() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    cachedContent = null;
    cachedUrl = '';
    console.log('[VideoLM] SPA navigation detected, cache cleared');
  }
}

// MutationObserver catches DOM changes that indicate navigation
const observer = new MutationObserver(onNavigate);
observer.observe(document.documentElement, { childList: true, subtree: true });

// YouTube fires this custom event after SPA navigation completes
document.addEventListener('yt-navigate-finish', onNavigate);

// Also handle back/forward
window.addEventListener('popstate', onNavigate);
