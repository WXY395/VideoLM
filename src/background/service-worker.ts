import type { MessageType } from '@/types';

/**
 * Service worker message listener.
 * Routes messages between popup, content scripts, and background logic.
 */
chrome.runtime.onMessage.addListener(
  (message: MessageType, _sender, sendResponse) => {
    switch (message.type) {
      case 'GET_VIDEO_CONTENT':
        // TODO: Task 2 — programmatic injection via chrome.scripting.executeScript
        break;

      case 'IMPORT_TO_NLM':
        // TODO: Task 3 — forward content to NLM content script
        sendResponse({ type: 'IMPORT_RESULT', result: { success: false, error: 'Not yet implemented', tier: 1 as const } });
        break;

      case 'CHECK_DUPLICATE':
        // TODO: Task 3 — duplicate detection
        break;

      case 'GET_CONFIG':
        // Handled async — return true to keep the message channel open
        import('@/config/dynamic-config').then(({ getConfig }) =>
          getConfig().then((config) => sendResponse({ type: 'CONFIG', data: config }))
        );
        return true; // keep channel open for async response

      case 'GET_SETTINGS':
        // TODO: Task 4 — settings management
        break;

      case 'SAVE_SETTINGS':
        // TODO: Task 4 — persist settings
        break;

      case 'PROCESS_AND_IMPORT':
        // TODO: Task 5 — process video content and import
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
