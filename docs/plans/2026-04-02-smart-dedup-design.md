# Smart Deduplication Design

**Date**: 2026-04-02
**Status**: Approved

## Problem

When importing YouTube videos into NotebookLM, users encounter:
1. Duplicate notebooks created for the same channel (e.g., "Channel X" and "Channel X" as separate notebooks)
2. Duplicate sources within a notebook (same video imported twice)
3. No way to merge new videos into an existing channel notebook

## Solution

Settings-based duplicate handling strategy with Free/Pro tier split.

## Settings

New field in `UserSettings`:

```typescript
duplicateStrategy: 'ask' | 'merge' | 'create' | 'global-dedup'
```

| Value | Label | Tier | Behavior |
|---|---|---|---|
| `ask` | Ask me each time | Free | Popup shows choice when duplicate notebook found |
| `merge` | Merge into existing | Free | Auto-find same-name notebook, import there, skip duplicate URLs |
| `create` | Always create new | Free | Current behavior — always create new notebook |
| `global-dedup` | Smart global dedup | **Pro** | Scan all notebooks, skip videos that exist anywhere |

**Default**: `ask`

## Data Flow

```
User clicks Import
    |
    v
listNlmNotebooks(authuser) --- wXbhsf API --> [{id, name, sourceCount, emoji}, ...]
    |
    +-- Same-name notebook found?
    |   +-- YES --> Check duplicateStrategy
    |   |          +-- 'merge'  -> Import to existing notebook, URL dedup
    |   |          +-- 'create' -> Ignore match, auto-create new
    |   |          +-- 'ask'    -> Return to popup for user choice
    |   |          +-- 'global-dedup' (Pro) -> Scan all notebook sources, global URL dedup
    |   |
    |   +-- NO  -> Normal flow (auto-create new notebook)
    |
    +-- Import (deduplicated URL list)
```

## New API Functions

### `listNlmNotebooks(authuser: string)`
- Uses `wXbhsf` RPC via batchexecute (same pattern as competitor)
- Payload: `[null, 1, null, [2]]`
- Response parsing: `JSON.parse(JSON.parse(text.split("\n")[3])[0][2])[0]`
- Returns: `{ id: string, name: string, sourceCount: number, emoji: string }[]`
- Filters out archived notebooks (`t[5][0] === 3`)
- Cache results for 30 seconds

### `getNotebookSources(notebookId, authuser)` (Pro only)
- Gets all source URLs from a specific notebook
- Used for cross-notebook deduplication

## Popup Interaction (`ask` mode)

When a same-name notebook is detected, BATCH_IMPORT returns:

```typescript
{
  success: true,
  needsUserChoice: true,
  existingNotebook: { id, name, sourceCount, emoji },
  urls: string[],
  pageTitle: string,
}
```

Popup renders a choice UI:

```
Found existing notebook:
[emoji] "Channel Name" (24 sources)

[Merge into existing]  [Create new]
```

User's choice is sent back as a new message (e.g., `BATCH_IMPORT_WITH_TARGET`).

## Name Matching

Notebook name matching uses normalized comparison:
- Trim whitespace
- Case-insensitive
- Strip " - Part N" suffix (from auto-split)
- Match if `notebookName.startsWith(pageTitle)` or `pageTitle.startsWith(notebookName)`

## Tier Gating

- `global-dedup` option is disabled (greyed out + lock icon) for free-tier users
- Setting automatically falls back to `ask` if user downgrades from Pro
