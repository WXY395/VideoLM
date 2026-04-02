/**
 * Import Status — persists import progress across popup open/close cycles.
 *
 * Problem: Chrome extension popup loses all state when closed.
 * Solution: Store import status in chrome.storage.local so the popup
 * can show the correct state when reopened.
 */

const STATUS_KEY = 'videolm_import_status';

export interface ImportStatus {
  /** Whether an import is currently in progress */
  active: boolean;
  /** What's being imported */
  pageTitle: string;
  /** Total URLs to import */
  totalUrls: number;
  /** How many have been submitted so far */
  importedCount: number;
  /** Current phase description */
  phase: string;
  /** Timestamp when import started */
  startedAt: number;
  /** Last error, if any */
  lastError?: string;
  /** Whether the import completed successfully */
  completed?: boolean;
  /** Message to show user on completion */
  completionMessage?: string;
  /** Whether we need user to create a new notebook for remaining URLs */
  needsNewNotebook?: boolean;
  /** Remaining URL count for next notebook */
  remainingCount?: number;
  /** Timestamp when import completed (for expiry calculation) */
  completedAt?: number;
}

export async function setImportStatus(status: ImportStatus): Promise<void> {
  // Auto-set completedAt when transitioning to completed
  if (status.completed && !status.completedAt) {
    status.completedAt = Date.now();
  }
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  // Also update the extension badge
  if (status.active) {
    chrome.action.setBadgeText({ text: `${status.importedCount}/${status.totalUrls}` });
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } else if (status.completed) {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#34a853' });
    // Clear badge after 10 seconds
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

export async function getImportStatus(): Promise<ImportStatus | null> {
  const result = await chrome.storage.local.get(STATUS_KEY);
  const status = (result[STATUS_KEY] as ImportStatus) ?? null;

  // Auto-expire completed statuses after 60 seconds from completion time
  if (status && !status.active) {
    const completedTime = status.completedAt || status.startedAt;
    const age = Date.now() - completedTime;
    if (age > 60_000) {
      await clearImportStatus();
      return null;
    }
  }

  // Auto-expire active statuses that seem stuck (>5 minutes)
  if (status?.active) {
    const age = Date.now() - status.startedAt;
    if (age > 300_000) {
      await clearImportStatus();
      return null;
    }
  }

  return status;
}

export async function clearImportStatus(): Promise<void> {
  await chrome.storage.local.remove(STATUS_KEY);
  chrome.action.setBadgeText({ text: '' });
}
