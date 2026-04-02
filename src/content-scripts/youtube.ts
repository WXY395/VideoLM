/**
 * YouTube content script — handles:
 * 1. PING — health check from background
 * 2. SPA navigation detection — re-injects NotebookLM buttons
 * 3. NotebookLM button injection on video & channel pages
 */

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
  const fn = (window as any).__videolm_showToast;
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
 * If dead, reloads the page to get a fresh content script.
 */
function safeSendMessage(message: any, callback?: (response: any) => void): void {
  if (!isExtensionAlive()) {
    // Extension was reloaded — need a page refresh for fresh content script
    location.reload();
    return;
  }
  chrome.runtime.sendMessage(message, callback);
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
  const ownerContainer =
    document.querySelector('ytd-watch-metadata #owner') ||
    document.querySelector('#above-the-fold #owner');

  if (!ownerContainer) return;

  const btn = createNlmButton(BUTTON_ID_VIDEO, 'NotebookLM');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const title = getVideoTitle() || '影片';

    // Visual feedback — button state change (instant)
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    const originalLabel = labelEl.textContent;
    labelEl.textContent = 'Importing...';

    // Toast feedback — content-script native (instant, no SW round-trip)
    showToastUI({
      state: 'importing',
      text: `正在匯入「${title}」...`,
      subtext: `Importing "${title}"...`,
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

  // Strategy 1: New YouTube layout — yt-flexible-actions-view-model (2024+)
  // Strategy 2: Legacy — #subscribe-button inside channel header
  // Strategy 3: Fallback — #owner container (top-row area)
  const targetContainer =
    document.querySelector('yt-page-header-renderer yt-flexible-actions-view-model') ||
    document.querySelector('yt-page-header-renderer #buttons') ||
    document.querySelector('#channel-header-container #buttons') ||
    document.querySelector('#owner');

  if (!targetContainer) return;

  const btn = createNlmButton(BUTTON_ID_CHANNEL, 'NotebookLM');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Visual feedback — button state change (instant)
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    labelEl.textContent = 'Extracting...';

    // Extract URLs directly from DOM — no round-trip needed
    const urls = extractVideoUrlsFromDom();
    if (urls.length > 0) {
      labelEl.textContent = `Importing ${urls.length}...`;

      // Toast feedback — content-script native (instant)
      showToastUI({
        state: 'importing',
        text: `正在處理 ${urls.length} 個影片...`,
        subtext: `Processing ${urls.length} videos...`,
        progress: 10,
      });

      safeSendMessage(
        {
          type: 'BATCH_IMPORT',
          urls,
          pageTitle: getPageTitle(),
        },
        () => {
          // Reset button (toast will be updated by SW via tabs.sendMessage)
          setTimeout(() => {
            btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
            btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
            labelEl.textContent = 'NotebookLM';
          }, 3000);
        },
      );
    } else {
      labelEl.textContent = 'No videos found';
      showToastUI({
        state: 'error',
        text: '找不到影片',
        subtext: 'No videos found on this page',
        dismissAfter: 3000,
      });
      setTimeout(() => {
        btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
        btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
        labelEl.textContent = 'NotebookLM';
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
  if (document.getElementById('videolm-nlm-btn-playlist')) return;

  if (!location.pathname.startsWith('/playlist')) return;

  const headerActions =
    document.querySelector('ytd-playlist-header-renderer .metadata-action-bar') ||
    document.querySelector('ytd-playlist-header-renderer #top-level-buttons-computed') ||
    document.querySelector('.immersive-header-content .metadata-action-bar');

  if (!headerActions) return;

  const btn = createNlmButton('videolm-nlm-btn-playlist', 'NotebookLM');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    const urls = extractVideoUrlsFromDom();
    if (urls.length > 0) {
      labelEl.textContent = `Importing ${urls.length}...`;

      // Toast feedback — content-script native (instant)
      showToastUI({
        state: 'importing',
        text: `正在處理 ${urls.length} 個影片...`,
        subtext: `Processing ${urls.length} videos...`,
        progress: 10,
      });

      safeSendMessage(
        {
          type: 'BATCH_IMPORT',
          urls,
          pageTitle: getPageTitle(),
        },
        () => {
          setTimeout(() => {
            btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
            btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
            labelEl.textContent = 'NotebookLM';
          }, 3000);
        },
      );
    } else {
      labelEl.textContent = 'No videos found';
      showToastUI({
        state: 'error',
        text: '找不到影片',
        subtext: 'No videos found on this page',
        dismissAfter: 3000,
      });
      setTimeout(() => {
        btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
        btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
        labelEl.textContent = 'NotebookLM';
      }, 2000);
    }
  });

  headerActions.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getVideoTitle(): string {
  const el =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('#title h1 yt-formatted-string') ||
    document.querySelector('h1.title');
  return el?.textContent?.trim() || '';
}

function getChannelName(): string {
  const el =
    document.querySelector('ytd-channel-name yt-formatted-string#text') ||
    document.querySelector('#channel-name yt-formatted-string');
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
    // Channel page
    selector = 'ytd-rich-item-renderer a#video-title-link, ytd-grid-video-renderer a#video-title, ytd-video-renderer a#video-title, ytd-compact-video-renderer a.yt-simple-endpoint';
  } else if (path.startsWith('/playlist')) {
    selector = 'ytd-playlist-video-renderer a#video-title';
  } else if (path.startsWith('/results')) {
    selector = 'ytd-video-renderer a#video-title';
  } else {
    return [location.href]; // Single video page
  }

  const links = document.querySelectorAll<HTMLAnchorElement>(selector);
  const seen = new Set<string>();
  const urls: string[] = [];

  links.forEach((a) => {
    if (!a.href) return;
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

/** Get page title based on current page type */
function getPageTitle(): string {
  const path = location.pathname;
  if (/^\/@[^/]+/.test(path) || path.startsWith('/channel/')) {
    return getChannelName();
  }
  const titleEl = document.querySelector(
    'yt-formatted-string.ytd-playlist-header-renderer, h1 yt-formatted-string',
  );
  return titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, '').trim();
}

// ---------------------------------------------------------------------------
// Injection orchestrator
// ---------------------------------------------------------------------------
function tryInjectButtons(): void {
  injectVideoButton();
  injectChannelButton();
  injectPlaylistButton();
}

function removeAllButtons(): void {
  document.getElementById(BUTTON_ID_VIDEO)?.remove();
  document.getElementById(BUTTON_ID_CHANNEL)?.remove();
  document.getElementById('videolm-nlm-btn-playlist')?.remove();
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
    !document.getElementById('videolm-nlm-btn-playlist')
  ) {
    injectPlaylistButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// YouTube fires this custom event after SPA navigation completes
document.addEventListener('yt-navigate-finish', () => {
  removeAllButtons();
  tryInjectButtons();
});

// Also handle yt-page-data-updated (fires when page data is fully loaded)
document.addEventListener('yt-page-data-updated', () => {
  tryInjectButtons();
});

// Initial injection for hard page loads
tryInjectButtons();

// ---------------------------------------------------------------------------
// Heartbeat — safety net every 1s for cases where observer misses
// This is the same pattern used by Return YouTube Dislike, SponsorBlock, etc.
// Lightweight: just an getElementById check + inject if missing.
// ---------------------------------------------------------------------------
setInterval(() => {
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
  if (path.startsWith('/playlist') && !document.getElementById('videolm-nlm-btn-playlist')) {
    injectPlaylistButton();
  }
}, 1000);
