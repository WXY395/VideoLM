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
import type { DynamicConfig, VideoContent, VideoSourceRecord, NlmSourceEntry } from '@/types';
import {
  collectProtectedCitationMatches,
  wrapVideoCitationTransport,
  finalizeForNotion,
  finalizeForNotionHtml,
  type CitationMap,
} from '@/utils/notion-sync';
import {
  buildFingerprintIndex,
  resolveCitation,
  resolveViaCacheBackfill,
  createVideoSourceRecord,
  findSimilarSources,
  type SuggestionResult,
} from '@/utils/source-resolution';
import { prepareNlmResponseForNotion, writeNotionToClipboard } from './copy-handler';

/** Factory: fresh fallback entry for unresolved citations. Never shares object references. */
function createFallbackEntry(): CitationMap[string] {
  return { url: null, confidence: 'low', status: 'unresolved' };
}
import { isYouTubeUrl, extractVideoIdFromUrl } from '@/utils/url-sanitizer';

let fetchInterceptor: FetchInterceptor | null = null;
let domAutomation: DomAutomation | null = null;

/** Active Quick Fix panel host — singleton across all response cards */
let activeQuickFixHost: HTMLElement | null = null;

/** Concurrency guard — prevents double-submit and UI race conditions */
let isResolving = false;

/** Auto Fill guard — prevents duplicate auto-fill triggers */
let isAutoFilling = false;

/** AbortController for the CTA click handler — ensures clean listener removal */
let ctaClickAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// NLM Source Cache — Passive YouTube URL extraction from batchexecute responses
// ---------------------------------------------------------------------------

/** In-memory cache of YouTube sources discovered in NLM batchexecute responses */
const nlmSourceCache = new Map<string, NlmSourceEntry>();

/** Expose cache for external consumers (copy handler, source resolution) */
export function getNlmSourceCache(): ReadonlyMap<string, NlmSourceEntry> {
  return nlmSourceCache;
}

/**
 * Process a captured batchexecute response and extract YouTube source data.
 * NLM response format (Protobuf-like JSON):
 *   [..., ["https://www.youtube.com/watch?v\u003dVIDEO_ID", "VIDEO_ID", "CHANNEL"], ...]
 */
function addToSourceCache(videoId: string, channelName: string): void {
  if (nlmSourceCache.has(videoId)) return;
  nlmSourceCache.set(videoId, {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    channelName,
    capturedAt: Date.now(),
  });
  console.log(`[VideoLM] NLM source captured: ${videoId} (${channelName || 'unknown'})`);
}

function extractChannelNear(text: string, videoId: string, searchStart: number): string {
  const contextEnd = Math.min(text.length, searchStart + 200);
  const context = text.slice(Math.max(0, searchStart - 10), contextEnd);
  const m = context.match(new RegExp(`"${videoId}"\\s*,\\s*"([^"]+)"`, 'i'));
  return m ? m[1] : '';
}

