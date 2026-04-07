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
import type { DynamicConfig, VideoContent } from '@/types';
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
  createVideoSourceRecord,
} from '@/utils/source-resolution';
import { prepareNlmResponseForNotion, writeNotionToClipboard } from './copy-handler';
import { isYouTubeUrl, extractVideoIdFromUrl } from '@/utils/url-sanitizer';

let fetchInterceptor: FetchInterceptor | null = null;
let domAutomation: DomAutomation | null = null;

/** Active Quick Fix panel host — singleton across all response cards */
let activeQuickFixHost: HTMLElement | null = null;

/** Concurrency guard — prevents double-submit and UI race conditions */
let isResolving = false;

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
`;

/** Max retry attempts for finding toolbar (NLM toolbar may render late) */
const TOOLBAR_RETRY_LIMIT = 3;
const TOOLBAR_RETRY_MS = 500;

/**
 * Close the Quick Fix panel and reset all state.
 * Every close path (toggle, outside click, auto-close) goes through here.
 */
function closeQuickFixPanel(): void {
  if (isResolving) return;
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

  const record = createVideoSourceRecord(videoId, '', '', url);
  await sendMsgAsync({ type: 'STORE_SOURCE_RECORD', record });

  // 2. Re-resolve ALL citations
  const indexResponse = await sendMsgAsync<{ index: any[] }>({ type: 'GET_SOURCE_INDEX' });
  const sourceIndex = indexResponse?.index ?? [];
  const fpIndex = buildFingerprintIndex(sourceIndex);

  const citationMap: CitationMap = {};
  for (const csn of allCitationSourceNames) {
    const match = resolveCitation(csn.sourceName, fpIndex, sourceIndex);
    if (match.record?.url) {
      citationMap[String(csn.id)] = { url: match.record.url };
    }
    console.log(`[VideoLM] QuickFix re-resolve ${csn.id}: "${csn.sourceName.slice(0, 30)}" → ${match.type} (${match.score.toFixed(2)})`);
  }

  // Fallback: DOM-extracted hrefs
  for (const hint of citationHints) {
    const key = String(hint.id);
    if (!citationMap[key]?.url && hint.href) {
      citationMap[key] = { url: hint.href };
    }
  }

  // 3. Rewrite clipboard
  const transportBlock = wrapVideoCitationTransport(protectedText, citationMap);
  const decodeOpts = { parityMode: 'warn' as const, appendParityCaution: false, skipOuterFence: false };
  const plainText = finalizeForNotion(transportBlock, citationMap, decodeOpts);
  const html = finalizeForNotionHtml(transportBlock, citationMap, decodeOpts);
  await writeNotionToClipboard(plainText, html);

  // 4. Compute new missing/resolved state
  const nowMissing = allCitationSourceNames.filter(
    csn => !citationMap[String(csn.id)]?.url,
  );
  const nowResolved = allCitationSourceNames.filter(
    csn => !!citationMap[String(csn.id)]?.url,
  );

  // 5. Update UI
  if (nowMissing.length === 0) {
    closeQuickFixPanel();
    ctaLabel.textContent = '\u2714';
    const btn = ctaLabel.parentElement!;
    btn.classList.remove('vlm-notion-btn--warning');
    btn.classList.add('vlm-notion-btn--success');
    setTimeout(() => {
      ctaLabel.textContent = 'Notion';
      btn.classList.remove('vlm-notion-btn--success');
    }, 2000);
  } else {
    ctaLabel.textContent = `\u26A0 ${nowMissing.length} \u500B\u4F86\u6E90\u7F3A\u5931 \u25BE`;

    const oldPanel = shadow.querySelector('.vlm-qf-panel');
    if (oldPanel) oldPanel.remove();
    activeQuickFixHost = null;

    showQuickFixPanel(
      shadow,
      nowMissing,
      nowResolved,
      (_, __, newUrl) => handleQuickFix(
        newUrl, allCitationSourceNames, protectedText, citationHints, shadow, ctaLabel, host,
      ),
      host,
    );
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
          citationMap[String(csn.id)] = { url: match.record.url };
        }
        console.log(`[VideoLM] Citation ${csn.id}: "${csn.sourceName.slice(0, 30)}" → ${match.type} (${match.score.toFixed(2)})`);
      }

      // Fallback: DOM-extracted hrefs (fills remaining gaps)
      for (const hint of citationHints) {
        const key = String(hint.id);
        if (!citationMap[key]?.url && hint.href) {
          citationMap[key] = { url: hint.href };
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
      const totalCitations = citationMatches.length;
      const resolvedCount = Object.keys(citationMap).length;
      const missingCount = totalCitations - resolvedCount;

      if (missingCount > 0) {
        // ── Persistent CTA — Quick Fix entry point ──
        const missingItems = citationSourceNames
          .filter((csn: { id: number; sourceName: string }) => !citationMap[String(csn.id)])
          .map((csn: { id: number; sourceName: string }) => ({ id: csn.id, sourceName: csn.sourceName }));

        labelSpan.textContent = `\u26A0 ${missingCount} \u500B\u4F86\u6E90\u7F3A\u5931 \u25BE`;
        btn.classList.add('vlm-notion-btn--warning');

        const missingNames = citationSourceNames
          .filter((csn: { id: number; sourceName: string }) => !citationMap[String(csn.id)])
          .map((csn: { id: number; sourceName: string }) => csn.sourceName.slice(0, 40));
        console.warn(`[VideoLM] ${missingCount} citation(s) missing. Sources not in index:`, [...new Set(missingNames)]);
        console.warn('[VideoLM] Fix: Quick Import these videos or use the Quick Fix panel.');

        // Capture STEP 1 outputs for re-use in handleQuickFix
        const capturedProtectedText = protectedText;
        const capturedCitationHints = citationHints;
        const capturedCitationSourceNames = citationSourceNames;

        // CTA click → toggle Quick Fix panel
        const ctaClickHandler = (e: Event) => {
          e.stopPropagation();
          if (isResolving) return;

          showQuickFixPanel(
            shadow,
            missingItems,
            [],
            (_, __, url) => handleQuickFix(
              url,
              capturedCitationSourceNames,
              capturedProtectedText,
              capturedCitationHints,
              shadow,
              labelSpan,
              host,
            ),
            host,
          );
        };

        btn.addEventListener('click', ctaClickHandler);
      } else {
        // Full success — green checkmark
        labelSpan.textContent = '\u2714'; // ✔
        btn.classList.add('vlm-notion-btn--success');
        setTimeout(() => {
          labelSpan.textContent = originalLabel;
          btn.classList.remove('vlm-notion-btn--success');
        }, 2000);
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
