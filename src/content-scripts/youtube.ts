/**
 * YouTube content script — handles:
 * 1. PING — health check from background
 * 2. SPA navigation detection — re-injects NotebookLM buttons
 * 3. NotebookLM button injection on video & channel pages
 */

import { t } from '@/utils/i18n';
import { queryFirst } from '@/utils/dom';
import { YT } from '@/config/selectors';

// ---------------------------------------------------------------------------
// Inline SVG icon (teal V mark from VideoLM logo)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Toast helper — calls toast-ui.ts which runs in the same ISOLATED world
// ---------------------------------------------------------------------------
function showToastUI(opts: {
  state: 'importing' | 'success' | 'error';
  text: string;
  subtext?: string;
  progress?: number;
  viewUrl?: string;
  dismissAfter?: number;
}): void {
  const fn = (window as any)[Symbol.for('videolm_showToast')];
  if (typeof fn === 'function') {
    fn(opts);
  }
}

const VIDEOLM_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none">
  <path d="M4 4L12 20L17 10L20 10" stroke="#00838F" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="20" cy="6" r="2" fill="#FFB300"/>
</svg>`;

const BUTTON_ID_VIDEO = 'videolm-nlm-btn-video';
const BUTTON_ID_CHANNEL = 'videolm-nlm-btn-channel';
const BUTTON_ID_PLAYLIST = 'videolm-nlm-btn-playlist'; // L-1 FIX: was inline string
const BUTTON_ID_SEARCH = 'videolm-nlm-btn-search';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Extension context health check
// ---------------------------------------------------------------------------
/** Returns true if extension context is alive (chrome.runtime not invalidated) */
function isExtensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Safe sendMessage — checks extension context first.
 * H-3 FIX: Show toast warning instead of force-reloading the page.
 */
function safeSendMessage(message: any, callback?: (response: any) => void): void {
  if (!isExtensionAlive()) {
    // Extension was reloaded — show a gentle warning instead of force-reloading
    showToastUI({
      state: 'error',
      text: t('toast_extension_updated'),
      dismissAfter: 8000,
    });
    return;
  }
  // H-4 FIX: Check chrome.runtime.lastError in callback
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[VideoLM] sendMessage error:', chrome.runtime.lastError.message);
    }
    callback?.(response);
  });
}

// ---------------------------------------------------------------------------
// Button styling — matches YouTube's native pill buttons
// ---------------------------------------------------------------------------
function createNlmButton(id: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = id;
  btn.setAttribute('aria-label', label);

  // Container style — YouTube pill button look
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 16px',
    height: '36px',
    borderRadius: '18px',
    border: 'none',
    backgroundColor: 'var(--yt-spec-badge-chip-background, #f2f2f2)',
    color: 'var(--yt-spec-text-primary, #0f0f0f)',
    fontFamily: '"Roboto","Arial",sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    lineHeight: '36px',
    whiteSpace: 'nowrap',
    marginLeft: '8px',
    transition: 'background-color 0.1s',
  });

  // Icon
  const iconSpan = document.createElement('span');
  iconSpan.innerHTML = VIDEOLM_ICON_SVG;
  iconSpan.style.display = 'inline-flex';
  iconSpan.style.alignItems = 'center';

  // Label
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;

  btn.appendChild(iconSpan);
  btn.appendChild(labelSpan);

  // Hover effect
  btn.addEventListener('mouseenter', () => {
    btn.style.backgroundColor = 'var(--yt-spec-button-chip-background-hover, #e5e5e5)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
  });

  return btn;
}

// ---------------------------------------------------------------------------
// Video page button (next to Like / Share / Save)
// ---------------------------------------------------------------------------
function injectVideoButton(): void {
  // Already injected
  if (document.getElementById(BUTTON_ID_VIDEO)) return;

  // Not a watch page
  if (!location.pathname.startsWith('/watch')) return;

  // Inject into #owner row (channel name + subscribe area).
  // This container is STABLE across SPA navigations — YouTube updates it
  // in-place rather than replacing the entire subtree like #actions.
  const ownerContainer = queryFirst(YT.INJECT.VIDEO);
  if (!ownerContainer) return;

  const btn = createNlmButton(BUTTON_ID_VIDEO, t('btn_notebooklm'));

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const title = getVideoTitle() || '影片';

    // Visual feedback — button state change (instant)
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    const originalLabel = labelEl.textContent;
    labelEl.textContent = t('common_importing');

    // Toast feedback — content-script native (instant, no SW round-trip)
    showToastUI({
      state: 'importing',
      text: t('toast_importing_video', [title]),
      progress: 50,
    });

    safeSendMessage(
      {
        type: 'QUICK_IMPORT',
        videoUrl: location.href,
        videoTitle: title,
      },
      (_response) => {
        // Reset button after response (toast will be updated by SW)
        setTimeout(() => {
          btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
          btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
          labelEl.textContent = originalLabel;
        }, 2000);
      },
    );
  });

  // Append to #owner — appears after subscribe button, stays across SPA nav
  ownerContainer.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Channel page button (near subscribe button)
// ---------------------------------------------------------------------------
function injectChannelButton(): void {
  if (document.getElementById(BUTTON_ID_CHANNEL)) return;

  // Channel page patterns: /@handle, /@handle/videos, /channel/ID
  const isChannel =
    /^\/@[^/]+/.test(location.pathname) || location.pathname.startsWith('/channel/');
  if (!isChannel) return;

  // Fallback chain: 2024+ layout → legacy → last resort
  const targetContainer = queryFirst(YT.INJECT.CHANNEL);
  if (!targetContainer) return;

  const btn = createNlmButton(BUTTON_ID_CHANNEL, t('btn_notebooklm'));

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Visual feedback — button state change (instant)
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    labelEl.textContent = t('btn_extracting');

    // Extract URLs directly from DOM — no round-trip needed
    const urls = extractVideoUrlsFromDom();
    if (urls.length > 0) {
      labelEl.textContent = t('btn_importing_count', [urls.length.toString()]);

      // Toast feedback — content-script native (instant)
      showToastUI({
        state: 'importing',
        text: t('toast_processing_videos', [urls.length.toString()]),
        progress: 10,
      });

      safeSendMessage(
        {
          type: 'BATCH_IMPORT',
          urls,
          pageTitle: getPageTitle(),
          source: 'button', // distinguish from popup-triggered import
        },
        () => {
          // Reset button (toast will be updated by SW via tabs.sendMessage)
          setTimeout(() => {
            btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
            btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
            labelEl.textContent = t('btn_notebooklm');
          }, 3000);
        },
      );
    } else {
      labelEl.textContent = t('btn_no_videos');
      showToastUI({
        state: 'error',
        text: t('toast_no_videos'),
        dismissAfter: 3000,
      });
      setTimeout(() => {
        btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
        btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
        labelEl.textContent = t('btn_notebooklm');
      }, 2000);
    }
  });

  // Append to the actions container
  targetContainer.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Playlist page button (next to playlist title / shuffle button)
// ---------------------------------------------------------------------------
function injectPlaylistButton(): void {
  if (document.getElementById(BUTTON_ID_PLAYLIST)) return;

  if (!location.pathname.startsWith('/playlist')) return;

  const headerActions = queryFirst(YT.INJECT.PLAYLIST);
  if (!headerActions) return;

  const btn = createNlmButton(BUTTON_ID_PLAYLIST, t('btn_notebooklm'));

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    const urls = extractVideoUrlsFromDom();
    if (urls.length > 0) {
      labelEl.textContent = t('btn_importing_count', [urls.length.toString()]);

      // Toast feedback — content-script native (instant)
      showToastUI({
        state: 'importing',
        text: t('toast_processing_videos', [urls.length.toString()]),
        progress: 10,
      });

      safeSendMessage(
        {
          type: 'BATCH_IMPORT',
          urls,
          pageTitle: getPageTitle(),
          source: 'button',
        },
        () => {
          setTimeout(() => {
            btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
            btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
            labelEl.textContent = t('btn_notebooklm');
          }, 3000);
        },
      );
    } else {
      labelEl.textContent = t('btn_no_videos');
      showToastUI({
        state: 'error',
        text: t('toast_no_videos'),
        dismissAfter: 3000,
      });
      setTimeout(() => {
        btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
        btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
        labelEl.textContent = t('btn_notebooklm');
      }, 2000);
    }
  });

  headerActions.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Search results page button (above filter chips)
// ---------------------------------------------------------------------------
function injectSearchButton(): void {
  if (document.getElementById(BUTTON_ID_SEARCH)) return;
  if (!location.pathname.startsWith('/results')) return;

  // NOTE: #filter-menu and ytd-search-filter-group-renderer only exist AFTER
  // a filter chip is applied — do NOT use them as primary selectors.
  const searchContainer = queryFirst<HTMLElement>(YT.INJECT.SEARCH);
  if (!searchContainer) return;
  // Check if first-priority selector matched (sub-menu row) for prepend strategy
  const isSubMenu = searchContainer.matches(YT.INJECT.SEARCH[0]);

  const btn = createNlmButton(BUTTON_ID_SEARCH, t('btn_notebooklm'));
  btn.style.marginLeft = '0';
  btn.style.marginRight = '8px';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    labelEl.textContent = t('btn_extracting');

    const urls = extractVideoUrlsFromDom();
    if (urls.length > 0) {
      labelEl.textContent = t('btn_importing_count', [urls.length.toString()]);

      showToastUI({
        state: 'importing',
        text: t('toast_processing_search', [urls.length.toString()]),
        progress: 10,
      });

      safeSendMessage(
        {
          type: 'BATCH_IMPORT',
          urls,
          pageTitle: getPageTitle(),
          source: 'button',
        },
        () => {
          setTimeout(() => {
            btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
            btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
            labelEl.textContent = t('btn_notebooklm');
          }, 3000);
        },
      );
    } else {
      labelEl.textContent = t('btn_no_videos');
      showToastUI({
        state: 'error',
        text: t('toast_no_videos_scroll'),
        dismissAfter: 4000,
      });
      setTimeout(() => {
        btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
        btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
        labelEl.textContent = t('btn_notebooklm');
      }, 2000);
    }
  });

  if (isSubMenu) {
    // Prepend into the Sort/Filter row — button appears LEFT of "篩選器"
    searchContainer.prepend(btn);
  } else {
    // Fallback: insert as very first child of the primary/section container
    searchContainer.insertAdjacentElement('afterbegin', btn);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getVideoTitle(): string {
  const el = queryFirst(YT.TITLE.VIDEO);
  return el?.textContent?.trim() || '';
}

function getChannelName(): string {
  const el = queryFirst(YT.TITLE.CHANNEL);
  return el?.textContent?.trim() || '';
}

/**
 * Extract video URLs directly from the current page's DOM.
 * Content script can access the page DOM directly — no need for
 * chrome.scripting.executeScript round-trip.
 */
function extractVideoUrlsFromDom(): string[] {
  const path = location.pathname;
  let selector = '';

  if (/^\/@[^/]+/.test(path) || path.startsWith('/channel/')) {
    selector = YT.LINKS.CHANNEL;
  } else if (path.startsWith('/playlist')) {
    selector = YT.LINKS.PLAYLIST;
  } else if (path.startsWith('/results')) {
    selector = YT.LINKS.SEARCH;
  } else {
    return [location.href]; // Single video page
  }

  const adRe = new RegExp(YT.AD.PATTERN, 'i');
  const links = document.querySelectorAll<HTMLAnchorElement>(selector);
  const seen = new Set<string>();
  const urls: string[] = [];

  links.forEach((a) => {
    if (!a.href) return;

    // --- Ad / Promoted video filter ---
    const renderer = a.closest(YT.AD.RENDERERS);
    if (renderer) {
      // Signal 1: [is-promoted] attribute — YouTube's canonical promoted video flag
      if (renderer.hasAttribute('is-promoted')) return;

      // Signal 2: ytd-search-pyv-renderer parent — search promoted video slot
      if (a.closest(YT.AD.PROMOTED_SLOT)) return;

      // Signal 3: visible ad / sponsored badge text inside the card
      const badgeText = renderer.querySelector(YT.AD.BADGES)?.textContent?.trim() || '';
      if (adRe.test(badgeText)) return;

      // Signal 4: aria-label containing ad/sponsored wording on any child element
      const hasAdLabel = Array.from(
        renderer.querySelectorAll('[aria-label]'),
      ).some((el) => adRe.test(el.getAttribute('aria-label') || ''));
      if (hasAdLabel) return;
    }
    // --- End ad filter ---

    // Normalize: strip tracking params, keep only watch?v=ID
    try {
      const u = new URL(a.href);
      const videoId = u.searchParams.get('v');
      if (videoId && !seen.has(videoId)) {
        seen.add(videoId);
        urls.push(`https://www.youtube.com/watch?v=${videoId}`);
      }
    } catch { /* skip invalid URLs */ }
  });

  return urls;
}

