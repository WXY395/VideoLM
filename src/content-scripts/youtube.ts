/**
 * YouTube content script — auto-injected on YouTube watch pages via manifest.json.
 *
 * Responsibilities:
 * 1. Parse ytInitialPlayerResponse from page HTML (CSP-safe, no script injection)
 * 2. Cache the extracted VideoContent
 * 3. Respond to GET_VIDEO_CONTENT and PING messages from service worker
 * 4. Watch for SPA navigation and invalidate cache
 */

import { extractFullVideoContent } from '@/extractors/youtube-extractor';
import type { VideoContent } from '@/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedContent: VideoContent | null = null;
let cachedUrl: string = location.href;
let extractionPromise: Promise<VideoContent | null> | null = null;

// ---------------------------------------------------------------------------
// 1. Extract ytInitialPlayerResponse from the page
// ---------------------------------------------------------------------------

/**
 * Extract ytInitialPlayerResponse by parsing the page's HTML source.
 *
 * YouTube embeds the player response as a JSON object in a <script> tag:
 *   var ytInitialPlayerResponse = {...};
 *
 * This approach avoids:
 * - Inline script injection (blocked by YouTube's Trusted Types CSP)
 * - postMessage bridge (race conditions)
 * - MAIN world scripts (require extra manifest config)
 */
function extractPlayerResponseFromPage(): any {
  try {
    // Strategy 1: Search script tags for the assignment (with or without 'var')
    // YouTube uses: ytInitialPlayerResponse = {...};  (no 'var' keyword)
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;

      // Find the assignment and extract the JSON object
      const idx = text.indexOf('ytInitialPlayerResponse');
      if (idx === -1) continue;

      // Skip past "ytInitialPlayerResponse = " or "var ytInitialPlayerResponse = "
      const afterName = text.indexOf('=', idx);
      if (afterName === -1) continue;

      const jsonStart = text.indexOf('{', afterName);
      if (jsonStart === -1) continue;

      // Find matching closing brace by counting braces
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }

      if (jsonEnd === -1) continue;

      const jsonStr = text.substring(jsonStart, jsonEnd);
      return JSON.parse(jsonStr);
    }

    return null;
  } catch (e) {
    console.error('[VideoLM] Failed to parse ytInitialPlayerResponse from page', e);
    return null;
  }
}

let playerResponseData: any = null;

// ---------------------------------------------------------------------------
// 3. Extraction pipeline
// ---------------------------------------------------------------------------

async function getVideoContent(): Promise<VideoContent | null> {
  const currentUrl = location.href;

  // Return cached if URL hasn't changed
  if (cachedContent && cachedUrl === currentUrl) {
    return cachedContent;
  }

  // Avoid duplicate extractions
  if (extractionPromise && cachedUrl === currentUrl) {
    return extractionPromise;
  }

  // Invalidate stale data
  cachedUrl = currentUrl;
  playerResponseData = null;
  cachedContent = null;

  extractionPromise = (async () => {
    // Extract player response directly from page HTML (CSP-safe)
    const pr = playerResponseData ?? extractPlayerResponseFromPage();
    if (!pr) return null;

    playerResponseData = pr; // cache for subsequent calls

    const content = await extractFullVideoContent(pr, currentUrl);
    cachedContent = content;
    return content;
  })();

  const result = await extractionPromise;
  extractionPromise = null;
  return result;
}

// ---------------------------------------------------------------------------
// 4. Message listener for GET_VIDEO_CONTENT
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // PING handler — used by service worker to check if content script is loaded
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return false;
  }

  if (message.type !== 'GET_VIDEO_CONTENT') return false;

  // Must return true to indicate async response
  getVideoContent().then((content) => {
    if (content) {
      sendResponse({ type: 'VIDEO_CONTENT', data: content });
    } else {
      sendResponse({ type: 'VIDEO_CONTENT', data: null });
    }
  });

  return true;
});

// ---------------------------------------------------------------------------
// 5. SPA navigation watcher (YouTube uses History API)
// ---------------------------------------------------------------------------

let lastUrl = location.href;

const navigationObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // Invalidate cache on navigation
    cachedContent = null;
    cachedUrl = '';
    playerResponseData = null;
    extractionPromise = null;
  }
});

navigationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// Also listen for popstate (back/forward)
window.addEventListener('popstate', () => {
  cachedContent = null;
  cachedUrl = '';
  playerResponseData = null;
  extractionPromise = null;
});
