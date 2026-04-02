# Toast Refactor: Content-Script-Native Notifications

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all toast/notification UI from service worker `executeScript` injection to content-script-native DOM rendering, eliminating the persistent hang bug.

**Architecture:** Content script owns all toast UI via Shadow DOM. Service worker sends `SHOW_TOAST` / `DISMISS_TOAST` messages via `chrome.tabs.sendMessage`. The `showToast()` export in `toast.ts` becomes a thin wrapper that sends messages instead of calling `executeScript`. `chrome.notifications` serves as system-level fallback.

**Tech Stack:** TypeScript, Chrome Extension MV3, Shadow DOM, `chrome.tabs.sendMessage`

---

## Task 1: Create content-script toast renderer (`toast-ui.ts`)

**Files:**
- Create: `src/content-scripts/toast-ui.ts`

**Step 1: Create the toast-ui module with Shadow DOM rendering**

This is the core new file. It:
- Creates a Shadow DOM container on first use (style isolation from YouTube CSS)
- Renders toast HTML inside the shadow root
- Listens for `SHOW_TOAST` / `DISMISS_TOAST` messages from SW
- Exports `showToast()` / `dismissToast()` for direct use by `youtube.ts`

```typescript
/**
 * Content-script-native toast UI — renders floating notifications
 * directly in the page DOM using Shadow DOM for style isolation.
 *
 * Two entry points:
 *   1. Direct call from youtube.ts button handlers (instant feedback)
 *   2. Message from service worker via chrome.runtime.onMessage (progress updates)
 */

export interface ToastOptions {
  state: 'importing' | 'success' | 'error';
  text: string;
  subtext?: string;
  progress?: number;
  viewUrl?: string;
  dismissAfter?: number;
}

const TOAST_HOST_ID = 'videolm-toast-host';

// ── Shadow DOM setup ─────────────────────────────────────────────
let shadowRoot: ShadowRoot | null = null;

function ensureShadowHost(): ShadowRoot {
  if (shadowRoot) return shadowRoot;

  let host = document.getElementById(TOAST_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = TOAST_HOST_ID;
    // Position fixed container — sits above everything
    host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(host);
  }

  // Attach closed shadow root — YouTube CSS cannot leak in
  shadowRoot = host.shadowRoot || host.attachShadow({ mode: 'closed' });

  // Inject styles once
  if (!shadowRoot.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = TOAST_STYLES;
    shadowRoot.appendChild(style);
  }

  return shadowRoot;
}

// ── Toast rendering ──────────────────────────────────────────────
const COLORS: Record<string, { bg: string; border: string; bar: string; icon: string }> = {
  importing: { bg: '#1a1a2e', border: '#1a73e8', bar: '#1a73e8', icon: '🚀' },
  success:   { bg: '#1a2e1a', border: '#34a853', bar: '#34a853', icon: '✅' },
  error:     { bg: '#2e1a1a', border: '#ea4335', bar: '#ea4335', icon: '❌' },
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

  // Remove existing toast (will re-create)
  const existing = root.getElementById('videolm-toast');
  if (existing) existing.remove();

  // Build toast DOM (no innerHTML — XSS safe)
  const toast = document.createElement('div');
  toast.id = 'videolm-toast';
  toast.className = 'toast toast-in';

  // Apply dynamic border color
  toast.style.borderColor = c.border;
  toast.style.backgroundColor = c.bg;
  toast.style.boxShadow = `0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px ${c.border}33`;

  // Row: icon + text + actions
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

  // Progress bar
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

  // Auto-dismiss
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
  setTimeout(() => toast.remove(), 300);

  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

// ── Message listener (receives from service worker) ──────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SHOW_TOAST') {
    showToast(message.options as ToastOptions);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'DISMISS_TOAST') {
    dismissToast();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ── Styles (injected into Shadow DOM) ────────────────────────────
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
  .toast-in {
    animation: toast-in 0.3s ease forwards;
  }
  .toast-out {
    animation: toast-out 0.3s ease forwards;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(20px) scale(0.95); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes toast-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(20px) scale(0.95); }
  }
  .toast-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .toast-icon {
    font-size: 16px;
    margin-right: 8px;
    flex-shrink: 0;
  }
  .toast-text-wrap {
    overflow: hidden;
    min-width: 0;
    flex: 1;
  }
  .toast-main-text {
    font-size: 13px;
    color: #e8eaed;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toast-sub-text {
    font-size: 11px;
    color: #9aa0a6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
  }
  .toast-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .toast-view-link {
    text-decoration: none;
    font-weight: 600;
    margin-left: 12px;
    white-space: nowrap;
    font-size: 13px;
  }
  .toast-close {
    cursor: pointer;
    margin-left: 8px;
    opacity: 0.6;
    font-size: 14px;
    line-height: 1;
    color: #e8eaed;
  }
  .toast-close:hover {
    opacity: 1;
  }
  .toast-bar-bg {
    width: 100%;
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    margin-top: 8px;
    overflow: hidden;
  }
  .toast-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }
`;
```

**Step 2: Commit**

```bash
git add src/content-scripts/toast-ui.ts
git commit -m "feat: add content-script-native toast renderer with Shadow DOM"
```

---

## Task 2: Register `toast-ui.ts` in manifest.json

**Files:**
- Modify: `manifest.json` — add `toast-ui.ts` to YouTube content scripts

**Step 1: Update manifest**

Add `"src/content-scripts/toast-ui.ts"` to the YouTube content scripts js array. It must load on all YouTube pages alongside `youtube.ts`.

```json
{
  "content_scripts": [
    {
      "matches": [
        "https://www.youtube.com/watch*",
        "https://www.youtube.com/playlist*",
        "https://www.youtube.com/@*",
        "https://www.youtube.com/results*",
        "https://www.youtube.com/channel/*"
      ],
      "js": [
        "src/content-scripts/toast-ui.ts",
        "src/content-scripts/youtube.ts"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

**Step 2: Commit**

```bash
git add manifest.json
git commit -m "chore: register toast-ui content script in manifest"
```

---

## Task 3: Rewrite `toast.ts` to use `tabs.sendMessage` instead of `executeScript`

**Files:**
- Modify: `src/background/toast.ts` — complete rewrite

**Step 1: Rewrite toast.ts**

Replace the entire file. The `showToast` / `dismissToast` exports keep the SAME signature so service-worker.ts callers need zero changes. Internally, they now send messages via `chrome.tabs.sendMessage` instead of `chrome.scripting.executeScript`.

```typescript
/**
 * Toast bridge — service worker side.
 *
 * Sends SHOW_TOAST / DISMISS_TOAST messages to the content script
 * running on the active YouTube tab. The content script (toast-ui.ts)
 * renders the actual UI.
 *
 * Fallback: chrome.notifications for cases where the content script
 * is unreachable (tab closed, navigated away, etc.)
 */

/** Which tab to show toasts on (set when import starts) */
let activeToastTabId: number | null = null;

export function setToastTab(tabId: number): void {
  activeToastTabId = tabId;
}

export function getToastTabId(): number | null {
  return activeToastTabId;
}

export interface ToastOptions {
  state: 'importing' | 'success' | 'error';
  text: string;
  subtext?: string;
  progress?: number;
  viewUrl?: string;
  dismissAfter?: number;
}

/**
 * Show or update a floating toast on the active YouTube tab.
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
      // Skip importing state to avoid notification spam
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
```

**Step 2: Verify service-worker.ts needs NO changes**

All 20+ `showToast()` and `setToastTab()` call sites in `service-worker.ts` use the same signature — they just work with the new implementation. Confirm by grepping:

```bash
grep -n "showToast\|setToastTab\|dismissToast" src/background/service-worker.ts
```

Expected: same line numbers as before, no compile errors.

**Step 3: Commit**

```bash
git add src/background/toast.ts
git commit -m "refactor: toast.ts uses tabs.sendMessage instead of executeScript"
```

---

## Task 4: Wire youtube.ts buttons to use content-script-native toast

**Files:**
- Modify: `src/content-scripts/youtube.ts`

**Step 1: Import toast-ui and add SHOW_TOAST listener forwarding**

Since both `toast-ui.ts` and `youtube.ts` run as separate content scripts in the same page, they share the DOM but NOT JS scope. However, `toast-ui.ts` already has its own `onMessage` listener. We just need `youtube.ts` button handlers to call the toast functions.

The simplest approach: have button click handlers dispatch a custom DOM event that `toast-ui.ts` can listen to, OR just call `showToast` directly by loading toast-ui as an importable module.

**Best approach for CRXJS**: Since both are content scripts loaded by manifest, they share the ISOLATED world. We use `window` to share the toast function:

In `toast-ui.ts`, add at the bottom (after the showToast/dismissToast definitions):
```typescript
// Expose to other content scripts in the same ISOLATED world
(window as any).__videolm_showToast = showToast;
(window as any).__videolm_dismissToast = dismissToast;
```

In `youtube.ts`, add a helper at the top:
```typescript
/** Show toast via the toast-ui content script (loaded in same ISOLATED world) */
function showToastUI(opts: { state: 'importing' | 'success' | 'error'; text: string; subtext?: string; progress?: number; viewUrl?: string; dismissAfter?: number }): void {
  const fn = (window as any).__videolm_showToast;
  if (typeof fn === 'function') {
    fn(opts);
  }
}
```

**Step 2: Update button click handlers to show immediate toast**

For the video button click handler, add instant toast before sendMessage:
```typescript
// Inside btn.addEventListener('click', ...) for video button:
showToastUI({
  state: 'importing',
  text: `正在匯入「${getVideoTitle() || '影片'}」...`,
  subtext: `Importing "${getVideoTitle() || 'video'}"...`,
  progress: 50,
});
```

For the channel button click handler, add instant toast after URL extraction:
```typescript
// Inside btn.addEventListener('click', ...) for channel button:
showToastUI({
  state: 'importing',
  text: `正在處理 ${urls.length} 個影片...`,
  subtext: `Processing ${urls.length} videos...`,
  progress: 10,
});
```

Same pattern for playlist button.

**Step 3: Commit**

```bash
git add src/content-scripts/toast-ui.ts src/content-scripts/youtube.ts
git commit -m "feat: wire YouTube buttons to content-script-native toast"
```

---

## Task 5: Build, load extension, and manual test

**Step 1: Build the extension**

```bash
npm run build
```

Expected: no TypeScript errors, no build errors.

**Step 2: Manual test matrix**

Test each scenario and confirm toast appears without hanging:

| Scenario | Action | Expected Toast |
|---|---|---|
| Video page button | Click NLM button on /watch | 🚀 importing → ✅ success |
| Channel page button | Click NLM button on /@channel | 🚀 processing N → ✅ imported |
| Playlist button | Click NLM button on /playlist | 🚀 processing N → ✅ imported |
| Popup quick import | Click import in popup | 🚀 importing → ✅ success |
| SPA navigation | Navigate between videos | Toast survives / new toast appears |
| Error case | Import with no NLM tab | 🚀 importing → ❌ error |
| Tab closed mid-import | Close YT tab during import | System notification fallback |

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in manual toast testing"
```

---

## Task 6: Clean up old executeScript code

**Files:**
- Modify: `src/background/service-worker.ts` — remove `scripting` permission usage for toast
- Modify: `manifest.json` — `scripting` permission may still be needed for other executeScript calls (video extraction). Check and keep if needed.

**Step 1: Grep for remaining executeScript calls**

```bash
grep -rn "executeScript\|chrome\.scripting" src/
```

If the only remaining `executeScript` calls are for video content extraction (GET_VIDEO_CONTENT, EXTRACT_VIDEO_URLS), keep the `scripting` permission. If toast was the last user, remove it.

**Step 2: Remove leftover debug console.logs**

```bash
grep -rn "console\.log.*\[VideoLM\].*Toast\|console\.log.*toast" src/
```

Keep error-level logs, remove verbose debug logs.

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove executeScript toast code, clean up debug logs"
```

---

## Summary of Changes

| File | Change |
|---|---|
| `src/content-scripts/toast-ui.ts` | **NEW** — Shadow DOM toast renderer + message listener |
| `src/background/toast.ts` | **REWRITE** — `executeScript` → `tabs.sendMessage` + notification fallback |
| `src/content-scripts/youtube.ts` | **MODIFY** — button handlers call toast-ui directly for instant feedback |
| `manifest.json` | **MODIFY** — add `toast-ui.ts` to content scripts |

**Key invariant:** `showToast()` / `dismissToast()` in `toast.ts` keep the same TypeScript signature. All 20+ call sites in `service-worker.ts` require ZERO changes.