function extractNlmSources(rawText: string): void {
  try {
    // --- Notebook-scope filter: skip responses not related to current notebook ---
    const nbMatch = location.pathname.match(/\/notebook\/([a-f0-9-]+)/i);
    if (nbMatch) {
      const nbId = nbMatch[1];
      if (!rawText.includes(nbId)) {
        const nbIdNoDash = nbId.replace(/-/g, '');
        if (!rawText.includes(nbIdNoDash)) {
          return; // Response is not for this notebook — skip
        }
      }
    }

    // Normalize Google wire format encodings before matching
    const clean = rawText
      .replace(/\\\\/g, '\\')          // \\\\ → \\ (collapse double-escaping)
      .replace(/\\\//g, '/')            // \/ → /
      .replace(/\\u003d/gi, '=')        // \u003d → =
      .replace(/%3[dD]/g, '=')          // %3D → =
      .replace(/\\"/g, '"');            // \" → "

    const sizeBefore = nlmSourceCache.size;

    // --- Tier 1: Full YouTube URL patterns ---
    const urlPatterns: RegExp[] = [
      /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
      /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
      /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi,
      /https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
    ];
    for (const pattern of urlPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(clean)) !== null) {
        const videoId = match[1];
        const channelName = extractChannelNear(clean, videoId, match.index + match[0].length);
        addToSourceCache(videoId, channelName);
      }
    }

    // --- Tier 2: Standalone videoId in structured data ---
    // NLM may store sources as ["VIDEO_ID","TITLE","CHANNEL"] without full URL.
    // Only search if the response mentions 'youtube' or 'video' (safety guard).
    if (clean.indexOf('youtube') !== -1 || clean.indexOf('video') !== -1) {
      // Match quoted 11-char strings that look like YouTube video IDs
      const idPattern = /"([a-zA-Z0-9_-]{11})"/g;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = idPattern.exec(clean)) !== null) {
        const candidate = idMatch[1];
        if (nlmSourceCache.has(candidate)) continue;

        // Validate: must contain both letters and digits (pure alpha/digit strings are unlikely IDs)
        if (!/[a-zA-Z]/.test(candidate) || !/[0-9]/.test(candidate)) continue;

        // Validate: must appear near the candidate's own URL or be paired with a channel name
        const nearbyStart = Math.max(0, idMatch.index - 300);
        const nearbyEnd = Math.min(clean.length, idMatch.index + 300);
        const nearby = clean.slice(nearbyStart, nearbyEnd);

        // Check if a YouTube URL referencing this ID exists nearby
        const hasNearbyUrl = nearby.includes(`v=${candidate}`) ||
          nearby.includes(`/${candidate}`) ||
          nearby.includes(`youtu`);

        if (!hasNearbyUrl) continue;

        // Already captured by Tier 1 URL patterns? Skip.
        if (nlmSourceCache.has(candidate)) continue;

        const channelName = extractChannelNear(clean, candidate, idMatch.index + idMatch[0].length);
        addToSourceCache(candidate, channelName);
      }
    }

    const added = nlmSourceCache.size - sizeBefore;
    if (added > 0) {
      console.log(`[VideoLM] Extraction complete: +${added} sources (total: ${nlmSourceCache.size})`);
    }
  } catch (e) {
    console.warn('[VideoLM] NLM source extraction error:', e);
  }
}


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
 * Listen for captured fetch requests and batchexecute responses from injected page scripts.
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

  // Passive: extract YouTube URLs from batchexecute responses
  if (event.data?.type === '__VIDEOLM_BATCHEXECUTE__') {
    extractNlmSources(event.data.payload as string);
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
      readNlmResponse().then(data => sendResponse({ type: 'NLM_RESPONSE', data }));
      return true; // keep channel open for async
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
async function readNlmResponse(): Promise<{ text: string; citationCount: number }> {
  const cards = qfAll(NLM.RESPONSE_CARD);
  if (cards.length === 0) return { text: '', citationCount: 0 };

  const lastCard = cards[cards.length - 1];
  const textEl = qf(NLM.RESPONSE_TEXT, lastCard);
  const root = textEl ?? lastCard;
  const { protectedText } = await prepareNlmResponseForNotion(root);
  const citationCount = collectProtectedCitationMatches(protectedText).length;

  return { text: protectedText, citationCount };
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
  .vlm-notion-btn--warning {
    color: #e37400;
    border-color: #e37400;
    font-size: 11px;
  }
  .vlm-notion-btn--hint {
    color: #1a73e8;
    border-color: #1a73e8;
    font-size: 10px;
  }
  .vlm-notion-btn__icon {
    font-size: 13px;
    line-height: 1;
  }
  /* ── Quick Fix Panel ── */
  .vlm-qf-panel {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    width: 320px;
    background: var(--mat-sys-surface-container, #fff);
    border: 1px solid var(--mat-sys-outline-variant, #dadce0);
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
    padding: 8px;
    z-index: 1000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
  }
  .vlm-qf-item {
    padding: 6px 8px;
    border-radius: 8px;
    margin-bottom: 4px;
  }
  .vlm-qf-item--active {
    background: color-mix(in srgb, var(--mat-sys-primary, #1a73e8) 6%, transparent);
  }
  .vlm-qf-item--pending {
    opacity: 0.45;
  }
  .vlm-qf-item--resolved {
    color: #0d904f;
  }
  .vlm-qf-label {
    display: block;
    margin-bottom: 4px;
    color: var(--mat-sys-on-surface, #1f1f1f);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 300px;
  }
  .vlm-qf-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .vlm-qf-input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--mat-sys-outline-variant, #dadce0);
    border-radius: 8px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    background: var(--mat-sys-surface, #fff);
    color: var(--mat-sys-on-surface, #1f1f1f);
  }
  .vlm-qf-input:focus {
    border-color: var(--mat-sys-primary, #1a73e8);
  }
  .vlm-qf-submit {
    all: unset;
    padding: 4px 10px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: var(--mat-sys-primary, #1a73e8);
    color: #fff;
    white-space: nowrap;
  }
  .vlm-qf-submit:disabled {
    background: var(--mat-sys-outline-variant, #dadce0);
    color: #999;
    cursor: not-allowed;
  }
  .vlm-qf-submit--loading {
    pointer-events: none;
    opacity: 0.7;
  }
  /* ── Suggestion Layer ── */
  .vlm-qf-suggestions {
    margin: 4px 0;
    padding: 4px 0;
    border-top: 1px solid var(--mat-sys-outline-variant, #dadce0);
  }
  .vlm-qf-suggestions-title {
    font-size: 11px;
    color: var(--mat-sys-on-surface-variant, #5f6368);
    margin-bottom: 4px;
    padding: 0 2px;
  }
  .vlm-qf-sug-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 3px 4px;
    border-radius: 6px;
  }
  .vlm-qf-sug-item:hover {
    background: color-mix(in srgb, var(--mat-sys-primary, #1a73e8) 6%, transparent);
  }
  .vlm-qf-sug-title {
    flex: 1;
    font-size: 11px;
    color: var(--mat-sys-on-surface, #1f1f1f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vlm-qf-sug-apply {
    all: unset;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--mat-sys-primary, #1a73e8);
    border: 1px solid var(--mat-sys-primary, #1a73e8);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .vlm-qf-sug-apply:hover {
    background: color-mix(in srgb, var(--mat-sys-primary, #1a73e8) 10%, transparent);
  }
  /* ── Weak Candidates (Explain Layer) ── */
  .vlm-qf-weak {
    margin: 4px 0;
    padding: 4px 0;
    border-top: 1px solid var(--mat-sys-outline-variant, #dadce0);
    opacity: 0.7;
  }
  .vlm-qf-weak-header {
    font-size: 11px;
    color: var(--mat-sys-on-surface-variant, #5f6368);
    margin-bottom: 4px;
    padding: 0 2px;
  }
  .vlm-qf-weak-item {
    padding: 4px 6px;
    border-radius: 6px;
    margin-bottom: 2px;
    background: color-mix(in srgb, var(--mat-sys-on-surface, #1f1f1f) 4%, transparent);
  }
  .vlm-qf-weak-title {
    font-size: 11px;
    color: var(--mat-sys-on-surface, #1f1f1f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
  }
  .vlm-qf-weak-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 2px;
  }
  .vlm-qf-weak-reason {
    font-size: 10px;
    color: var(--mat-sys-on-surface-variant, #5f6368);
    font-style: italic;
  }
  .vlm-qf-weak-score {
    font-size: 10px;
    color: var(--mat-sys-on-surface-variant, #5f6368);
    font-family: monospace;
  }
  /* ── Auto Fill Hint ── */
  .vlm-qf-autofill-hint {
    font-size: 11px;
    color: #188038;
    padding: 4px 6px;
    margin: 4px 0;
    border-radius: 6px;
    background: color-mix(in srgb, #188038 8%, transparent);
    text-align: center;
  }
`;

/** Max retry attempts for finding toolbar (NLM toolbar may render late) */
const TOOLBAR_RETRY_LIMIT = 3;
const TOOLBAR_RETRY_MS = 500;

/**
 * Close the Quick Fix panel and reset all state.
 * Every close path (toggle, outside click, auto-close) goes through here.
 */
function closeQuickFixPanel(force = false): void {
  if (!force && isResolving) return;
  if (!activeQuickFixHost) return;

  const panel = activeQuickFixHost.shadowRoot?.querySelector('.vlm-qf-panel');
  if (panel) panel.remove();
  activeQuickFixHost = null;
}

/** Close panel when clicking outside (singleton behavior) */
document.addEventListener('click', (e) => {
  if (!activeQuickFixHost) return;
  if (isResolving) return;

  const path = e.composedPath();
  if (path.includes(activeQuickFixHost)) return;

  closeQuickFixPanel();
});

/** Strong suggestion threshold — matches HIGH_CONFIDENCE_THRESHOLD in source-resolution.ts */
const STRONG_SUGGESTION_THRESHOLD = 0.8;
/** Weak candidate minimum display threshold */
const WEAK_CANDIDATE_THRESHOLD = 0.3;
/** Maximum weak candidates to display */
const WEAK_CANDIDATE_LIMIT = 2;

/**
 * Determine a human-readable reason why a candidate didn't reach match threshold.
 * Pure heuristic on score breakdown — never modifies any score or threshold.
 */
function getWeakCandidateReason(sug: SuggestionResult): string {
  if (sug.tokenOverlap < 0.2) return '\u95DC\u9375\u8A5E\u91CD\u758A\u4E0D\u8DB3'; // 關鍵詞重疊不足
  if (sug.tokenOverlap > 0 && sug.prefixMatch < 0.3) return '\u6A19\u984C\u90E8\u5206\u4E0D\u4E00\u81F4'; // 標題部分不一致
  if (sug.prefixMatch > 0.5) return '\u6A19\u984C\u53EF\u80FD\u88AB\u622A\u65B7'; // 標題可能被截斷
  return '\u63A5\u8FD1\u4F46\u672A\u9054\u5339\u914D\u6A19\u6E96'; // 接近但未達匹配標準
}

/**
 * Render the Quick Fix panel inside the button's Shadow DOM.
 * Shows missing citation source names with URL input for the active item.
 */
function showQuickFixPanel(
  shadow: ShadowRoot,
  missingItems: Array<{ id: number; sourceName: string }>,
  resolvedItems: Array<{ id: number; sourceName: string }>,
  onSubmit: (citationId: number, sourceName: string, url: string) => Promise<void>,
  host: HTMLElement,
  sourceIndex: readonly VideoSourceRecord[] = [],
): void {
  // Singleton — close any other open panel
  if (activeQuickFixHost && activeQuickFixHost !== host) {
    closeQuickFixPanel();
  }

  // Toggle — if clicking same CTA, close
  const existing = shadow.querySelector('.vlm-qf-panel');
  if (existing) {
    closeQuickFixPanel();
    return;
  }

  activeQuickFixHost = host;

  const panel = document.createElement('div');
  panel.className = 'vlm-qf-panel';

  // Render resolved items (green, no input)
  for (const item of resolvedItems) {
    const div = document.createElement('div');
    div.className = 'vlm-qf-item vlm-qf-item--resolved';
    const label = document.createElement('span');
    label.className = 'vlm-qf-label';
    label.textContent = `\u2705 "${item.sourceName.slice(0, 40)}${item.sourceName.length > 40 ? '...' : ''}"`;
    div.appendChild(label);
    panel.appendChild(div);
  }

  // Render missing items
  missingItems.forEach((item, idx) => {
    const isActive = idx === 0;
    const div = document.createElement('div');
    div.className = `vlm-qf-item ${isActive ? 'vlm-qf-item--active' : 'vlm-qf-item--pending'}`;

    const label = document.createElement('span');
    label.className = 'vlm-qf-label';
    label.textContent = `\uD83D\uDD17 "${item.sourceName.slice(0, 40)}${item.sourceName.length > 40 ? '...' : ''}"`;
    div.appendChild(label);

    if (isActive) {
      // ── Suggestion + Weak Candidate layers ──
      const allCandidates = findSimilarSources(item.sourceName, sourceIndex, 5);
      const strongCandidates = allCandidates.filter(s => s.score >= STRONG_SUGGESTION_THRESHOLD);
      const weakCandidates = allCandidates
        .filter(s => s.score >= WEAK_CANDIDATE_THRESHOLD && s.score < STRONG_SUGGESTION_THRESHOLD)
        .slice(0, WEAK_CANDIDATE_LIMIT);

      // ── Auto Fill: HIGH confidence candidate → auto-submit ──
      const autoFillCandidate = strongCandidates.find(
        s => s.score >= STRONG_SUGGESTION_THRESHOLD && s.record.url && isYouTubeUrl(s.record.url),
      );
      if (autoFillCandidate && !isAutoFilling && !isResolving) {
        const hintDiv = document.createElement('div');
        hintDiv.className = 'vlm-qf-autofill-hint';
        hintDiv.textContent = '\u2714 \u5DF2\u81EA\u52D5\u88DC\u4E0A\u4F86\u6E90\uFF08\u9AD8\u4FE1\u5FC3\uFF09'; // ✔ 已自動補上來源（高信心）
        div.appendChild(hintDiv);

        isAutoFilling = true;
        console.log(`[VideoLM] Auto Fill triggered: ${autoFillCandidate.record.videoId} (score: ${autoFillCandidate.score.toFixed(2)})`);

        setTimeout(async () => {
          try {
            await onSubmit(item.id, item.sourceName, autoFillCandidate.record.url);
          } catch (e) {
            console.warn('[VideoLM] Auto Fill failed:', e);
            // Fallback: panel stays open for manual input
          } finally {
            isAutoFilling = false;
          }
        }, 300);
      }

      if (strongCandidates.length > 0) {
        // ── Strong suggestions: actionable with [套用] button ──
        const sugBlock = document.createElement('div');
        sugBlock.className = 'vlm-qf-suggestions';

        const sugTitle = document.createElement('div');
        sugTitle.className = 'vlm-qf-suggestions-title';
        sugTitle.textContent = '\u63A8\u85A6\u4F86\u6E90'; // 推薦來源
        sugBlock.appendChild(sugTitle);

        for (const sug of strongCandidates) {
          const sugItem = document.createElement('div');
          sugItem.className = 'vlm-qf-sug-item';

          const sugLabel = document.createElement('span');
          sugLabel.className = 'vlm-qf-sug-title';
          sugLabel.textContent = sug.record.title.slice(0, 45) + (sug.record.title.length > 45 ? '...' : '');
          sugLabel.title = sug.record.title;

          const applyBtn = document.createElement('button');
          applyBtn.className = 'vlm-qf-sug-apply';
          applyBtn.textContent = '\u5957\u7528'; // 套用

          applyBtn.addEventListener('click', async () => {
            if (isResolving) return;

            isResolving = true;
            applyBtn.textContent = '\u23F3'; // ⏳

            try {
              await onSubmit(item.id, item.sourceName, sug.record.url);
            } finally {
              isResolving = false;
            }
          });

          sugItem.appendChild(sugLabel);
          sugItem.appendChild(applyBtn);
          sugBlock.appendChild(sugItem);
        }

        div.appendChild(sugBlock);
      } else if (weakCandidates.length > 0) {
        // ── Weak candidates: explanatory only, no action buttons ──
        const weakBlock = document.createElement('div');
        weakBlock.className = 'vlm-qf-weak';

        const weakHeader = document.createElement('div');
        weakHeader.className = 'vlm-qf-weak-header';
        weakHeader.textContent = `\u5DF2\u6AA2\u67E5 ${sourceIndex.length} \u500B\u4F86\u6E90\uFF0C\u4F46\u672A\u9054\u63A8\u85A6\u6A19\u6E96`; // 已檢查 N 個來源，但未達推薦標準
        weakBlock.appendChild(weakHeader);

        const weakSubtitle = document.createElement('div');
        weakSubtitle.className = 'vlm-qf-weak-header';
        weakSubtitle.textContent = '\u6700\u63A5\u8FD1\u7684\u4F86\u6E90\uFF08\u672A\u9054\u5339\u914D\u6A19\u6E96\uFF09'; // 最接近的來源（未達匹配標準）
        weakBlock.appendChild(weakSubtitle);

        for (const sug of weakCandidates) {
          const weakItem = document.createElement('div');
          weakItem.className = 'vlm-qf-weak-item';

          const weakTitle = document.createElement('div');
          weakTitle.className = 'vlm-qf-weak-title';
          weakTitle.textContent = sug.record.title.slice(0, 45) + (sug.record.title.length > 45 ? '...' : '');
          weakTitle.title = sug.record.title;

          const weakMeta = document.createElement('div');
          weakMeta.className = 'vlm-qf-weak-meta';

          const weakReason = document.createElement('span');
          weakReason.className = 'vlm-qf-weak-reason';
          weakReason.textContent = getWeakCandidateReason(sug);

          const weakScore = document.createElement('span');
          weakScore.className = 'vlm-qf-weak-score';
          weakScore.textContent = `${Math.round(sug.score * 100)}%`;

          weakMeta.appendChild(weakReason);
          weakMeta.appendChild(weakScore);
          weakItem.appendChild(weakTitle);
          weakItem.appendChild(weakMeta);
          weakBlock.appendChild(weakItem);
        }

        div.appendChild(weakBlock);
      }

      const row = document.createElement('div');
      row.className = 'vlm-qf-row';

      const input = document.createElement('input');
      input.className = 'vlm-qf-input';
      input.type = 'text';
      input.placeholder = 'YouTube URL';

      const submitBtn = document.createElement('button');
      submitBtn.className = 'vlm-qf-submit';
      submitBtn.textContent = '\u78BA\u8A8D';
      submitBtn.disabled = true;

      // URL validation — enable/disable submit
      input.addEventListener('input', () => {
        submitBtn.disabled = !isYouTubeUrl(input.value.trim());
      });

      // Submit handler
      submitBtn.addEventListener('click', async () => {
        if (isResolving || submitBtn.disabled) return;

        isResolving = true;
        input.disabled = true;
        submitBtn.textContent = '\u23F3';
        submitBtn.classList.add('vlm-qf-submit--loading');

        try {
          await onSubmit(item.id, item.sourceName, input.value.trim());
        } finally {
          isResolving = false;
        }
      });

      // Enter key submits
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !submitBtn.disabled) {
          submitBtn.click();
        }
      });

      row.appendChild(input);
      row.appendChild(submitBtn);
      div.appendChild(row);
    }

    panel.appendChild(div);
  });

  // Position relative to the host
  (shadow.host as HTMLElement).style.position = 'relative';
  shadow.appendChild(panel);
}

/**
 * Handle a Quick Fix submission:
 * 1. Create & store source record from URL
 * 2. Re-resolve ALL citations
 * 3. Rewrite clipboard with updated citationMap
 * 4. Update panel UI or close if all resolved
 */
async function handleQuickFix(
  url: string,
  fixingSourceName: string,
  allCitationSourceNames: Array<{ id: number; sourceName: string }>,
  protectedText: string,
  citationHints: Array<{ id: number; href?: string }>,
  shadow: ShadowRoot,
  ctaLabel: HTMLSpanElement,
  host: HTMLElement,
): Promise<void> {
  // 1. Create & store source record
  const videoId = extractVideoIdFromUrl(url);
  if (!videoId) return;

  const record = createVideoSourceRecord(videoId, fixingSourceName, '', url);
  await sendMsgAsync({ type: 'STORE_SOURCE_RECORD', record });

  // 2. Re-resolve ALL citations
  const indexResponse = await sendMsgAsync<{ index: any[] }>({ type: 'GET_SOURCE_INDEX' });
  const sourceIndex = indexResponse?.index ?? [];
  const fpIndex = buildFingerprintIndex(sourceIndex);

  const citationMap: CitationMap = {};
  for (const csn of allCitationSourceNames) {
    const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
    if (match.record?.url) {
      const algoConfidence = match.type === 'matched' ? 'high' as const
        : match.type === 'uncertain' ? 'medium' as const
        : 'low' as const;
      citationMap[String(csn.id)] = { url: match.record.url, confidence: algoConfidence, status: 'resolved', sourceName: csn.sourceName };
    }

    // ── User-provided source override (confidence-based) ──
    const key = String(csn.id);
    console.log("SOURCE_OVERRIDE_APPLIED", {
      key,
      overridden: !citationMap[key]?.url,
      hasExisting: !!citationMap[key]?.url
    });
    if (!citationMap[key]?.url && csn.sourceName === fixingSourceName) {
      citationMap[key] = { url, confidence: 'medium', status: 'resolved', sourceName: csn.sourceName };
      console.log(`[VideoLM] QuickFix user-override ${csn.id}: "${csn.sourceName.slice(0, 30)}" → accepted (confidence: medium)`);
    } else {
      console.log(`[VideoLM] QuickFix re-resolve ${csn.id}: "${csn.sourceName.slice(0, 30)}" → ${match.type} (${match.score.toFixed(2)})`);
    }
  }

  // ── Cache backfill (QF context) — NLM batchexecute source cache ──
  const qfUnresolvedAfterPrimary = allCitationSourceNames
    .filter(csn => {
      const entry = citationMap[String(csn.id)];
      return !entry?.url || entry.confidence === 'low';
    });

  if (qfUnresolvedAfterPrimary.length > 0 && nlmSourceCache.size > 0) {
    const backfill = resolveViaCacheBackfill(
      qfUnresolvedAfterPrimary, nlmSourceCache, sourceIndex,
    );
    for (const [idStr, res] of backfill.resolved) {
      citationMap[idStr] = {
        url: res.url,
        confidence: res.confidence,
        status: 'resolved',
        sourceName: citationMap[idStr]?.sourceName,
      };
      if (res.confidence === 'high') {
        const cacheEntry = nlmSourceCache.get(res.videoId);
        const record = createVideoSourceRecord(
          res.videoId,
          citationMap[idStr]?.sourceName ?? '',
          cacheEntry?.channelName ?? '',
          res.url,
        );
        record.source = 'nlm_backfill';
        sendMsgAsync({ type: 'STORE_SOURCE_RECORD', record });
      }
    }
    const qfBfTotal = qfUnresolvedAfterPrimary.length;
    const qfBfResolved = backfill.resolved.size;
    const qfBfRatio = qfBfTotal > 0 ? Math.round((qfBfResolved / qfBfTotal) * 100) : 0;
    console.log(`[VideoLM] Backfill stats (QF): ${qfBfResolved}/${qfBfTotal} resolved (${qfBfRatio}%), cache size: ${nlmSourceCache.size}`);
  }

  // Fallback: DOM-extracted hrefs
  for (const hint of citationHints) {
    const key = String(hint.id);
    if (!citationMap[key]?.url && hint.href) {
      citationMap[key] = { url: hint.href, confidence: 'low', status: 'resolved' };
    }
  }

  // Fallback: stored videoContent URL — ONLY for single-source notebooks
  const qfUnresolvedKeys = allCitationSourceNames
    .filter(csn => !citationMap[String(csn.id)]?.url)
    .map(csn => String(csn.id));
  const qfUniqueSourceCount = new Set(allCitationSourceNames.map(csn => csn.sourceName)).size;
  if (qfUnresolvedKeys.length > 0 && qfUniqueSourceCount <= 1) {
    const videoContent = await getStoredVideoContent();
    if (videoContent?.url) {
      for (const key of qfUnresolvedKeys) {
        citationMap[key] = {
          url: videoContent.url,
          confidence: 'medium',
          status: 'resolved',
          sourceName: citationMap[key]?.sourceName,
        };
      }
      console.log(`[VideoLM] videoContent fallback (QF) filled ${qfUnresolvedKeys.length} citation(s)`);
    }
  } else if (qfUnresolvedKeys.length > 0) {
    console.log(`[VideoLM] videoContent fallback (QF) SKIPPED: ${qfUniqueSourceCount} unique sources, ${qfUnresolvedKeys.length} unresolved`);
  }

  // Ensure every citation ID has an entry — unresolved get fallback
  // MUST run after all resolution passes; NEVER overrides existing entries
  for (const csn of allCitationSourceNames) {
    const key = String(csn.id);
    if (citationMap[key] === undefined) {
      citationMap[key] = { ...createFallbackEntry(), sourceName: csn.sourceName };
    } else if (!citationMap[key].sourceName) {
      citationMap[key].sourceName = csn.sourceName;
    }
  }

  // 3. Rewrite clipboard
  const transportBlock = wrapVideoCitationTransport(protectedText, citationMap);
  const decodeOpts = { parityMode: 'warn' as const, appendParityCaution: false, skipOuterFence: false };
  const plainText = finalizeForNotion(transportBlock, citationMap, decodeOpts);
  const html = finalizeForNotionHtml(transportBlock, citationMap, decodeOpts);
  await writeNotionToClipboard(plainText, html);

  // 4. Compute new low-confidence / resolved state
  const nowLowConfidence: Array<{ id: number; sourceName: string }> = [];
  const seenLow = new Set<string>();
  for (const csn of allCitationSourceNames) {
    const entry = citationMap[String(csn.id)];
    const confidence = entry?.confidence ?? 'low';
    if (confidence === 'high' || confidence === 'medium') continue;
    if (seenLow.has(csn.sourceName)) continue;
    seenLow.add(csn.sourceName);
    nowLowConfidence.push({ id: csn.id, sourceName: csn.sourceName });
  }
  const nowResolved: Array<{ id: number; sourceName: string }> = [];
  const seenResolved = new Set<string>();
  for (const csn of allCitationSourceNames) {
    const entry = citationMap[String(csn.id)];
    const confidence = entry?.confidence ?? 'low';
    if (confidence !== 'high' && confidence !== 'medium') continue;
    if (seenResolved.has(csn.sourceName)) continue;
    seenResolved.add(csn.sourceName);
    nowResolved.push({ id: csn.id, sourceName: csn.sourceName });
  }

  // 5. Update UI
  if (nowLowConfidence.length === 0) {
    closeQuickFixPanel(true);
    // Clean up CTA handler
    if (ctaClickAbort) { ctaClickAbort.abort(); ctaClickAbort = null; }
    ctaLabel.textContent = '\u2714';
    const btn = ctaLabel.parentElement!;
    btn.classList.remove('vlm-notion-btn--warning');
    btn.classList.add('vlm-notion-btn--success');
    setTimeout(() => {
      ctaLabel.textContent = 'Notion';
      btn.classList.remove('vlm-notion-btn--success');
    }, 2000);
  } else {
    ctaLabel.textContent = `\u26A0 ${nowLowConfidence.length} \u500B\u4F86\u6E90\u7F3A\u5931 \u25BE`;

    const oldPanel = shadow.querySelector('.vlm-qf-panel');
    if (oldPanel) oldPanel.remove();
    activeQuickFixHost = null;

    showQuickFixPanel(
      shadow,
      nowLowConfidence,
      nowResolved,
      (_, sourceName, newUrl) => handleQuickFix(
        newUrl, sourceName, allCitationSourceNames, protectedText, citationHints, shadow, ctaLabel, host,
      ),
      host,
      sourceIndex,
    );

    // Re-register CTA handler with updated lists so toggle preserves progress
    if (ctaClickAbort) ctaClickAbort.abort();
    ctaClickAbort = new AbortController();
    const btn = ctaLabel.parentElement!;
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      if (isResolving) return;
      showQuickFixPanel(
        shadow,
        nowLowConfidence,
        nowResolved,
        (_, sourceName, newUrl) => handleQuickFix(
          newUrl, sourceName, allCitationSourceNames, protectedText, citationHints, shadow, ctaLabel, host,
        ),
        host,
        sourceIndex,
      );
    }, { signal: ctaClickAbort.signal });
  }
}

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

  const shadow = host.attachShadow({ mode: 'open' });

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

  // Click handler — Full injection-first pipeline:
  //
  // contentRoot → prepareNlmResponseForNotion()    [STEP 1: inject <VIDEO_CITATION/>]
  //             → build CitationMap                 [STEP 2: id → url&t]
  //             → wrapVideoCitationTransport()      [STEP 3: fence + CITATION_MAP]
  //             → finalizeForNotion()               [STEP 4: decode → [[n] 📺](url)]
  //             → clipboard                         [STEP 5: write]
  //
  // ❗ No rawText fallback. Missing citations → [[MISSING_n]].
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('vlm-notion-btn--success')) return;
    if (btn.classList.contains('vlm-notion-btn--warning')) return;

    const originalLabel = labelSpan.textContent;
    labelSpan.textContent = '...';

    try {
      // ── STEP 1: DOM → protected text with <VIDEO_CITATION/> tags ──
      const contentRoot = (textEl ?? cardEl) as Element;
      const { protectedText, citationHints, citationSourceNames } = await prepareNlmResponseForNotion(contentRoot, cardEl);
      console.log('[VideoLM] STEP 1 RAW:', protectedText.slice(0, 200));
      console.log('[VideoLM] STEP 1 SOURCE NAMES:', citationSourceNames.length, citationSourceNames.slice(0, 3));
      console.log('[VideoLM] STEP 1 cardEl:', cardEl?.tagName, cardEl?.className?.toString().slice(0, 50));

      if (!protectedText.trim()) {
        labelSpan.textContent = '\u2718';
        btn.classList.add('vlm-notion-btn--error');
        setTimeout(() => {
          labelSpan.textContent = originalLabel;
          btn.classList.remove('vlm-notion-btn--error');
        }, 2000);
        return;
      }

      // ── STEP 2: Resolve citations via Source Resolution Layer ──

      // Load source index from chrome.storage.local (permanent, cross-session)
      const indexResponse = await sendMsgAsync<{ index: any[] }>({ type: 'GET_SOURCE_INDEX' });
      const sourceIndex = indexResponse?.index ?? [];

      // Build in-memory fingerprint index (O(1) lookup)
      const fpIndex = buildFingerprintIndex(sourceIndex);

      // Resolve each citation via scored fingerprint matching
      const citationMap: CitationMap = {};
      for (const csn of citationSourceNames) {
        const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
        if (match.record?.url) {
          const confidence = match.type === 'matched' ? 'high' as const
            : match.type === 'uncertain' ? 'medium' as const
            : 'low' as const;
          citationMap[String(csn.id)] = { url: match.record.url, confidence, status: 'resolved', sourceName: csn.sourceName };
        }
        console.log(`[VideoLM] Citation ${csn.id}: "${csn.sourceName.slice(0, 30)}" → ${match.type} (${match.score.toFixed(2)})`);
      }

      // ── Cache backfill — NLM batchexecute source cache ──
      const unresolvedAfterPrimary = citationSourceNames
        .filter(csn => {
          const entry = citationMap[String(csn.id)];
          return !entry?.url || entry.confidence === 'low';
        });

      if (unresolvedAfterPrimary.length > 0 && nlmSourceCache.size > 0) {
        const backfill = resolveViaCacheBackfill(
          unresolvedAfterPrimary, nlmSourceCache, sourceIndex,
        );
        for (const [idStr, res] of backfill.resolved) {
          citationMap[idStr] = {
            url: res.url,
            confidence: res.confidence,
            status: 'resolved',
            sourceName: citationMap[idStr]?.sourceName,
          };
          console.log(`[VideoLM] Cache backfill: citation ${idStr} → ${res.videoId} (${res.confidence})`);
          // Auto-persist high-confidence results (Data Flywheel)
          if (res.confidence === 'high') {
            const cacheEntry = nlmSourceCache.get(res.videoId);
            const record = createVideoSourceRecord(
              res.videoId,
              citationMap[idStr]?.sourceName ?? '',
              cacheEntry?.channelName ?? '',
              res.url,
            );
            record.source = 'nlm_backfill';
            sendMsgAsync({ type: 'STORE_SOURCE_RECORD', record });
          }
        }
        // Stats logging
        const bfTotal = unresolvedAfterPrimary.length;
        const bfResolved = backfill.resolved.size;
        const bfRatio = bfTotal > 0 ? Math.round((bfResolved / bfTotal) * 100) : 0;
        console.log(`[VideoLM] Backfill stats: ${bfResolved}/${bfTotal} resolved (${bfRatio}%), cache size: ${nlmSourceCache.size}`);
      }

      // Fallback: DOM-extracted hrefs (fills remaining gaps)
      for (const hint of citationHints) {
        const key = String(hint.id);
        if (!citationMap[key]?.url && hint.href) {
          citationMap[key] = { url: hint.href, confidence: 'low', status: 'resolved' };
        }
      }

      // Fallback: stored videoContent URL — ONLY for single-source notebooks
      // Multi-source notebooks must leave citations unresolved to trigger Quick Fix
      const unresolvedKeys = citationSourceNames
        .filter(csn => !citationMap[String(csn.id)]?.url)
        .map(csn => String(csn.id));
      const uniqueSourceCount = new Set(citationSourceNames.map(csn => csn.sourceName)).size;
      if (unresolvedKeys.length > 0 && uniqueSourceCount <= 1) {
        const videoContent = await getStoredVideoContent();
        if (videoContent?.url) {
          for (const key of unresolvedKeys) {
            citationMap[key] = {
              url: videoContent.url,
              confidence: 'medium',
              status: 'resolved',
              sourceName: citationMap[key]?.sourceName,
            };
          }
          console.log(`[VideoLM] videoContent fallback filled ${unresolvedKeys.length} citation(s) with ${videoContent.url}`);
        }
      } else if (unresolvedKeys.length > 0) {
        console.log(`[VideoLM] videoContent fallback SKIPPED: ${uniqueSourceCount} unique sources, ${unresolvedKeys.length} unresolved — Quick Fix will handle`);
      }

      // Ensure every citation ID has an entry — unresolved get fallback
      // MUST run after all resolution passes; NEVER overrides existing entries
      for (const csn of citationSourceNames) {
        const key = String(csn.id);
        if (citationMap[key] === undefined) {
          citationMap[key] = { ...createFallbackEntry(), sourceName: csn.sourceName };
        } else if (!citationMap[key].sourceName) {
          citationMap[key].sourceName = csn.sourceName;
        }
      }

      const citationMatches = collectProtectedCitationMatches(protectedText);
      console.log('[VideoLM] STEP 2 MAP:', {
        citationCount: citationMatches.length,
        resolved: Object.keys(citationMap).length,
        sourceIndexSize: sourceIndex.length,
      });

      // ── STEP 3: Wrap in transport block (fence + CITATION_MAP comment) ──
      const transportBlock = wrapVideoCitationTransport(protectedText, citationMap);
      console.log('[VideoLM] STEP 3 WRAPPED:', transportBlock.slice(0, 200));

      // ── STEP 4: Decode → plain text (markdown) + HTML (<a> links for Notion) ──
      const decodeOpts = { parityMode: 'warn' as const, appendParityCaution: false, skipOuterFence: false };
      const plainText = finalizeForNotion(transportBlock, citationMap, decodeOpts);
      const html = finalizeForNotionHtml(transportBlock, citationMap, decodeOpts);
      console.log('[VideoLM] STEP 4 PLAIN:', plainText.slice(0, 200));
      console.log('[VideoLM] STEP 4 HTML:', html.slice(0, 200));

      // ── STEP 5: Dual-channel clipboard (html=<a> for Notion, plain=markdown fallback) ──
      await writeNotionToClipboard(plainText, html);

      // ── STEP 6: Feedback — show resolution stats ──
      // Success = all citations have high or medium confidence
      // Low confidence → needs Quick Fix (even if entry exists)
      const lowConfidenceItems: Array<{ id: number; sourceName: string }> = [];
      const seenSourceNames = new Set<string>();
      for (const csn of citationSourceNames) {
        const entry = citationMap[String(csn.id)];
        const confidence = entry?.confidence ?? 'low';
        if (confidence === 'high' || confidence === 'medium') continue;
        if (seenSourceNames.has(csn.sourceName)) continue; // dedup
        seenSourceNames.add(csn.sourceName);
        lowConfidenceItems.push({ id: csn.id, sourceName: csn.sourceName });
      }
      const missingCount = lowConfidenceItems.length;

      if (missingCount > 0) {

        labelSpan.textContent = `\u26A0 ${missingCount} \u500B\u4F86\u6E90\u7F3A\u5931 \u25BE`;
        btn.classList.add('vlm-notion-btn--warning');

        const missingNames = lowConfidenceItems
          .map((csn: { id: number; sourceName: string }) => csn.sourceName.slice(0, 40));
        console.warn(`[VideoLM] ${missingCount} citation(s) missing. Sources not in index:`, [...new Set(missingNames)]);
        console.warn('[VideoLM] Fix: Quick Import these videos or use the Quick Fix panel.');

        // Capture STEP 1 outputs for re-use in handleQuickFix
        const capturedProtectedText = protectedText;
        const capturedCitationHints = citationHints;
        const capturedCitationSourceNames = citationSourceNames;
        const capturedSourceIndex = sourceIndex;

        // CTA click → toggle Quick Fix panel
        const ctaClickHandler = (e: Event) => {
          e.stopPropagation();
          if (isResolving) return;

          showQuickFixPanel(
            shadow,
            lowConfidenceItems,
            [],
            (_, sourceName, url) => handleQuickFix(
              url,
              sourceName,
              capturedCitationSourceNames,
              capturedProtectedText,
              capturedCitationHints,
              shadow,
              labelSpan,
              host,
            ),
            host,
            capturedSourceIndex,
          );
        };

        // Remove any previous CTA handler
        if (ctaClickAbort) ctaClickAbort.abort();
        ctaClickAbort = new AbortController();

        btn.addEventListener('click', ctaClickHandler, { signal: ctaClickAbort.signal });
      } else {
        // Full success — green checkmark + Gemini paste hint
        labelSpan.textContent = '\u2714'; // ✔
        btn.classList.add('vlm-notion-btn--success');
        setTimeout(() => {
          labelSpan.textContent = 'Gemini \u2192 Ctrl+Shift+V';
          btn.classList.remove('vlm-notion-btn--success');
          btn.classList.add('vlm-notion-btn--hint');
          setTimeout(() => {
            labelSpan.textContent = originalLabel;
            btn.classList.remove('vlm-notion-btn--hint');
          }, 3500);
        }, 1500);
      }
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
 * Retrieve the most recently stored videoContent.
 * Tries chrome.storage.session first (fast, in-memory), then falls back to
 * chrome.storage.local (persists across extension reloads).
 * Returns null if nothing stored or expired (> 24 hours for local, 30 min for session).
 */
async function getStoredVideoContent(): Promise<VideoContent | null> {
  // Helper to scan a storage area for the best (most recent) entry
  const scan = async (
    area: chrome.storage.StorageArea,
    maxAge: number,
  ): Promise<{ videoContent: VideoContent; storedAt: number } | null> => {
    try {
      const allData = await area.get(null);
      let best: { videoContent: VideoContent; storedAt: number } | null = null;
      for (const [key, value] of Object.entries(allData)) {
        if (key.startsWith('_videolm_lastVideo_') && value?.videoContent) {
          const entry = value as { videoContent: VideoContent; storedAt: number };
          if (Date.now() - entry.storedAt > maxAge) continue;
          if (!best || entry.storedAt > best.storedAt) best = entry;
        }
      }
      return best;
    } catch {
      return null;
    }
  };

  // 1. Try session storage (30 min TTL)
  const session = await scan(chrome.storage.session, 30 * 60 * 1000);
  if (session) return session.videoContent;

  // 2. Fall back to local storage (24 hour TTL — survives extension reload)
  const local = await scan(chrome.storage.local, 24 * 60 * 60 * 1000);
  return local?.videoContent ?? null;
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
// Track which response elements already have buttons (module-level for re-scan)
const processedCards = new WeakSet<Element>();

/**
 * Scan for AI response cards and inject Notion button on any new ones.
 * Safe to call repeatedly — skips already-processed cards via WeakSet.
 */
function scanAndInject(): void {
  const responseCards = qfAll(NLM.RESPONSE_CARD);
  for (const card of responseCards) {
    if (processedCards.has(card)) continue;
    processedCards.add(card);
    injectNotionButton(card);
  }
}

// Debounced scan — waits for streaming to finish
function debouncedScan(): void {
  if (streamStableTimer) clearTimeout(streamStableTimer);
  streamStableTimer = setTimeout(() => {
    if (!isNotebookPage()) return;
    const isStillLoading = qf(NLM.RESPONSE_LOADING);
    if (isStillLoading) {
      debouncedScan();
      return;
    }
    scanAndInject();
  }, STREAM_STABLE_MS);
}

function startResponseObserver(): void {
  if (responseObserver) return;
  if (!isNotebookPage()) {
    console.log('VideoLM: Not a notebook page, skipping response observer');
    return;
  }

  responseObserver = new MutationObserver((mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        relevant = true;
        break;
      }
      if (m.type === 'characterData') {
        relevant = true;
        break;
      }
    }
    if (relevant) debouncedScan();
  });

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
// Startup — URL-gated with SPA navigation support + retry
// ---------------------------------------------------------------------------

/** Retry-based startup: if no cards found yet, retry a few times */
function scanWithRetry(retriesLeft = 3): void {
  if (!isNotebookPage()) return;
  startResponseObserver();
  const cards = qfAll(NLM.RESPONSE_CARD);
  if (cards.length === 0 && retriesLeft > 0) {
    setTimeout(() => scanWithRetry(retriesLeft - 1), 1500);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => scanWithRetry(), 1500));
} else {
  setTimeout(() => scanWithRetry(), 1500);
}

// Handle SPA navigation — NLM uses Angular router, URL changes without reload.
if ('navigation' in window) {
  (window as any).navigation.addEventListener('navigateSuccess', () => {
    setTimeout(() => scanWithRetry(), 1000);
  });
}

// batchexecute XHR interceptor is installed via nlm-source-interceptor.ts
// (MAIN world content script, document_start) — no injectScript needed.

console.log('VideoLM: NotebookLM content script loaded');
