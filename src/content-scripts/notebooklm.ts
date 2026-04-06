/**
 * Content script injected into NotebookLM pages.
 *
 * Responsibilities:
 * - Listen for INIT_NLM_BRIDGE message with config
 * - Create FetchInterceptor and DomAutomation instances
 * - Inject fetch interceptor script into the page context
 * - Listen for __VIDEOLM_FETCH_CAPTURED__ postMessage events
 * - Respond to GET_SOURCE_LIST messages
 * - (v0.3.0) Inject "Copy for Notion" button next to AI responses
 * - (v0.3.0) Read NLM AI response text for Notion export
 */

import { FetchInterceptor, type CapturedRequest } from '@/nlm/fetch-interceptor';
import { DomAutomation } from '@/nlm/dom-automation';
import { NLM } from '@/config/selectors';
import type { DynamicConfig, NotionExportOptions, NotionExportResult, VideoContent } from '@/types';

let fetchInterceptor: FetchInterceptor | null = null;
let domAutomation: DomAutomation | null = null;

/**
 * Inject a script string into the page's main world so it can
 * monkey-patch window.fetch (content scripts run in an isolated world).
 */
function injectScript(code: string): void {
  const script = document.createElement('script');
  script.textContent = code;
  (document.head ?? document.documentElement).appendChild(script);
  script.remove();
}

/**
 * Listen for captured fetch requests from the injected page script.
 */
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  if (event.data?.type === '__VIDEOLM_FETCH_CAPTURED__' && fetchInterceptor) {
    const payload = event.data.payload as CapturedRequest;
    fetchInterceptor.setCaptured({
      ...payload,
      capturedAt: Date.now(),
    });
    console.log('VideoLM: Captured NLM fetch request', payload.url);
  }
});

/**
 * Handle messages from the background service worker.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'INIT_NLM_BRIDGE': {
      const config = message.config as DynamicConfig;
      initBridge(config);
      sendResponse({ ok: true });
      break;
    }

    case 'GET_SOURCE_LIST': {
      const sources = domAutomation?.getSourceList() ?? [];
      sendResponse({ type: 'SOURCE_LIST', data: sources });
      break;
    }

    case 'IMPORT_VIA_DOM': {
      // Tier 2 — DOM automation triggered from orchestrator
      if (!domAutomation) {
        sendResponse({ success: false, reason: 'DOM automation not initialized.' });
        break;
      }
      domAutomation
        .addSource(message.content as string)
        .then((result) => sendResponse(result))
        .catch((err: Error) => sendResponse({ success: false, reason: err.message }));
      return true; // Keep message channel open for async response
    }

    case 'REPLAY_FETCH': {
      // Tier 1 — Fetch replay triggered from orchestrator
      if (!fetchInterceptor) {
        sendResponse({ success: false, reason: 'Fetch interceptor not initialized.' });
        break;
      }
      fetchInterceptor
        .replay(message.content as string)
        .then((result) => sendResponse(result))
        .catch((err: Error) => sendResponse({ success: false, reason: err.message }));
      return true; // Keep message channel open for async response
    }

    case 'READ_NLM_RESPONSE': {
      const data = readNlmResponse();
      sendResponse({ type: 'NLM_RESPONSE', data });
      break;
    }
  }
});

/**
 * Initialize the NLM bridge with dynamic config.
 */
function initBridge(config: DynamicConfig): void {
  // Create fetch interceptor
  if (config.features.fetchInterceptEnabled) {
    fetchInterceptor = new FetchInterceptor(config.nlm.apiPatterns.addSource);
    const script = fetchInterceptor.getInstallScript();
    injectScript(script);
    console.log('VideoLM: Fetch interceptor installed');
  }

  // Create DOM automation
  if (config.features.domAutomationEnabled) {
    domAutomation = new DomAutomation(config.nlm.selectors);
    console.log('VideoLM: DOM automation ready');
  }

  console.log('VideoLM: NLM bridge initialized (v' + config.version + ')');
}

// ===========================================================================
// v0.3.0 — Notion Export: Button Injection + Response Reading
// ===========================================================================

// ---------------------------------------------------------------------------
// URL Guard — only inject buttons on notebook pages, not NLM homepage/settings
// ---------------------------------------------------------------------------

