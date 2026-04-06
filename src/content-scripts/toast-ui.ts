/**
 * Content-script-native toast UI — renders floating notifications
 * directly in the page DOM using Shadow DOM for style isolation.
 *
 * Two entry points:
 *   1. Direct call from youtube.ts button handlers (instant feedback)
 *   2. Message from service worker via chrome.runtime.onMessage (progress updates)
 *
 * Architecture note (SponsorBlock pattern):
 *   All UI lives in the content script. The service worker NEVER calls
 *   chrome.scripting.executeScript to show toasts — it sends a message
 *   here via chrome.tabs.sendMessage instead. This eliminates the hang
 *   bug caused by executeScript in YouTube's SPA environment.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ToastOptions {
  /** 'importing' | 'success' | 'error' */
  state: 'importing' | 'success' | 'error';
  /** Main text to display */
  text: string;
  /** Secondary text line — shown below main text in smaller font */
  subtext?: string;
  /** Progress 0-100 (only for 'importing' state) */
  progress?: number;
  /** URL to link "View" button to (only for 'success' state) */
  viewUrl?: string;
  /** Auto-dismiss after N ms (default: 6000 for success/error, never for importing) */
  dismissAfter?: number;
  /** Action button label (e.g. "Re-import") */
  actionLabel?: string;
  /** Message type sent to SW when action button is clicked */
  actionMessage?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Styles (injected into Shadow DOM — fully isolated from YouTube CSS)
// NEW-1 FIX: Moved before ensureShadowHost to avoid TDZ risk
// ---------------------------------------------------------------------------
const TOAST_STYLES = `
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    border: 1px solid;
    border-radius: 12px;
    padding: 12px 16px;
    min-width: 280px;
    max-width: 400px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    backdrop-filter: blur(12px);
    pointer-events: auto;
  }
  .toast-in { animation: toast-in 0.3s ease forwards; }
  .toast-out { animation: toast-out 0.3s ease forwards; }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(20px) scale(0.95); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes toast-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(20px) scale(0.95); }
  }
  .toast-row { display: flex; align-items: center; justify-content: space-between; }
  .toast-icon { font-size: 16px; margin-right: 8px; flex-shrink: 0; }
  .toast-text-wrap { overflow: hidden; min-width: 0; flex: 1; }
  .toast-main-text { font-size: 13px; color: #e8eaed; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast-sub-text { font-size: 11px; color: #9aa0a6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .toast-actions { display: flex; align-items: center; flex-shrink: 0; }
  .toast-view-link { text-decoration: none; font-weight: 600; margin-left: 12px; white-space: nowrap; font-size: 13px; }
  .toast-close { cursor: pointer; margin-left: 8px; opacity: 0.6; font-size: 14px; line-height: 1; color: #e8eaed; }
  .toast-close:hover { opacity: 1; }
  .toast-action-btn {
    cursor: pointer;
    margin-left: 12px;
    font-size: 12px;
    font-weight: 600;
    color: #8ab4f8;
    white-space: nowrap;
    opacity: 0.9;
  }
  .toast-action-btn:hover { opacity: 1; text-decoration: underline; }
  .toast-bar-bg { width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .toast-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; }
`;

// ---------------------------------------------------------------------------
// Shadow DOM setup
// ---------------------------------------------------------------------------
const TOAST_HOST_ID = 'videolm-toast-host';

let shadowRoot: ShadowRoot | null = null;

function ensureShadowHost(): ShadowRoot {
  if (shadowRoot) {
    // Verify the host is still in the DOM (YouTube SPA may have removed it)
    const host = document.getElementById(TOAST_HOST_ID);
    if (host && host.shadowRoot === shadowRoot) return shadowRoot;
    // Host was removed — reset
    shadowRoot = null;
  }

  let host = document.getElementById(TOAST_HOST_ID);
  if (host) {
    // Host exists but shadowRoot ref was lost — try to recover
    // closed shadow roots can't be recovered, so re-create
    host.remove();
    host = null;
  }

  host = document.createElement('div');
  host.id = TOAST_HOST_ID;
  // Fixed container — sits above everything, doesn't intercept clicks outside toast
  host.style.cssText =
    'position:fixed;bottom:0;right:0;z-index:2147483647;pointer-events:none;width:0;height:0;';
  document.body.appendChild(host);

  // Attach closed shadow root — YouTube CSS cannot leak in
  shadowRoot = host.attachShadow({ mode: 'closed' });

  // Inject styles once
  const style = document.createElement('style');
  style.textContent = TOAST_STYLES;
  shadowRoot.appendChild(style);

  return shadowRoot;
}

// ---------------------------------------------------------------------------
// Toast rendering
// ---------------------------------------------------------------------------
const COLORS: Record<string, { bg: string; border: string; bar: string; icon: string }> = {
  importing: { bg: '#1a1a2e', border: '#1a73e8', bar: '#1a73e8', icon: '🚀' },
  success: { bg: '#1a2e1a', border: '#34a853', bar: '#34a853', icon: '✅' },
  error: { bg: '#2e1a1a', border: '#ea4335', bar: '#ea4335', icon: '❌' },
};

