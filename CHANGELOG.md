# Changelog

## [0.2.0] - 2026-04-04

### Security & Stability (36 issues fixed — full audit)

#### Critical (5)

| ID | Issue | Fix |
|----|-------|-----|
| C-1 | Service worker terminated mid-import (MV3 30s/5min lifecycle) — batch imports silently lost | Added `chrome.alarms` keep-alive wrapper around all long-running import operations (`runAutoSplitImport`, `RESUME_BATCH`) |
| C-2 | `QUICK_IMPORT` called `sendResponse` after API round-trip (~10s) — popup frozen with no feedback | Moved `sendResponse` before `await importUrlsToNlm()` so popup receives immediate acknowledgment |
| C-3 | Session token extraction (`SNlM0e`/`cfb2h`) duplicated in 3 files — one Google format change breaks all | Unified into single `fetchSessionTokens()` in `nlm-api.ts`, imported by `service-worker.ts` |
| C-4 | `executeScript` with `async func` in MAIN world — Chrome does NOT await async return, Tier 2 transcript always `undefined` | Split into 3 sequential sync `executeScript` calls: (1) click transcript button, (2) sleep in SW, (3) read DOM segments |
| C-5 | `Promise.race` destructuring `const [result] = await ...` — empty array gives `undefined`, notebook capacity always counted as 0 | Changed to `const results = await ...; const result = Array.isArray(results) && results.length > 0 ? results[0] : null` |

#### High (11)

| ID | Issue | Fix |
|----|-------|-----|
| H-1 | `activeToastTabId` module-level variable lost on SW restart — toasts stop working mid-import | Persisted to `chrome.storage.session`, restored on SW restart |
| H-2 | `setInterval(1000)` + `MutationObserver` never cleared — runs forever, wastes CPU on long YouTube sessions | Added `isExtensionAlive()` check; `clearInterval` + `observer.disconnect()` when context dies; reduced to 2s |
| H-3 | `safeSendMessage` force-reloads page on extension invalidation — interrupts video playback without warning | Replaced with toast warning: "Extension updated — please refresh the page" |
| H-4 | `chrome.runtime.lastError` never checked in `sendMessage` callbacks — errors silently swallowed | Added `lastError` check in `safeSendMessage` and all popup `sendMessage` calls via `safeSendMsg` wrapper |
| H-5 | `MAX_BATCH_SIZE = 50` duplicated independently in `App.tsx` and `batch-queue.ts` | `App.tsx` now imports from `@/background/batch-queue` (single source of truth) |
| H-6 | Empty batch URLs `[]` treated as success — popup shows import button for 0 videos | Added `response.urls.length > 0` check; throws error when empty |
| H-7 | `createNlmNotebook` uses generic UUID regex on entire response — may match wrong UUID | First scans for `CCqFvf` response line, extracts UUID only from that line; fallback to full scan |
| H-8 | `document.body.innerText` in `getNlmNotebookInfo` triggers full layout reflow on NLM tab | Replaced with `textContent` on targeted elements + class-based selectors |
| H-9 | `clearNotebookCache()` called in every loop iteration — defeats 30s cache, causes N API calls for N parts | Kept single `clearNotebookCache()` per chunk, cache serves subsequent lookups within same iteration |
| H-10 | `postImportActions` unconditionally reloads NLM tab — destroys user's in-progress editing | Only navigates if tab is on a different notebook; never force-reloads |
| H-11 | `handleImport` `useCallback` captures stale `progress` state — chapters progress never updates | Removed `progress` from dependency array; used functional `setProgress(prev => ...)` updater |

#### Medium (11)