/** Returns true only inside a notebook where AI responses exist */
function isNotebookPage(): boolean {
  return /\/notebook\//.test(location.href);
}

// ---------------------------------------------------------------------------
// Selector fallback helper (inline — cannot import dom.ts in content script
// since it references `document` which may differ per context)
// ---------------------------------------------------------------------------

function qf<T extends Element = Element>(
  candidates: readonly string[],
  root: ParentNode = document,
): T | null {
  for (const sel of candidates) {
    const el = root.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

function qfAll<T extends Element = Element>(
  candidates: readonly string[],
  root: ParentNode = document,
): T[] {
  for (const sel of candidates) {
    const nodes = root.querySelectorAll<T>(sel);
    if (nodes.length > 0) return Array.from(nodes);
  }
  return [];
}

// ---------------------------------------------------------------------------
// readNlmResponse — Extract the latest AI response text
// ---------------------------------------------------------------------------

/**
 * Read the most recent NLM AI response from the DOM.
 * Uses the verified DOM structure: mat-card.to-user-message-card-content >
 *   mat-card-content.message-content
 */
function readNlmResponse(): { text: string; citationCount: number } {
  const cards = qfAll(NLM.RESPONSE_CARD);
  if (cards.length === 0) return { text: '', citationCount: 0 };

  // Take the last card (most recent AI response)
  const lastCard = cards[cards.length - 1];
  const textEl = qf(NLM.RESPONSE_TEXT, lastCard);
  const text = textEl?.textContent?.trim() || lastCard.textContent?.trim() || '';
  const citationCount = (text.match(/\[\d+\]/g) || []).length;

  return { text, citationCount };
}

// ---------------------------------------------------------------------------
// Shadow DOM Button — "Copy for Notion"
// ---------------------------------------------------------------------------

const NOTION_BTN_HOST_CLASS = 'videolm-notion-btn-host';

/** Debounce timer ID for streaming stabilization */
let streamStableTimer: ReturnType<typeof setTimeout> | null = null;

/** How long to wait after last mutation before considering streaming done */
const STREAM_STABLE_MS = 1200;

const NOTION_BTN_STYLES = `
  :host {
    display: inline-block;
    margin-left: 4px;
  }
  .vlm-notion-btn {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    color: var(--mat-sys-primary, var(--mdc-theme-primary, #5f6368));
    background: var(--mat-sys-surface-container, var(--mdc-theme-surface, #f1f3f4));
    border: 1px solid var(--mat-sys-outline-variant, #dadce0);
    transition: background 0.15s ease, border-color 0.15s ease;
    pointer-events: auto;
    white-space: nowrap;
    line-height: 1.4;
  }
  .vlm-notion-btn:hover {
    background: color-mix(in srgb, var(--mat-sys-primary, #1a73e8) 8%, var(--mat-sys-surface-container, #f1f3f4));
    border-color: var(--mat-sys-primary, #1a73e8);
  }
  .vlm-notion-btn:active {
    transform: scale(0.97);
  }
  .vlm-notion-btn--success {
    color: #0d904f;
    border-color: #0d904f;
  }
  .vlm-notion-btn--error {
    color: #d93025;
    border-color: #d93025;
  }
  .vlm-notion-btn__icon {
    font-size: 13px;
    line-height: 1;
  }
`;

/** Max retry attempts for finding toolbar (NLM toolbar may render late) */
const TOOLBAR_RETRY_LIMIT = 3;
const TOOLBAR_RETRY_MS = 500;

/**
 * Create a Shadow DOM-isolated "Copy for Notion" button and attach it
 * to the AI response card's toolbar (mat-card-actions.message-actions).
 *
 * @param cardEl - The mat-card.to-user-message-card-content element
 *
 * Verified DOM structure (2026-04-06):
 *   mat-card.to-user-message-card-content      ← cardEl
 *     mat-card-content.message-content          ← text source
 *     mat-card-actions.message-actions          ← toolbar (injection target)
 *       chat-actions.actions-container
 *         div.action > div > span > button
 */
function injectNotionButton(cardEl: Element, retryCount = 0): void {
  // Find the toolbar inside this card
  const toolbar = qf(NLM.RESPONSE_TOOLBAR, cardEl);

  if (!toolbar) {
    // Toolbar may render after text content — retry up to 3×500ms
    if (retryCount < TOOLBAR_RETRY_LIMIT) {
      setTimeout(() => injectNotionButton(cardEl, retryCount + 1), TOOLBAR_RETRY_MS);
    } else {
      console.log('[VideoLM] No toolbar found in response card after retries, skipping');
    }
    return;
  }

  // Prevent duplicate injection
  if (toolbar.querySelector(`.${NOTION_BTN_HOST_CLASS}`)) return;

  // Find the text content element (for reading on click)
  const textEl = qf(NLM.RESPONSE_TEXT, cardEl);

  // Create Shadow DOM host
  const host = document.createElement('span');
  host.className = NOTION_BTN_HOST_CLASS;

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject styles
  const style = document.createElement('style');
  style.textContent = NOTION_BTN_STYLES;
  shadow.appendChild(style);

  // Create button
  const btn = document.createElement('button');
  btn.className = 'vlm-notion-btn';
  btn.setAttribute('aria-label', 'Copy for Notion');

  const iconSpan = document.createElement('span');
  iconSpan.className = 'vlm-notion-btn__icon';
  iconSpan.textContent = '\u{1F4CB}'; // clipboard emoji

  const labelSpan = document.createElement('span');
  labelSpan.textContent = 'Notion';

  btn.appendChild(iconSpan);
  btn.appendChild(labelSpan);

  // Click handler — reads text from mat-card-content at click time (not closure capture)
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('vlm-notion-btn--success')) return;

    const originalLabel = labelSpan.textContent;
    labelSpan.textContent = '...';

    try {
      // 1. Read the response text from mat-card-content (fresh read, not stale closure)
      const responseText = (textEl ?? cardEl).textContent?.trim() || '';
      if (!responseText) {
        labelSpan.textContent = '\u2718'; // ✘
        btn.classList.add('vlm-notion-btn--error');
        setTimeout(() => {
          labelSpan.textContent = originalLabel;
          btn.classList.remove('vlm-notion-btn--error');
        }, 2000);
        return;
      }

      // 2. Capture page title synchronously (before any async boundary)
      let pageTitle = 'Unknown Video';
      try { pageTitle = document.title.replace(/ - NotebookLM$/, '').trim() || pageTitle; } catch {}

      // 3. Get stored videoContent from session storage
      const videoContent = await getStoredVideoContent();

      // 4. Run Notion export via service worker
      const options: NotionExportOptions = {
        includeCallout: !!videoContent,
        includeCheckboxes: true,
        includeTimestampLinks: !!videoContent,
        includeSpecScript: true,
      };

      const result = await sendMsgAsync<NotionExportResult & { error?: string }>({
        type: 'NOTION_EXPORT',
        content: responseText,
        videoContent: videoContent || buildFallbackVideoContent(pageTitle),
        options,
      });

      if (result?.error) throw new Error(result.error);

      // 5. Copy to clipboard
      await navigator.clipboard.writeText(result.markdown);

      // 6. Success state (green checkmark for 2s)
      labelSpan.textContent = '\u2714'; // ✔
      btn.classList.add('vlm-notion-btn--success');
      setTimeout(() => {
        labelSpan.textContent = originalLabel;
        btn.classList.remove('vlm-notion-btn--success');
      }, 2000);
    } catch (err) {
      console.error('[VideoLM] Notion copy failed:', err);
      labelSpan.textContent = '\u2718';
      btn.classList.add('vlm-notion-btn--error');
      setTimeout(() => {
        labelSpan.textContent = originalLabel;
        btn.classList.remove('vlm-notion-btn--error');
      }, 2000);
    }
  });

  shadow.appendChild(btn);

  // Insert into the toolbar (mat-card-actions) — next to copy/thumbs buttons
  toolbar.appendChild(host);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promise-based sendMessage */
