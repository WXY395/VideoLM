/**
 * YouTube content script — injected programmatically via chrome.scripting.executeScript()
 * when the user activates the extension on a YouTube page.
 *
 * Responsibilities:
 * 1. Inject a page-level script to read window.ytInitialPlayerResponse
 * 2. Listen for the data via postMessage
 * 3. Cache the extracted VideoContent
 * 4. Respond to GET_VIDEO_CONTENT messages from popup / background
 * 5. Watch for SPA navigation and invalidate cache
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
// 1. Inject page-level script to grab ytInitialPlayerResponse
// ---------------------------------------------------------------------------

function injectPlayerResponseExtractor(): void {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      try {
        if (window.ytInitialPlayerResponse) {
          window.postMessage({
            type: '__VIDEOLM_PLAYER_RESPONSE__',
            data: JSON.parse(JSON.stringify(window.ytInitialPlayerResponse))
          }, '*');
        }
      } catch(e) {
        console.error('[VideoLM] Failed to extract player response', e);
      }
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
}

// ---------------------------------------------------------------------------
// 2. Listen for postMessage from injected script
// ---------------------------------------------------------------------------

let playerResponseData: any = null;
let playerResponseResolve: ((data: any) => void) | null = null;

function waitForPlayerResponse(): Promise<any> {
  // If we already have data, return immediately
  if (playerResponseData) return Promise.resolve(playerResponseData);

  return new Promise((resolve) => {
    playerResponseResolve = resolve;

    // Timeout after 5 seconds
    setTimeout(() => {
      if (playerResponseResolve === resolve) {
        playerResponseResolve = null;
        resolve(null);
      }
    }, 5000);
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== '__VIDEOLM_PLAYER_RESPONSE__') return;

  playerResponseData = event.data.data;

  if (playerResponseResolve) {
    playerResponseResolve(playerResponseData);
    playerResponseResolve = null;
  }
});

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
    // Inject and wait for data
    injectPlayerResponseExtractor();
    const pr = await waitForPlayerResponse();
    if (!pr) return null;

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
