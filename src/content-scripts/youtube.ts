/**
 * YouTube content script — auto-injected on YouTube watch pages via manifest.json.
 *
 * Extracts video transcripts by:
 * 1. Parsing ytInitialPlayerResponse from page HTML for metadata
 * 2. Opening YouTube's built-in transcript panel ("顯示轉錄稿"/"Show transcript")
 * 3. Reading rendered transcript segments from the DOM
 *
 * This DOM scraping approach is the most reliable because:
 * - timedtext API requires POT tokens (returns empty)
 * - get_transcript API returns 400 without proper auth
 * - DOM scraping uses YouTube's own UI, always works when transcripts exist
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
// 1. Extract ytInitialPlayerResponse from page HTML
// ---------------------------------------------------------------------------

function extractPlayerResponseFromPage(): any {
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
    return null;
  } catch (e) {
    console.error('[VideoLM] Failed to parse ytInitialPlayerResponse', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. DOM-based transcript extraction (click "Show transcript" → read DOM)
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

async function extractTranscriptFromDOM(): Promise<TranscriptSegment[]> {
  try {
    // Step 1: Expand description if collapsed
    const expandBtn = document.querySelector('#expand') as HTMLElement;
    if (expandBtn) {
      expandBtn.click();
      await sleep(500);
    }

    // Step 2: Find and click the "Show transcript" button
    // YouTube uses different labels by locale:
    //   繁中: "顯示轉錄稿" or "字幕記錄"
    //   簡中: "显示转录稿"
    //   English: "Show transcript"
    //   日本語: "文字起こしを表示"
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
      return []; // No transcript button found
    }

    // Step 3: Wait for transcript segments to render
    await waitForElement('ytd-transcript-segment-renderer', 5000);
    await sleep(500); // Extra settle time for all segments to load

    // Step 4: Read transcript segments from DOM
    const segmentEls = document.querySelectorAll('ytd-transcript-segment-renderer');
    const segments: TranscriptSegment[] = [];

    segmentEls.forEach((el) => {
      const timestamp = (
        el.querySelector('.segment-timestamp') as HTMLElement
      )?.textContent?.trim() || '';
      const text = (
        el.querySelector('.segment-text') as HTMLElement
      )?.textContent?.trim() || '';

      // Parse timestamp "0:42" or "1:23:45" to seconds
      const parts = timestamp.split(':').map(Number);
      let start = 0;
      if (parts.length === 3) start = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) start = parts[0] * 60 + parts[1];

      if (text) {
        segments.push({ text, start, duration: 0 });
      }
    });

    // Step 5: Close the transcript panel to not leave UI in a changed state
    const closeBtn = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #header button'
    ) as HTMLElement;
    if (closeBtn) closeBtn.click();

    return segments;
  } catch (e) {
    console.error('[VideoLM] DOM transcript extraction failed', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3. Full extraction pipeline
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
    // Extract metadata from playerResponse
    const pr = extractPlayerResponseFromPage();
    if (!pr) return null;

    const meta = extractVideoMetadata(pr);
    const tracks = extractCaptionTracks(pr);
    const rawChapters = extractChapters(pr);

    // Extract transcript via DOM scraping
    const segments = await extractTranscriptFromDOM();

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

    // Determine language
    const bestTrack = tracks.find((t) => !t.isAutoGenerated) ?? tracks[0];
    const language = bestTrack?.languageCode || 'unknown';

    const content: VideoContent = {
      videoId: extractVideoId(currentUrl) ?? pr.videoDetails?.videoId ?? '',
      title: meta.title ?? '',
      author: meta.author ?? '',
      platform: 'youtube',
      transcript: segments,
      chapters,
      duration: meta.duration ?? 0,
      language,
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
// 4. Message listener
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
    return true; // async
  }

  return false;
});

// ---------------------------------------------------------------------------
// 5. SPA navigation watcher
// ---------------------------------------------------------------------------

let lastUrl = location.href;

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    cachedContent = null;
    cachedUrl = '';
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('popstate', () => {
  cachedContent = null;
  cachedUrl = '';
});