function sendMsgAsync<T = any>(msg: any): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        console.log('[VideoLM NLM]', chrome.runtime.lastError.message);
      }
      resolve(r);
    });
  });
}

/**
 * Retrieve the most recently stored videoContent from chrome.storage.session.
 * Returns null if nothing stored or expired (> 30 min).
 */
async function getStoredVideoContent(): Promise<VideoContent | null> {
  try {
    // Try current tab's ID first, then fall back to scanning all keys
    const allData = await chrome.storage.session.get(null);
    let best: { videoContent: VideoContent; storedAt: number } | null = null;

    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith('_videolm_lastVideo_') && value?.videoContent) {
        const entry = value as { videoContent: VideoContent; storedAt: number };
        // Skip entries older than 30 minutes
        if (Date.now() - entry.storedAt > 30 * 60 * 1000) continue;
        // Keep the most recent entry
        if (!best || entry.storedAt > best.storedAt) {
          best = entry;
        }
      }
    }

    return best?.videoContent ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a minimal fallback VideoContent when no stored data is available.
 * This allows Notion export to work (checkbox conversion, basic formatting)
 * even without video metadata — just without timestamp links or callout.
 */
function buildFallbackVideoContent(pageTitle?: string): VideoContent {
  return {
    videoId: '',
    title: pageTitle || 'Unknown Video',
    author: '',
    platform: 'youtube',
    transcript: [],
    duration: 0,
    language: '',
    url: '',
    metadata: { publishDate: '', viewCount: 0, tags: [] },
  };
}