let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(opts: ToastOptions): void {
  const root = ensureShadowHost();
  const c = COLORS[opts.state] || COLORS.importing;

  // Clear any pending auto-dismiss
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }

  // Remove existing toast (will re-create with new content)
  const existing = root.getElementById('videolm-toast');
  if (existing) existing.remove();

  // Build toast DOM (no innerHTML — XSS safe)
  const toast = document.createElement('div');
  toast.id = 'videolm-toast';
  toast.className = 'toast toast-in';
  toast.style.borderColor = c.border;
  toast.style.backgroundColor = c.bg;
  toast.style.boxShadow = `0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px ${c.border}33`;

  // ── Row: icon + text + actions ──
  const row = document.createElement('div');
  row.className = 'toast-row';

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = c.icon;

  const textWrap = document.createElement('div');
  textWrap.className = 'toast-text-wrap';

  const mainText = document.createElement('div');
  mainText.className = 'toast-main-text';
  mainText.textContent = opts.text;
  textWrap.appendChild(mainText);

  if (opts.subtext) {
    const sub = document.createElement('div');
    sub.className = 'toast-sub-text';
    sub.textContent = opts.subtext;
    textWrap.appendChild(sub);
  }

  const actions = document.createElement('div');
  actions.className = 'toast-actions';

  if (opts.state === 'success' && opts.viewUrl) {
    const viewLink = document.createElement('a');
    viewLink.href = opts.viewUrl;
    viewLink.target = '_blank';
    viewLink.rel = 'noopener';
    viewLink.textContent = 'View →';
    viewLink.className = 'toast-view-link';
    viewLink.style.color = c.border;
    viewLink.style.pointerEvents = 'auto';
    actions.appendChild(viewLink);
  }

  // Action button (e.g. "Re-import" for dedup-skipped items)
  if (opts.actionLabel && opts.actionMessage) {
    const actionBtn = document.createElement('span');
    actionBtn.className = 'toast-action-btn';
    actionBtn.textContent = opts.actionLabel;
    actionBtn.style.pointerEvents = 'auto';
    const msg = opts.actionMessage;
    actionBtn.addEventListener('click', () => {
      dismissToast();
      try { chrome.runtime.sendMessage(msg); } catch { /* ignore */ }
    });
    actions.appendChild(actionBtn);
  }

  const closeBtn = document.createElement('span');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '✕';
  closeBtn.style.pointerEvents = 'auto';
  closeBtn.addEventListener('click', () => dismissToast());
  actions.appendChild(closeBtn);

  row.appendChild(icon);
  row.appendChild(textWrap);
  row.appendChild(actions);
  toast.appendChild(row);

  // ── Progress bar (importing only) ──
  if (opts.state === 'importing' && opts.progress != null) {
    const barBg = document.createElement('div');
    barBg.className = 'toast-bar-bg';
    const barFill = document.createElement('div');
    barFill.className = 'toast-bar-fill';
    barFill.style.width = `${opts.progress}%`;
    barFill.style.backgroundColor = c.bar;
    barBg.appendChild(barFill);
    toast.appendChild(barBg);
  }

  root.appendChild(toast);

  // ── Auto-dismiss ──
  const dismissMs = opts.dismissAfter ?? (opts.state === 'importing' ? 0 : 6000);
  if (dismissMs > 0) {
    autoDismissTimer = setTimeout(() => dismissToast(), dismissMs);
  }
}

export function dismissToast(): void {
  if (!shadowRoot) return;
  const toast = shadowRoot.getElementById('videolm-toast');
  if (!toast) return;

  toast.className = 'toast toast-out';
  // L-6 FIX: Guard against double-remove — check parent before removing
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);

  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Message listener — receives SHOW_TOAST / DISMISS_TOAST from service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SHOW_TOAST') {
    try {
      showToast(message.options as ToastOptions);
      sendResponse({ ok: true });
    } catch (e) {
      console.error('[VideoLM toast-ui] showToast error:', e);
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  }

  if (message.type === 'DISMISS_TOAST') {
    dismissToast();
    sendResponse({ ok: true });
    return false;
  }

  // Not our message — don't interfere
  return false;
});

// ---------------------------------------------------------------------------
// Expose to other content scripts in the same ISOLATED world
// M-2 FIX: Use Symbol.for() keys — prevents accidental collision with page scripts
// (youtube.ts can call these directly for instant button feedback)
// ---------------------------------------------------------------------------
(window as any)[Symbol.for('videolm_showToast')] = showToast;
(window as any)[Symbol.for('videolm_dismissToast')] = dismissToast;

// (TOAST_STYLES moved to top of file — NEW-1 FIX)
