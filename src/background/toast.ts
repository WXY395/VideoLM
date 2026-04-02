/**
 * Toast bridge — service worker side.
 *
 * Sends SHOW_TOAST / DISMISS_TOAST messages to the content script
 * (toast-ui.ts) running on the active YouTube tab. The content script
 * renders the actual UI using Shadow DOM.
 *
 * This replaces the old approach of chrome.scripting.executeScript which
 * caused persistent hangs in YouTube's SPA environment.
 *
 * Fallback: chrome.notifications for cases where the content script
 * is unreachable (tab closed, navigated away, etc.)
 */

/** Which tab to show toasts on (set when import starts) */
let activeToastTabId: number | null = null;

/**
 * Remember which tab triggered the import so we can show toasts there.
 */
export function setToastTab(tabId: number): void {
  activeToastTabId = tabId;
}

export function getToastTabId(): number | null {
  return activeToastTabId;
}

export interface ToastOptions {
  /** 'importing' | 'success' | 'error' */
  state: 'importing' | 'success' | 'error';
  /** Main text to display (Chinese) */
  text: string;
  /** Secondary text line (English) — shown below main text in smaller font */
  subtext?: string;
  /** Progress 0-100 (only for 'importing' state) */
  progress?: number;
  /** URL to link "View" button to (only for 'success' state) */
  viewUrl?: string;
  /** Auto-dismiss after N ms (default: 6000 for success/error, never for importing) */
  dismissAfter?: number;
}

/**
 * Show or update a floating toast notification on the active YouTube tab.
 * Sends a message to the content script — never uses executeScript.
 */
export async function showToast(options: ToastOptions): Promise<void> {
  const tabId = activeToastTabId;
  if (!tabId) return;

  // Verify tab still exists
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
  } catch {
    activeToastTabId = null;
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_TOAST',
      options,
    });
  } catch (e) {
    // Content script not reachable — use system notification as fallback
    console.log('[VideoLM] Toast send failed, using notification fallback:', e);
    if (options.state !== 'importing') {
      // Only show system notifications for final states (success/error)
      // Importing state would spam notifications during batch processing
      try {
        chrome.notifications.create(`videolm-toast-${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon48.png'),
          title: options.state === 'success' ? 'VideoLM' : 'VideoLM Error',
          message: options.subtext || options.text,
          silent: options.state === 'error',
        });
      } catch { /* notifications permission may be missing */ }
    }
  }
}

/**
 * Remove any existing toast from the active tab.
 */
export async function dismissToast(): Promise<void> {
  const tabId = activeToastTabId;
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'DISMISS_TOAST' });
  } catch { /* ignore — tab may be gone */ }
}