/**
 * Get page title — uses document.title as primary source (same as popup).
 * This matches the popup's approach: `tab.title.replace(' - YouTube', '')`
 * and avoids relying on fragile YouTube DOM selectors that break with layout changes.
 */
function getPageTitle(): string {
  return document.title.replace(/ - YouTube$/, '').trim() || 'YouTube Page';
}

// ---------------------------------------------------------------------------
// Injection orchestrator
// ---------------------------------------------------------------------------
function tryInjectButtons(): void {
  injectVideoButton();
  injectChannelButton();
  injectPlaylistButton();
  injectSearchButton();
}

function removeAllButtons(): void {
  document.getElementById(BUTTON_ID_VIDEO)?.remove();
  document.getElementById(BUTTON_ID_CHANNEL)?.remove();
  document.getElementById(BUTTON_ID_PLAYLIST)?.remove();
  document.getElementById(BUTTON_ID_SEARCH)?.remove();
}

// ---------------------------------------------------------------------------
// Targeted MutationObserver — watches for anchor elements to appear
// Pattern used by Return YouTube Dislike, Enhancer for YouTube, etc.
//
// Instead of polling with setTimeout, we observe the DOM for the specific
// elements we need (share button, subscribe area, etc.) and inject the
// moment they appear. This is instant and reliable across SPA navigations.
// ---------------------------------------------------------------------------
let lastUrl = location.href;

