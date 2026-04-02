# Smart Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add settings-driven duplicate handling so imports can merge into existing same-name notebooks and skip duplicate URLs.

**Architecture:** New `listNlmNotebooks()` API function (wXbhsf RPC) discovers existing notebooks. The BATCH_IMPORT handler checks for name matches before importing, then routes to merge/create/ask based on user settings. A new `NotebookChoice` popup component handles the `ask` flow.

**Tech Stack:** Chrome Extension MV3, TypeScript, React, NLM batchexecute API

---

### Task 1: Add `duplicateStrategy` to UserSettings type

**Files:**
- Modify: `src/types/index.ts:100-111`

**Step 1: Add the field to UserSettings interface**

In `src/types/index.ts`, add `duplicateStrategy` to `UserSettings`:

```typescript
export type DuplicateStrategy = 'ask' | 'merge' | 'create' | 'global-dedup';

export interface UserSettings {
  tier: 'free' | 'pro';
  byok?: BYOKConfig;
  defaultMode: ImportMode;
  defaultTranslateLang?: string;
  duplicateStrategy: DuplicateStrategy;
  monthlyUsage: {
    imports: number;
    aiCalls: number;
    resetDate: string;
  };
}
```

**Step 2: Update default settings**

In `src/background/usage-tracker.ts`, add to `defaultSettings`:

```typescript
export const defaultSettings: UserSettings = {
  tier: 'free',
  defaultMode: 'raw',
  duplicateStrategy: 'ask',
  monthlyUsage: { ... },
};
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build, no errors

**Step 4: Commit**

```bash
git add src/types/index.ts src/background/usage-tracker.ts
git commit -m "feat: add duplicateStrategy to UserSettings"
```

---

### Task 2: Implement `listNlmNotebooks()` API

**Files:**
- Create: `src/background/nlm-api.ts`

**Step 1: Create the notebook listing function**

Create `src/background/nlm-api.ts` with:

```typescript
/**
 * NLM Notebook API — list notebooks via wXbhsf RPC.
 *
 * Uses the same batchexecute pattern as importUrlsToNlm/createNlmNotebook.
 * Competitor analysis confirmed the payload format: [null, 1, null, [2]]
 */

export interface NlmNotebook {
  id: string;
  name: string;
  sourceCount: number;
  emoji: string;
}