// ---------------------------------------------------------------------------
// MutationObserver — Watch for new AI responses
// ---------------------------------------------------------------------------

let responseObserver: MutationObserver | null = null;

/**
 * Start observing the NLM page for new AI response elements.
 * Uses a two-phase approach:
 *   1. Observe the whole body for structural changes (new response containers)
 *   2. When a response container appears, wait for streaming to stabilize
 *      (no mutations for STREAM_STABLE_MS) before injecting the button
 */
function startResponseObserver(): void {
  if (responseObserver) return;
  if (!isNotebookPage()) {
    console.log('VideoLM: Not a notebook page, skipping response observer');
    return;
  }

  // Track which response elements already have buttons
  const processed = new WeakSet<Element>();

  /**
   * Scan for AI response cards and inject Notion button on any new ones.
   * Uses mat-card.to-user-message-card-content (verified 2026-04-06).
   */
  function scanAndInject(): void {
    const responseCards = qfAll(NLM.RESPONSE_CARD);
    for (const card of responseCards) {
      if (processed.has(card)) continue;
      processed.add(card);
      injectNotionButton(card);
    }
  }

  // Debounced scan — waits for streaming to finish
  function debouncedScan(): void {
    if (streamStableTimer) clearTimeout(streamStableTimer);
    streamStableTimer = setTimeout(() => {
      // SPA may have navigated away from notebook page
      if (!isNotebookPage()) return;
      // Double-check: no loading indicator present
      const isStillLoading = qf(NLM.RESPONSE_LOADING);
      if (isStillLoading) {
        // Still streaming — wait another round
        debouncedScan();
        return;
      }
      scanAndInject();
    }, STREAM_STABLE_MS);
  }

  responseObserver = new MutationObserver((mutations) => {
    // Check if any mutation involves response-related elements
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        relevant = true;
        break;
      }
      // Text content changes within existing response elements (streaming)
      if (m.type === 'characterData') {
        relevant = true;
        break;
      }
    }
    if (relevant) debouncedScan();
  });

  // Observe the entire body for structural changes + text streaming
  responseObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Initial scan for any responses already on the page
  scanAndInject();

  console.log('VideoLM: NLM response observer started');
}

// ---------------------------------------------------------------------------
// Startup — URL-gated with SPA navigation support
// ---------------------------------------------------------------------------

function tryStartObserver(): void {
  if (isNotebookPage()) {
    startResponseObserver();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(tryStartObserver, 1500));
} else {
  // Small delay to let NLM Angular app render initial content
  setTimeout(tryStartObserver, 1500);
}

// Handle SPA navigation — NLM uses Angular router, URL changes without reload.
// Navigation API is available in Chrome 102+ (extension minimum is well above this).
if ('navigation' in window) {
  (window as any).navigation.addEventListener('navigateSuccess', () => {
    tryStartObserver();
  });
}

console.log('VideoLM: NotebookLM content script loaded');