| ID | Issue | Fix |
|----|-------|-----|
| M-1 | `toast-ui.ts` `onMessage` listener on all YouTube pages including non-video pages | Accepted (minimal overhead, listener returns `false` immediately for non-toast messages) |
| M-2 | `window.__videolm_showToast` pollutes global namespace in ISOLATED world | Changed to `Symbol.for('videolm_showToast')` — no string-key collision possible |
| M-3 | `filterValidYouTubeUrls` exists but never called — dead `invalidUrls` variables operate on empty arrays | Removed dead code paths and unused `invalidUrls` variables |
| M-4 | `createNlmButton` hover listeners never removed on SPA navigation | Accepted (GC collects orphaned elements; SPA nav frequency is low) |
| M-5 | Popup `EXTRACT_VIDEO_URLS` path has no ad filtering — page button path has 4-layer ad filter | Added same 4-signal ad filter (`is-promoted`, `ytd-search-pyv-renderer`, badge text, aria-label) to MAIN world extraction |
| M-6 | `tab.url!` non-null assertion in `useVideoContent` after null check | Replaced with `tab.url ?? ''` (safe fallback) |
| M-7 | `QUICK_IMPORT` calls `listNlmNotebooks` for every single video when strategy is `merge`/`ask` | Accepted (necessary for dedup; cached after first call via 30s TTL) |
| M-8 | Popup `useEffect` fires 3 `sendMessage` calls without `chrome.runtime.lastError` check | Wrapped all popup `sendMessage` calls with `safeSendMsg` helper that checks `lastError` |
| M-9 | Hardcoded `setTimeout(3000)` for notebook readiness after creation | Replaced with polling loop (up to 6 × 1s) that exits early when notebook appears in list |
| M-10 | `findMatchingNotebooks` `startsWith` bidirectional match — 5-char names match anything | Raised `MIN_MATCH_LATIN` to 8, `MIN_MATCH_CJK` to 3; added 40% length ratio check |
| M-11 | `chrome.notifications.create` uses hardcoded ID — concurrent imports overwrite each other | Changed to `videolm-import-${Date.now()}` for unique IDs |

#### Low (6)

| ID | Issue | Fix |
|----|-------|-----|
| L-1 | `'videolm-nlm-btn-playlist'` inline string repeated 4 times (other buttons use constants) | Added `BUTTON_ID_PLAYLIST` constant; replaced all occurrences |
| L-2 | `getNlmNotebookInfo` silently returns `count: 0` on error — dedup effectively disabled | Added `console.log` to catch block for visibility |
| L-3 | `importStatus` state in `App.tsx` set but never read in JSX — dead state | Removed `useState` and `setImportStatusState`; kept side effects only |
| L-4 | `TOAST_STYLES` const declared after `showToast` function — TDZ risk with bundlers | Moved `TOAST_STYLES` before `ensureShadowHost()` in `toast-ui.ts` |
| L-5 | `showToast` sends message to any tab — may target non-YouTube page after navigation | Added `tab.url.includes('youtube.com')` check before sending |
| L-6 | `dismissToast` `setTimeout(() => toast.remove(), 300)` may double-remove | Added `if (toast.parentNode)` guard before `remove()` |

#### Second Audit New Issues (3)

| ID | Issue | Fix |
|----|-------|-----|
| NEW-1 | `TOAST_STYLES` const in TDZ when `showToast` is exposed via `Symbol.for` | Moved const declaration before all function definitions |
| NEW-2 | `RESUME_BATCH` handler calls `importUrlsToNlm` without `startKeepAlive` | Added `startKeepAlive/stopKeepAlive` wrapper to `RESUME_BATCH` |
| NEW-3 | `handleBatchImport` and other popup handlers don't check `chrome.runtime.lastError` | Extracted `safeSendMsg` module-level helper; replaced all direct `sendMessage` calls |

### Features

- **Search results button**: NotebookLM button now appears on YouTube search results pages (`/results`)
- **Ad filtering**: 4-layer filter (is-promoted, ytd-search-pyv-renderer, badge text, aria-label) on both page button and popup extraction paths
- **Global dedup cache**: `chrome.storage.local` tracks all imported video IDs — prevents duplicate imports regardless of notebook name matching
- **Progressive toast**: 3-phase progress updates during import (Connecting → Submitting → Processing)
- **i18n**: Full internationalization via `chrome.i18n` API — auto-follows Chrome browser language (en + zh_TW)

### Permissions

- Added `alarms` permission (for service worker keep-alive during long batch imports)

---

## [0.1.0] - 2026-04-03

### Initial Release

- One-click import YouTube videos to NotebookLM
- Batch import from channels and playlists
- Smart chunking (>50 videos → auto-split into Part 1, 2, 3... notebooks)
- Smart deduplication (checks existing notebooks, supports CJK name matching)
- Auto-create and auto-name notebooks
- Real-time Shadow DOM toast notifications
- Popup quick import with video metadata preview