/** Cached result to avoid repeated API calls */
let notebookCache: { data: NlmNotebook[]; timestamp: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

/**
 * List all notebooks in the user's NLM account.
 * Results are cached for 30 seconds.
 */
export async function listNlmNotebooks(authuser = ''): Promise<NlmNotebook[]> {
  // Return cache if fresh
  if (notebookCache && Date.now() - notebookCache.timestamp < CACHE_TTL) {
    return notebookCache.data;
  }

  const authuserParam = authuser ? `?authuser=${authuser}&pageId=none` : '';

  try {
    // Step 1: Get session tokens from NLM homepage
    const homepageResp = await fetch(
      `https://notebooklm.google.com/${authuserParam}`,
      { redirect: 'error' }
    );
    if (!homepageResp.ok) return [];

    const html = await homepageResp.text();
    const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1] || '';
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1] || '';
    if (!bl || !atToken) return [];

    // Step 2: Call wXbhsf RPC to list notebooks
    const rpcId = 'wXbhsf';
    const reqId = Math.floor(100000 + Math.random() * 900000);
    const qp = new URLSearchParams({
      rpcids: rpcId,
      'source-path': '/',
      bl,
      _reqid: String(reqId),
      rt: 'c',
    });
    if (authuser) qp.append('authuser', authuser);

    const fReq = JSON.stringify([[[rpcId, JSON.stringify([null, 1, null, [2]]), null, 'generic']]]);
    const body = new URLSearchParams({ 'f.req': fReq, at: atToken });

    const resp = await fetch(
      `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${qp.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }
    );
    if (!resp.ok) return [];

    // Step 3: Parse response (double JSON parse, same as competitor)
    const text = await resp.text();
    const lines = text.split('\n');
    // Find the line containing the actual data (usually line index 3)
    let dataLine = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[["wrb.fr"')) {
        dataLine = trimmed;
        break;
      }
    }
    if (!dataLine) {
      // Fallback: try parsing line 3
      dataLine = lines[3]?.trim() || '';
    }

    const outer = JSON.parse(dataLine);
    const inner = JSON.parse(outer[0][2]);
    const notebooks: NlmNotebook[] = (inner[0] || [])
      .filter((t: any) => {
        if (!t || t.length < 3) return false;
        // Filter out archived/deleted notebooks (t[5][0] === 3)
        const status = t[5];
        return !(Array.isArray(status) && status.length > 0 && status[0] === 3);
      })
      .map((t: any) => ({
        name: (t[0] || '').trim() || 'Untitled notebook',
        sourceCount: Array.isArray(t[1]) ? t[1].length : 0,
        id: t[2] || '',
        emoji: t[3] || '',
      }));

    // Update cache
    notebookCache = { data: notebooks, timestamp: Date.now() };
    console.log(`[VideoLM] Listed ${notebooks.length} notebooks`);
    return notebooks;
  } catch (e) {
    console.log('[VideoLM] listNlmNotebooks error:', e);
    return [];
  }
}

/** Clear the notebook cache (call after creating a new notebook) */
export function clearNotebookCache(): void {
  notebookCache = null;
}

/**
 * Find notebooks whose name matches the given page title.
 * Matching rules:
 *   - Case-insensitive
 *   - Strips " - Part N" suffix
 *   - Matches if either name starts with the other
 */
export function findMatchingNotebooks(
  notebooks: NlmNotebook[],
  pageTitle: string,
): NlmNotebook[] {
  const normalize = (s: string) =>
    s.trim().toLowerCase().replace(/\s*-\s*part\s*\d+$/i, '').trim();

  const target = normalize(pageTitle);
  if (!target) return [];

  return notebooks.filter((nb) => {
    const name = normalize(nb.name);
    return name === target || name.startsWith(target) || target.startsWith(name);
  });
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/background/nlm-api.ts
git commit -m "feat: add listNlmNotebooks API via wXbhsf RPC"
```

---

### Task 3: Wire dedup logic into BATCH_IMPORT handler

**Files:**
- Modify: `src/background/service-worker.ts` (BATCH_IMPORT case, ~line 1181)

**Step 1: Import new modules**

At top of `service-worker.ts`, add:

```typescript
import { listNlmNotebooks, findMatchingNotebooks, clearNotebookCache } from './nlm-api';
```

Also clear cache after `createNlmNotebook` calls (in `runAutoSplitImport`):

```typescript
// After: const newNbId = await createNlmNotebook(...)
clearNotebookCache();
```

**Step 2: Add dedup logic to BATCH_IMPORT handler**

Replace the BATCH_IMPORT handler body (after dedup + sendResponse) with:

```typescript
// Get authuser
const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
let authuser = '';
if (nlmTabs[0]?.url) {
  try { authuser = new URL(nlmTabs[0].url).searchParams.get('authuser') || ''; } catch {}
}

// Check duplicate strategy
const settings = await getSettings();
const strategy = settings.duplicateStrategy || 'ask';

// Skip notebook matching for 'create' strategy (always create new)
if (strategy !== 'create') {
  const allNotebooks = await listNlmNotebooks(authuser);
  const matches = findMatchingNotebooks(allNotebooks, pageTitle);

  if (matches.length > 0) {
    const bestMatch = matches[0]; // Closest match

    if (strategy === 'merge') {
      // Auto-merge: import directly into existing notebook
      await runAutoSplitImport(uniqueUrls, pageTitle, bestMatch.sourceCount, 50, authuser, bestMatch.id);
      return;
    }

    if (strategy === 'ask') {
      // Return to popup for user choice
      sendResponse({
        success: true,
        needsUserChoice: true,
        existingNotebook: bestMatch,
        urls: uniqueUrls,
        pageTitle,
        authuser,
        dupeMsg,
      });
      return;
    }

    // 'global-dedup' — Pro feature, deferred to later task
  }
}

// Default: run auto-split import (creates new notebook if needed)
await runAutoSplitImport(uniqueUrls, pageTitle, nbInfo.count, nbInfo.limit, authuser);
```

**Step 3: Update `runAutoSplitImport` signature to accept optional target notebook**

Add optional `targetNotebookId` parameter:

```typescript
async function runAutoSplitImport(
  urls: string[],
  pageTitle: string,
  existingCount: number,
  limit: number,
  authuser = '',
  targetNotebookId = '',  // <-- NEW: for merge-into-existing
): Promise<void> {
```

When `targetNotebookId` is provided, pass it to the first `importUrlsToNlm` call instead of `undefined`:

```typescript
const firstResult = await importUrlsToNlm(
  firstBatch,
  targetNotebookId || undefined,
  targetNotebookId ? authuser : undefined,
  targetNotebookId ? undefined : pageTitle,  // Only auto-create if no target
);
```

**Step 4: Add `BATCH_IMPORT_WITH_TARGET` message handler**

This handles the user's choice from the `ask` popup:

```typescript
case 'BATCH_IMPORT_WITH_TARGET': {
  (async () => {
    try {
      const { urls, pageTitle, targetNotebookId, authuser, existingSourceCount } = message as any;

      const [ytTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (ytTab?.id) setToastTab(ytTab.id);

      sendResponse({ success: true, importing: true, message: 'Merging into existing notebook...' });

      await runAutoSplitImport(urls, pageTitle, existingSourceCount || 0, 50, authuser, targetNotebookId);
    } catch (err) {
      sendResponse({ success: false, error: String(err) });
    }
  })();
  return true;
}
```

**Step 5: Build and verify**

Run: `npm run build`
Expected: Clean build

**Step 6: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat: wire dedup strategy into BATCH_IMPORT handler"
```

---

### Task 4: Update Popup UI — NotebookChoice component + `ask` flow

**Files:**
- Create: `src/popup/components/NotebookChoice.tsx`
- Modify: `src/popup/App.tsx`

**Step 1: Create NotebookChoice component**

```typescript
// src/popup/components/NotebookChoice.tsx
import React from 'react';

interface NotebookChoiceProps {
  notebook: { id: string; name: string; sourceCount: number; emoji: string };
  pageTitle: string;
  videoCount: number;
  onMerge: () => void;
  onCreateNew: () => void;
}

export function NotebookChoice({ notebook, pageTitle, videoCount, onMerge, onCreateNew }: NotebookChoiceProps) {
  const availableSlots = 50 - notebook.sourceCount;
  const willOverflow = videoCount > availableSlots;

  return (
    <div className="notebook-choice">
      <div className="notebook-choice__title">Existing notebook found</div>
      <div className="notebook-choice__notebook">
        <span className="notebook-choice__emoji">{notebook.emoji || '📔'}</span>
        <div>
          <div className="notebook-choice__name">{notebook.name}</div>
          <div className="notebook-choice__meta">
            {notebook.sourceCount} sources
            {willOverflow && ` · ${availableSlots} slots available`}
          </div>
        </div>
      </div>
      <div className="notebook-choice__actions">
        <button className="notebook-choice__btn notebook-choice__btn--merge" onClick={onMerge}>
          Merge ({videoCount} videos)
        </button>
        <button className="notebook-choice__btn notebook-choice__btn--create" onClick={onCreateNew}>
          Create New
        </button>
      </div>
      {willOverflow && (
        <div className="notebook-choice__hint">
          Overflow videos will auto-create "{pageTitle} - Part 2"
        </div>
      )}
    </div>
  );
}
```

**Step 2: Wire into App.tsx**

Add state for notebook choice:

```typescript
const [notebookChoice, setNotebookChoice] = useState<{
  notebook: { id: string; name: string; sourceCount: number; emoji: string };
  urls: string[];
  pageTitle: string;
  authuser: string;
} | null>(null);
```

In `handleBatchImport`, handle `needsUserChoice` response:

```typescript
if (response?.needsUserChoice) {
  setNotebookChoice({
    notebook: response.existingNotebook,
    urls: response.urls,
    pageTitle: response.pageTitle,
    authuser: response.authuser,
  });
  setImporting(false);
  return;
}
```

Add merge/create handlers:

```typescript
const handleMergeChoice = useCallback(() => {
  if (!notebookChoice) return;
  setNotebookChoice(null);
  setImporting(true);
  chrome.runtime.sendMessage({
    type: 'BATCH_IMPORT_WITH_TARGET',
    urls: notebookChoice.urls,
    pageTitle: notebookChoice.pageTitle,
    targetNotebookId: notebookChoice.notebook.id,
    authuser: notebookChoice.authuser,
    existingSourceCount: notebookChoice.notebook.sourceCount,
  }, (response) => {
    setImporting(false);
    setResult({
      success: true,
      tier: 1,
      message: response?.message || 'Merging in background...',
    });
  });
}, [notebookChoice]);

const handleCreateNewChoice = useCallback(() => {
  if (!notebookChoice) return;
  const { urls, pageTitle } = notebookChoice;
  setNotebookChoice(null);
  handleBatchImport(urls);
}, [notebookChoice, handleBatchImport]);
```

Render `NotebookChoice` in JSX (before the result section):

```tsx
{notebookChoice && (
  <NotebookChoice
    notebook={notebookChoice.notebook}
    pageTitle={notebookChoice.pageTitle}
    videoCount={notebookChoice.urls.length}
    onMerge={handleMergeChoice}
    onCreateNew={handleCreateNewChoice}
  />
)}
```

**Step 3: Add styles for NotebookChoice**

Add to `src/popup/styles.css`:

```css
.notebook-choice { background: #f0f4ff; border-radius: 8px; padding: 12px; margin: 8px 0; }
.notebook-choice__title { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: #1a73e8; }
.notebook-choice__notebook { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.notebook-choice__emoji { font-size: 24px; }
.notebook-choice__name { font-weight: 500; font-size: 13px; }
.notebook-choice__meta { font-size: 11px; color: #666; }
.notebook-choice__actions { display: flex; gap: 8px; }
.notebook-choice__btn { flex: 1; padding: 8px; border: none; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; }
.notebook-choice__btn--merge { background: #1a73e8; color: white; }
.notebook-choice__btn--create { background: #e8eaed; color: #333; }
.notebook-choice__hint { font-size: 11px; color: #888; margin-top: 6px; }
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/popup/components/NotebookChoice.tsx src/popup/App.tsx src/popup/styles.css
git commit -m "feat: add NotebookChoice UI for ask-mode dedup"
```

---

### Task 5: Add Import Behavior section to Settings page

**Files:**
- Modify: `src/popup/components/SettingsPage.tsx`

**Step 1: Add duplicateStrategy state and UI**

```typescript
const [dupStrategy, setDupStrategy] = useState<DuplicateStrategy>(
  settings.duplicateStrategy ?? 'ask'
);
```

Add new section before the Save button:

```tsx
<div className="settings-section">
  <label className="settings-label">When a same-name notebook exists</label>
  <div className="settings-radio-group">
    {([
      ['ask', 'Ask me each time'],
      ['merge', 'Merge into existing notebook'],
      ['create', 'Always create new notebook'],
    ] as const).map(([value, label]) => (
      <label key={value} className="settings-radio">
        <input
          type="radio"
          name="dupStrategy"
          value={value}
          checked={dupStrategy === value}
          onChange={() => setDupStrategy(value)}
        />
        <span>{label}</span>
      </label>
    ))}
    <label className="settings-radio settings-radio--disabled">
      <input
        type="radio"
        name="dupStrategy"
        value="global-dedup"
        checked={dupStrategy === 'global-dedup'}
        onChange={() => setDupStrategy('global-dedup')}
        disabled={settings.tier !== 'pro'}
      />
      <span>Smart global dedup</span>
      {settings.tier !== 'pro' && <span className="settings-pro-badge">PRO</span>}
    </label>
  </div>
</div>
```

Update `handleSave` to include `duplicateStrategy`:

```typescript
onSave({ byok, duplicateStrategy: dupStrategy });
```

**Step 2: Add radio group styles**

```css
.settings-radio-group { display: flex; flex-direction: column; gap: 6px; }
.settings-radio { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.settings-radio input { margin: 0; }
.settings-radio--disabled { opacity: 0.5; }
.settings-pro-badge { background: #1a73e8; color: white; font-size: 9px; padding: 1px 4px; border-radius: 3px; margin-left: 4px; }
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/popup/components/SettingsPage.tsx src/popup/styles.css
git commit -m "feat: add Import Behavior settings with duplicate strategy"
```

---

### Task 6: Add QUICK_IMPORT dedup support

**Files:**
- Modify: `src/background/service-worker.ts` (QUICK_IMPORT case)

**Step 1: Add notebook matching for single video import**

In the QUICK_IMPORT handler, after setting the toast tab but before calling `importUrlsToNlm`, add notebook matching for the `merge` strategy:

```typescript
// Check for existing notebook match (only for merge/ask strategies)
const settings = await getSettings();
const strategy = settings.duplicateStrategy || 'ask';

if (strategy !== 'create' && videoTitle) {
  const nlmCheckTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
  let qiAuthuser = '';
  if (nlmCheckTabs[0]?.url) {
    try { qiAuthuser = new URL(nlmCheckTabs[0].url).searchParams.get('authuser') || ''; } catch {}
  }

  const allNotebooks = await listNlmNotebooks(qiAuthuser);
  const matches = findMatchingNotebooks(allNotebooks, videoTitle);

  if (matches.length > 0 && strategy === 'merge') {
    // Auto-merge into first matching notebook
    const result = await importUrlsToNlm(urls.filter(Boolean), matches[0].id, qiAuthuser);
    sendResponse(result);
    if (result.success && result.notebookId) {
      await postImportActions(result.notebookId, result.authuser || '', urls.length, videoTitle || 'Video');
    }
    return;
  }
  // 'ask' for single videos: skip matching (too disruptive for 1-click flow)
}
```

**Step 2: Build and verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat: add merge strategy support to QUICK_IMPORT"
```

---

### Task 7: Integration test — manual E2E

**Test matrix:**

| Setting | Existing NB? | Expected |
|---|---|---|
| `ask` | Yes | Popup shows NotebookChoice |
| `ask` | No | Normal auto-create |
| `merge` | Yes | Auto-imports to existing, toast shows success |
| `merge` | No | Normal auto-create |
| `create` | Yes | Creates new notebook, ignores existing |
| `create` | No | Normal auto-create |

**Steps per test:**
1. Set strategy in Settings
2. Import a YouTube channel/playlist
3. Verify behavior matches expected column
4. Check toast + NLM tab shows correct result

**Final commit:**

```bash
git add -A
git commit -m "feat: smart dedup — settings-based notebook matching with merge/ask/create strategies"
```
