/**
 * Floating Toast Notification — injects a progress indicator into the active YouTube tab.
 *
 * Since Chrome extension popups close when the user clicks away, this provides
 * persistent visual feedback by injecting a small floating UI directly into the
 * web page via chrome.scripting.executeScript.
 *
 * Toast states:
 *   - importing: blue progress bar with count
 *   - success:   green bar with "View" link to NLM
 *   - error:     red bar with error message
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
 * Injects minimal HTML+CSS via executeScript — no content script needed.
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
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED' as any,
      func: (opts: ToastOptions) => {
        const TOAST_ID = 'videolm-toast';
        const existing = document.getElementById(TOAST_ID);
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = TOAST_ID;

        // Colors per state
        const colors: Record<string, { bg: string; border: string; bar: string; icon: string }> = {
          importing: { bg: '#1a1a2e', border: '#1a73e8', bar: '#1a73e8', icon: '🚀' },
          success:   { bg: '#1a2e1a', border: '#34a853', bar: '#34a853', icon: '✅' },
          error:     { bg: '#2e1a1a', border: '#ea4335', bar: '#ea4335', icon: '❌' },
        };
        const c = colors[opts.state] || colors.importing;

        // Helper to create styled elements safely (no innerHTML)
        const el = (tag: string, styles: Record<string, string>, text?: string) => {
          const e = document.createElement(tag);
          Object.assign(e.style, styles);
          if (text) e.textContent = text;
          return e;
        };

        // Main row
        const row = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' });

        // Left: icon + text
        const left = el('div', {
          display: 'flex', alignItems: opts.subtext ? 'flex-start' : 'center',
          flex: '1', minWidth: '0',
        });
        const icon = el('span', {
          fontSize: '16px', marginRight: '8px', flexShrink: '0',
          ...(opts.subtext ? { marginTop: '2px' } : {}),
        }, c.icon);
        const textWrap = el('div', { overflow: 'hidden', minWidth: '0' });
        const mainText = el('div', {
          fontSize: '13px', color: '#e8eaed', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }, opts.text);
        textWrap.appendChild(mainText);
        if (opts.subtext) {
          const sub = el('div', {
            fontSize: '11px', color: '#9aa0a6', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px',
          }, opts.subtext);
          textWrap.appendChild(sub);
        }
        left.appendChild(icon);
        left.appendChild(textWrap);

        // Right: view link + close button
        const right = el('div', { display: 'flex', alignItems: 'center', flexShrink: '0' });
        if (opts.state === 'success' && opts.viewUrl) {
          const viewLink = document.createElement('a');
          viewLink.href = opts.viewUrl;
          viewLink.target = '_blank';
          viewLink.rel = 'noopener';
          viewLink.textContent = 'View →';
          Object.assign(viewLink.style, {
            color: c.border, textDecoration: 'none', fontWeight: '600',
            marginLeft: '12px', whiteSpace: 'nowrap', fontSize: '13px',
          });
          right.appendChild(viewLink);
        }
        const closeBtn = el('span', {
          cursor: 'pointer', marginLeft: '8px', opacity: '0.6',
          fontSize: '14px', lineHeight: '1',
        }, '✕');
        closeBtn.id = 'videolm-toast-close';
        right.appendChild(closeBtn);

        row.appendChild(left);
        row.appendChild(right);
        toast.appendChild(row);

        // Progress bar (importing only)
        if (opts.state === 'importing' && opts.progress != null) {
          const barBg = el('div', {
            width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)',
            borderRadius: '2px', marginTop: '8px', overflow: 'hidden',
          });
          const barFill = el('div', {
            width: `${opts.progress}%`, height: '100%', background: c.bar,
            borderRadius: '2px', transition: 'width 0.3s ease',
          });
          barBg.appendChild(barFill);
          toast.appendChild(barBg);
        }

        // Container styles
        Object.assign(toast.style, {
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: '2147483647',
          background: c.bg,
          border: `1px solid ${c.border}`,
          borderRadius: '12px',
          padding: '12px 16px',
          minWidth: '280px',
          maxWidth: '400px',
          boxShadow: `0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px ${c.border}33`,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          backdropFilter: 'blur(12px)',
          animation: 'videolm-toast-in 0.3s ease',
          transition: 'opacity 0.3s ease, transform 0.3s ease',
        });

        // Inject keyframes if not already present
        if (!document.getElementById('videolm-toast-style')) {
          const style = document.createElement('style');
          style.id = 'videolm-toast-style';
          style.textContent = `
            @keyframes videolm-toast-in {
              from { opacity: 0; transform: translateY(20px) scale(0.95); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes videolm-toast-out {
              from { opacity: 1; transform: translateY(0) scale(1); }
              to   { opacity: 0; transform: translateY(20px) scale(0.95); }
            }
          `;
          document.head.appendChild(style);
        }

        document.body.appendChild(toast);

        // Close button handler (closeBtn already referenced from DOM construction above)
        closeBtn.addEventListener('click', () => {
          toast.style.animation = 'videolm-toast-out 0.3s ease forwards';
          setTimeout(() => toast.remove(), 300);
        });

        // Auto-dismiss
        const dismissMs = opts.dismissAfter ??
          (opts.state === 'importing' ? 0 : 6000);
        if (dismissMs > 0) {
          setTimeout(() => {
            const el = document.getElementById(TOAST_ID);
            if (el) {
              el.style.animation = 'videolm-toast-out 0.3s ease forwards';
              setTimeout(() => el.remove(), 300);
            }
          }, dismissMs);
        }
      },
      args: [options],
    });
  } catch (e) {
    // Tab might have navigated away or been closed — silently ignore
    console.log('[VideoLM] Toast injection failed:', e);
  }
}

/**
 * Remove any existing toast from the active tab.
 */
export async function dismissToast(): Promise<void> {
  const tabId = activeToastTabId;
  if (!tabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED' as any,
      func: () => {
        const el = document.getElementById('videolm-toast');
        if (el) {
          el.style.animation = 'videolm-toast-out 0.3s ease forwards';
          setTimeout(() => el.remove(), 300);
        }
      },
      args: [],
    });
  } catch { /* ignore */ }
}
