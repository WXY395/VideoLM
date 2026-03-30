import type { MessageType } from '@/types';

/**
 * Service worker message listener.
 * Routes messages between popup, content scripts, and background logic.
 */
chrome.runtime.onMessage.addListener(
  (message: MessageType, _sender, sendResponse) => {
    switch (message.type) {
      case 'EXTRACT_TRANSCRIPT':
        // TODO: Task 2 — programmatic injection via chrome.scripting.executeScript
        sendResponse({ type: 'TRANSCRIPT_ERROR', error: 'Not yet implemented' });
        break;

      case 'IMPORT_TO_NLM':
        // TODO: Task 3 — forward content to NLM content script
        sendResponse({ type: 'IMPORT_RESULT', result: { success: false, error: 'Not yet implemented', tier: 'free' as const } });
        break;

      case 'CHECK_DUPLICATE':
        // TODO: Task 3 — duplicate detection
        sendResponse({ type: 'DUPLICATE_RESULT', result: { isDuplicate: false } });
        break;

      case 'GET_CONFIG':
        // Handled async — return true to keep the message channel open
        import('@/config/dynamic-config').then(({ getConfig }) =>
          getConfig().then((config) => sendResponse({ type: 'CONFIG_RESULT', config }))
        );
        return true; // keep channel open for async response

      case 'GET_SETTINGS':
        // TODO: Task 4 — settings management
        break;

      default:
        break;
    }

    // Synchronous responses
    return false;
  }
);

// Extension installed / updated
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('VideoLM extension installed');
  }
});
