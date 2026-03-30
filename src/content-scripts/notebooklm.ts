/**
 * Content script injected into NotebookLM pages.
 *
 * Responsibilities:
 * - Listen for INIT_NLM_BRIDGE message with config
 * - Create FetchInterceptor and DomAutomation instances
 * - Inject fetch interceptor script into the page context
 * - Listen for __VIDEOLM_FETCH_CAPTURED__ postMessage events
 * - Respond to GET_SOURCE_LIST messages
 */

import { FetchInterceptor, type CapturedRequest } from '@/nlm/fetch-interceptor';
import { DomAutomation } from '@/nlm/dom-automation';
import type { DynamicConfig } from '@/types';

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

console.log('VideoLM: NotebookLM content script loaded');
