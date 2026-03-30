/**
 * YouTube content script — auto-injected on YouTube watch pages via manifest.json.
 *
 * This content script ONLY extracts the raw playerResponse data from the page HTML.
 * The actual caption fetching happens in the background service worker, because
 * MV3 content script fetch() uses the extension's origin, which YouTube rejects.
 *
 * Flow:
 *   Content script (here): parse HTML → extract playerResponse JSON
 *   Background service worker: receive playerResponse → fetch captions → build VideoContent
 */

// ---------------------------------------------------------------------------
// Extract ytInitialPlayerResponse from the page
// ---------------------------------------------------------------------------

/**
 * Extract ytInitialPlayerResponse by parsing the page's HTML source.
 * Uses brace-counting to find the complete JSON object.
 * CSP-safe: no script injection, no DOMParser, no MAIN world access.
 */
function extractPlayerResponseFromPage(): any {
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;

      const idx = text.indexOf('ytInitialPlayerResponse');
      if (idx === -1) continue;

      const afterName = text.indexOf('=', idx);
      if (afterName === -1) continue;

      const jsonStart = text.indexOf('{', afterName);
      if (jsonStart === -1) continue;

      // Brace-counting to find matching closing brace
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

// ---------------------------------------------------------------------------
// State & Caching
// ---------------------------------------------------------------------------

let cachedPlayerResponse: any = null;
let cachedUrl: string = '';

function getPlayerResponse(): any {
  const currentUrl = location.href;

  if (cachedPlayerResponse && cachedUrl === currentUrl) {
    return cachedPlayerResponse;
  }

  cachedUrl = currentUrl;
  cachedPlayerResponse = extractPlayerResponseFromPage();
  return cachedPlayerResponse;
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return false;
  }

  if (message.type === 'GET_PLAYER_RESPONSE') {
    const pr = getPlayerResponse();
    if (pr) {
      sendResponse({ type: 'PLAYER_RESPONSE', data: pr });
    } else {
      sendResponse({
        type: 'PLAYER_RESPONSE',
        data: null,
        error: 'Could not find ytInitialPlayerResponse in page HTML. Try refreshing the page.',
      });
    }
    return false; // synchronous response
  }

  return false;
});

// ---------------------------------------------------------------------------
// SPA navigation watcher (YouTube uses History API)
// ---------------------------------------------------------------------------

let lastUrl = location.href;

const navigationObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    cachedPlayerResponse = null;
    cachedUrl = '';
  }
});

navigationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

window.addEventListener('popstate', () => {
  cachedPlayerResponse = null;
  cachedUrl = '';
});
