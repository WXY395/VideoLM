/**
 * YouTube content script — minimal, stable, CSP-safe.
 *
 * This content script only handles:
 * 1. PING — health check from background
 * 2. SPA navigation detection — clears cache flag
 *
 * ALL data extraction (playerResponse, transcript DOM scraping) is done by the
 * background service worker via chrome.scripting.executeScript({ world: 'MAIN' }).
 * This avoids all CSP/Trusted Types/isolated world issues.
 */

// Track navigation for the background to query
let currentVideoUrl = location.href;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return false;
  }

  if (message.type === 'GET_CURRENT_URL') {
    sendResponse({ url: location.href });
    return false;
  }

  return false;
});

// SPA navigation detection
let lastUrl = location.href;

function onNavigate() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    currentVideoUrl = location.href;
  }
}

const observer = new MutationObserver(onNavigate);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('yt-navigate-finish', onNavigate);
window.addEventListener('popstate', onNavigate);
