/**
 * YouTube content script — handles:
 * 1. PING — health check from background
 * 2. SPA navigation detection — re-injects NotebookLM buttons
 * 3. NotebookLM button injection on video & channel pages
 */

// ---------------------------------------------------------------------------
// Inline SVG icon (teal V mark from VideoLM logo)
// ---------------------------------------------------------------------------
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

  // Target: the actions container next to like/share/save
  // YouTube uses different structures, try multiple selectors
  const actionsContainer =
    document.querySelector('#top-level-buttons-computed') || // Standard desktop
    document.querySelector('ytd-menu-renderer.ytd-watch-metadata #top-level-buttons-computed') ||
    document.querySelector('#actions-inner #menu #top-level-buttons-computed');

  if (!actionsContainer) return;

  const btn = createNlmButton(BUTTON_ID_VIDEO, 'NotebookLM');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Visual feedback
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    const originalLabel = labelEl.textContent;
    labelEl.textContent = 'Importing...';

    chrome.runtime.sendMessage(
      {
        type: 'QUICK_IMPORT',
        videoUrl: location.href,
        videoTitle: getVideoTitle(),
      },
      (_response) => {
        // Reset button after response
        setTimeout(() => {
          btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
          btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
          labelEl.textContent = originalLabel;
        }, 2000);
      },
    );
  });

  actionsContainer.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Channel page button (near subscribe button)
// ---------------------------------------------------------------------------
function injectChannelButton(): void {
  if (document.getElementById(BUTTON_ID_CHANNEL)) return;

  // Channel page patterns: /@handle, /@handle/videos, /channel/ID
  const isChannel =
    /^\/@[^/]+\/?/.test(location.pathname) || location.pathname.startsWith('/channel/');
  if (!isChannel) return;

  // Target: the subscribe button container area
  const subscribeContainer =
    document.querySelector('#subscribe-button') || // Standard
    document.querySelector('#channel-header #subscribe-button') ||
    document.querySelector('ytd-c4-tabbed-header-renderer #subscribe-button');

  if (!subscribeContainer) return;

  const btn = createNlmButton(BUTTON_ID_CHANNEL, 'NotebookLM');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Visual feedback
    btn.style.backgroundColor = '#00838F';
    btn.style.color = '#fff';
    const labelEl = btn.querySelector('span:last-child') as HTMLSpanElement;
    labelEl.textContent = 'Extracting...';

    // Send EXTRACT_VIDEO_URLS first, then BATCH_IMPORT
    chrome.runtime.sendMessage({ type: 'EXTRACT_VIDEO_URLS' }, (response) => {
      if (response?.urls?.length > 0) {
        labelEl.textContent = `Importing ${response.urls.length}...`;
        chrome.runtime.sendMessage(
          {
            type: 'BATCH_IMPORT',
            urls: response.urls,
            pageTitle: response.pageTitle || getChannelName(),
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
        setTimeout(() => {
          btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
          btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
          labelEl.textContent = 'NotebookLM';
        }, 2000);
      }
    });
  });

  // Insert after the subscribe button
  subscribeContainer.parentElement?.insertBefore(btn, subscribeContainer.nextSibling);
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
    labelEl.textContent = 'Extracting...';

    chrome.runtime.sendMessage({ type: 'EXTRACT_VIDEO_URLS' }, (response) => {
      if (response?.urls?.length > 0) {
        labelEl.textContent = `Importing ${response.urls.length}...`;
        chrome.runtime.sendMessage(
          {
            type: 'BATCH_IMPORT',
            urls: response.urls,
            pageTitle: response.pageTitle || 'Playlist',
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
        setTimeout(() => {
          btn.style.backgroundColor = 'var(--yt-spec-badge-chip-background, #f2f2f2)';
          btn.style.color = 'var(--yt-spec-text-primary, #0f0f0f)';
          labelEl.textContent = 'NotebookLM';
        }, 2000);
      }
    });
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

// ---------------------------------------------------------------------------
// Injection orchestrator — tries to inject buttons, retries via observer
// ---------------------------------------------------------------------------
function tryInjectButtons(): void {
  injectVideoButton();
  injectChannelButton();
  injectPlaylistButton();
}

// Remove all injected buttons (for SPA navigation cleanup)
function removeAllButtons(): void {
  document.getElementById(BUTTON_ID_VIDEO)?.remove();
  document.getElementById(BUTTON_ID_CHANNEL)?.remove();
  document.getElementById('videolm-nlm-btn-playlist')?.remove();
}

// ---------------------------------------------------------------------------
// SPA navigation detection + button injection
// ---------------------------------------------------------------------------
let lastUrl = location.href;

function onNavigate(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // URL changed — remove old buttons, inject new ones after DOM settles
    removeAllButtons();
    setTimeout(tryInjectButtons, 1000);
    setTimeout(tryInjectButtons, 3000); // Retry for slow-loading pages
  }
}

// Initial injection (with retries for slow DOM rendering)
setTimeout(tryInjectButtons, 1500);
setTimeout(tryInjectButtons, 4000);

// MutationObserver for SPA navigation + dynamic DOM changes
const observer = new MutationObserver(() => {
  onNavigate();
  // Also try injecting if buttons don't exist yet (DOM may have rendered)
  tryInjectButtons();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// YouTube-specific navigation events
document.addEventListener('yt-navigate-finish', () => {
  removeAllButtons();
  setTimeout(tryInjectButtons, 1000);
  setTimeout(tryInjectButtons, 3000);
});
window.addEventListener('popstate', onNavigate);