/**
 * Single MutationObserver that fires on every DOM change.
 * Lightweight: just checks if our button exists, if not, tries to inject.
 */
const observer = new MutationObserver(() => {
  // Detect SPA navigation
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeAllButtons();
  }

  // Try to inject if button is missing on this page type
  const path = location.pathname;

  if (path.startsWith('/watch') && !document.getElementById(BUTTON_ID_VIDEO)) {
    injectVideoButton();
  } else if (
    (/^\/@[^/]+/.test(path) || path.startsWith('/channel/')) &&
    !document.getElementById(BUTTON_ID_CHANNEL)
  ) {
    injectChannelButton();
  } else if (
    path.startsWith('/playlist') &&
    !document.getElementById(BUTTON_ID_PLAYLIST)
  ) {
    injectPlaylistButton();
  } else if (
    path.startsWith('/results') &&
    !document.getElementById(BUTTON_ID_SEARCH)
  ) {
    injectSearchButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Aggressive retry — YouTube Polymer components render asynchronously,
// so the injection target might not exist on first attempt.
function tryInjectWithRetry(retriesLeft = 5): void {
  tryInjectButtons();
  // If the button for the current page type wasn't injected, retry
  const path = location.pathname;
  const needsRetry =
    (path.startsWith('/watch') && !document.getElementById(BUTTON_ID_VIDEO)) ||
    ((/^\/@[^/]+/.test(path) || path.startsWith('/channel/')) && !document.getElementById(BUTTON_ID_CHANNEL)) ||
    (path.startsWith('/playlist') && !document.getElementById(BUTTON_ID_PLAYLIST)) ||
    (path.startsWith('/results') && !document.getElementById(BUTTON_ID_SEARCH));
  if (needsRetry && retriesLeft > 0) {
    setTimeout(() => tryInjectWithRetry(retriesLeft - 1), 500);
  }
}

// YouTube fires this custom event after SPA navigation completes
document.addEventListener('yt-navigate-finish', () => {
  removeAllButtons();
  tryInjectWithRetry();
});

// Also handle yt-page-data-updated (fires when page data is fully loaded)
document.addEventListener('yt-page-data-updated', () => {
  tryInjectWithRetry();
});

// Initial injection for hard page loads — retry up to 5x (every 500ms)
tryInjectWithRetry();

// ---------------------------------------------------------------------------
// Heartbeat — safety net every 2s for cases where observer misses
// H-2 FIX: Store interval ID + reduce frequency. Clear on extension invalidation.
// ---------------------------------------------------------------------------
const heartbeatId = setInterval(() => {
  // H-2/H-4: Stop polling if extension context is dead
  if (!isExtensionAlive()) {
    clearInterval(heartbeatId);
    observer.disconnect();
    return;
  }

  const path = location.pathname;

  // Detect URL change (backup for observer)
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeAllButtons();
  }

  if (path.startsWith('/watch') && !document.getElementById(BUTTON_ID_VIDEO)) {
    injectVideoButton();
  }
  if ((/^\/@[^/]+/.test(path) || path.startsWith('/channel/')) && !document.getElementById(BUTTON_ID_CHANNEL)) {
    injectChannelButton();
  }
  if (path.startsWith('/playlist') && !document.getElementById(BUTTON_ID_PLAYLIST)) {
    injectPlaylistButton();
  }
  if (path.startsWith('/results') && !document.getElementById(BUTTON_ID_SEARCH)) {
    injectSearchButton();
  }
}, 1000);
