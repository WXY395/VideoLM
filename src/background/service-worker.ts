// ── Global error handlers: prevent SW crash on unhandled errors ──
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  console.error('UNHANDLED PROMISE:', e.reason);
});

self.addEventListener('error', (e: ErrorEvent) => {
  console.error('SW ERROR:', e.message);
});

import type { MessageType, VideoContent, ImportOptions, ImportMode, NotionExportOptions, VideoSourceRecord } from '@/types';
import { getConfig } from '@/config/dynamic-config';
import { resolveProvider } from '@/ai/provider-manager';
import { extractVideoId, parseXMLCaptions } from '@/extractors/youtube-extractor';
import { processAndImport } from './process-and-import';
import { checkDuplicateByTitle } from '@/processing/duplicate-detector';
import {
  getSettings,
  saveUserPreferences,
  reserveImportQuota,
  refundImportQuota,
  incrementUsage,
  checkQuota,
} from './usage-tracker';
import { reRegisterServerEntitlement, refundEntitledQuota, reserveEntitledQuota } from './entitlement-client';
import { sanitizeYouTubeUrl, deduplicateUrls } from '@/utils/url-sanitizer';
import {
  createBatchQueue,
  saveQueue,
  loadQueue,
  clearQueue,
  advanceQueue,
  MAX_BATCH_SIZE,
} from './batch-queue';
import { setImportStatus, getImportStatus, clearImportStatus } from './import-status';
import { showToast, setToastTab } from './toast';
import { t } from '@/utils/i18n';
import { listNlmNotebooks, findMatchingNotebooks, clearNotebookCache, fetchSessionTokens, type NlmNotebook } from './nlm-api';
import { deduplicateAgainstCache, addToDedupCache, removeFromDedupCache } from './dedup-cache';
import { YT, NLM } from '@/config/selectors';
import { notionExport } from '@/utils/notion-sync';
import { createVideoSourceRecord } from '@/utils/source-resolution';
import { buildDiagnosticsBundle, formatDiagnosticsBundle } from '@/utils/diagnostics';
import { upsertSourceRecord, loadSourceIndex } from './source-store';
// dedup-cache is GLOBAL (not per-notebook) — always catches duplicates regardless of notebook matching

// ---------------------------------------------------------------------------
// Pre-load config on service worker startup
// ---------------------------------------------------------------------------

let configPromise = getConfig();

// ---------------------------------------------------------------------------
// C-1 FIX: Service worker keep-alive during long-running imports
// chrome.alarms fires every ~25s to prevent MV3 SW termination (30s idle timeout).
// ---------------------------------------------------------------------------
const KEEPALIVE_ALARM = 'videolm-keepalive';

async function startKeepAlive(): Promise<void> {
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
  } catch { /* alarms permission missing — degrade gracefully */ }
}

async function stopKeepAlive(): Promise<void> {
  try {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch { /* ignore */ }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op — the alarm firing itself keeps the SW alive
    console.log('[VideoLM] keepalive ping');
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the YouTube content script is ready in the tab.
 * The content script is auto-injected via manifest.json on YouTube pages,
 * but may not have initialized yet when the popup opens quickly.
 */
async function waitForContentScript(tabId: number, maxRetries = 5): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true; // Content script responded
    } catch {
      // Not ready yet — wait and retry
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false; // Content script never responded
}

/**
 * Get the source list from the NotebookLM tab by messaging its content script.
 */
async function getSourceListFromNlmTab(): Promise<Array<{ title: string; url?: string }>> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    if (tabs.length === 0 || !tabs[0].id) return [];

    const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_SOURCE_LIST' });
    return response?.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Default dependencies for processAndImport — wires chrome-backed implementations.
 */
function defaultProcessDeps() {
  return {
    getSettings,
    checkQuota,
    incrementUsage,
    reserveUsage: async (key: 'imports' | 'aiCalls', count = 1) => {
      const remoteQuota = await reserveEntitledQuota(key, count);
      return { allowed: remoteQuota.allowed, error: remoteQuota.error, reservationId: remoteQuota.reservationId };
    },
    refundUsage: async (key: 'imports' | 'aiCalls', reservationId: string, count?: number) => {
      await refundEntitledQuota(key, reservationId, count);
    },
    resolveProvider,
    t,
  };
}

function inferPageTypeFromUrl(url?: string): string {
  if (!url) return 'unknown';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('notebooklm.google.com')) return parsed.pathname.includes('/notebook/') ? 'notebooklm-notebook' : 'notebooklm-home';
    if (!parsed.hostname.includes('youtube.com')) return 'unsupported';
    if (parsed.pathname === '/watch') return 'watch';
    if (parsed.pathname === '/playlist') return 'playlist';
    if (parsed.pathname === '/results') return 'search';
    if (parsed.pathname.startsWith('/@') || parsed.pathname.includes('/channel/')) return 'channel';
    return 'youtube';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// NLM Import Core — reusable by QUICK_IMPORT and BATCH_IMPORT
// ---------------------------------------------------------------------------

/**
 * Get the current source count and existing source URLs from the open NLM notebook.
 * Returns { count, existingUrls, limit } for capacity checking and deduplication.
 */
async function getNlmNotebookInfo(): Promise<{
  count: number;
  limit: number;
  existingUrls: string[];
}> {
  try {
    const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    // Only read capacity from a specific notebook page, NOT the homepage.
    // The homepage shows other notebooks' "X 個來源" which gives wrong counts.
    if (!nlmTabs[0]?.id || !nlmTabs[0]?.url?.includes('/notebook/')) {
      return { count: 0, limit: 50, existingUrls: [] };
    }

    // Wrap executeScript with 5s timeout to prevent hanging
    // H-8 FIX: Removed document.body.innerText (triggers full reflow)
    // C-5 FIX: Proper destructuring — handle empty results safely
    const execPromise = chrome.scripting.executeScript({
      target: { tabId: nlmTabs[0].id },
      world: 'MAIN' as any,
      func: (sel: { SOURCE_CARD: string; SOURCE_ITEMS: string; YOUTUBE_LINKS: string; WARNINGS: string }) => {
        let count = 0;
        let limit = 50;

        // Method 1: Read "X 個來源" or "X sources" text in sidebar header
        const sourceHeaders = document.querySelectorAll(sel.SOURCE_CARD);
        for (const el of sourceHeaders) {
          const text = el.textContent || '';
          const countMatch = text.match(/(\d+)\s*(?:個來源|sources)/i);
          if (countMatch) { count = parseInt(countMatch[1], 10); break; }
          const slashMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
          if (slashMatch) {
            count = parseInt(slashMatch[1], 10);
            limit = parseInt(slashMatch[2], 10);
            break;
          }
        }

        // Method 2: Count actual source link elements in sidebar
        if (count === 0) {
          const sourceItems = document.querySelectorAll(sel.SOURCE_ITEMS);
          count = sourceItems.length;
        }

        // Method 3: Check for limit warning using textContent (NOT innerText — avoids reflow)
        const warnings = document.querySelectorAll(sel.WARNINGS);
        for (const w of warnings) {
          const text = w.textContent || '';
          if (text.includes('已達上限') || text.includes('limit reached')) {
            const limitMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
            if (limitMatch) {
              count = parseInt(limitMatch[1], 10);
              limit = parseInt(limitMatch[2], 10);
            } else {
              count = 50;
            }
            break;
          }
        }

        // Collect existing YouTube URLs for deduplication
        const existingUrls: string[] = [];
        const allLinks = document.querySelectorAll(sel.YOUTUBE_LINKS);
        allLinks.forEach(a => {
          const href = a.getAttribute('href');
          if (href) existingUrls.push(href);
        });

        const sourceElements = document.querySelectorAll(sel.SOURCE_CARD);
        sourceElements.forEach(el => {
          const text = el.textContent || '';
          const urlMatch = text.match(/youtube\.com\/watch\?v=[\w-]+/g);
          if (urlMatch) urlMatch.forEach(u => existingUrls.push('https://www.' + u));
        });

        return { count, limit, existingUrls };
      },
      args: [NLM],
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getNlmNotebookInfo timeout')), 5000),
    );
    const results = await Promise.race([execPromise, timeoutPromise]);
    const result = Array.isArray(results) && results.length > 0 ? results[0] : null;

    return (result?.result as any) || { count: 0, limit: 50, existingUrls: [] };
  } catch (e) {
    // L-2 FIX: Log so dedup failure is visible in dev console
    console.log('[VideoLM] getNlmNotebookInfo error (dedup disabled for this import):', e);
    return { count: 0, limit: 50, existingUrls: [] };
  }
}

/**
 * Remove URLs that already exist in the NLM notebook (deduplication).
 */
function deduplicateAgainstExisting(urls: string[], existingUrls: string[]): string[] {
  // Extract video IDs from existing URLs for comparison
  const existingIds = new Set<string>();
  for (const url of existingUrls) {
    const match = url.match(/[?&]v=([\w-]+)/);
    if (match) existingIds.add(match[1]);
  }

  return urls.filter(url => {
    const match = url.match(/[?&]v=([\w-]+)/);
    return match ? !existingIds.has(match[1]) : true;
  });
}

/** Filter out URLs whose video IDs already exist in any of the matched notebooks */
function deduplicateAgainstNotebooks(urls: string[], notebooks: NlmNotebook[]): { uniqueUrls: string[]; skippedCount: number } {
  const existingIds = new Set<string>();
  for (const nb of notebooks) {
    for (const vid of nb.sourceVideoIds) {
      existingIds.add(vid);
    }
  }
  if (existingIds.size === 0) return { uniqueUrls: urls, skippedCount: 0 };

  const uniqueUrls = urls.filter(url => {
    const match = url.match(/[?&]v=([\w-]{11})/);
    return match ? !existingIds.has(match[1]) : true;
  });
  const skippedCount = urls.length - uniqueUrls.length;
  if (skippedCount > 0) {
    console.log(`[VideoLM] Source-level dedup: ${skippedCount} URLs already exist in matched notebooks (${existingIds.size} known video IDs)`);
  }
  return { uniqueUrls, skippedCount };
}

/** Check which YouTube URLs are valid (not deleted/private) via oEmbed API */
async function filterValidYouTubeUrls(urls: string[]): Promise<{ valid: string[]; invalid: string[] }> {
  const valid: string[] = [];
  const invalid: string[] = [];

  // Batch check in parallel (max 10 concurrent, 5s timeout per request)
  const CONCURRENCY = 10;
  const TIMEOUT_MS = 5000;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
          const resp = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
            { signal: controller.signal },
          );
          clearTimeout(timer);
          return { url, ok: resp.ok };
        } catch {
          // Timeout or network error — assume valid (don't block import)
          return { url, ok: true };
        }
      }),
    );
    for (const r of results) {
      if (r.ok) valid.push(r.url);
      else invalid.push(r.url);
    }
  }

  if (invalid.length > 0) {
    console.log(`[VideoLM] URL validation: ${invalid.length} invalid videos filtered out (deleted/private)`);
  }
  return { valid, invalid };
}

/**
 * Import YouTube URLs into the currently-open NLM notebook.
 *
 * Uses NLM's internal batchexecute API (izAoDd RPC) directly — NO UI automation.
 * This is the same approach used by competing 200K+ user extensions.
 *
 * Each URL is added via a direct POST to the batchexecute endpoint,
 * using session credentials from the NLM page. Zero UI interference,
 * no "已達上限" warnings, ~500ms per source.
 */
async function importUrlsToNlm(
  urls: string[],
  targetNotebookId?: string,
  targetAuthuser?: string,
  autoCreateTitle?: string,
  onProgress?: (progress: number, phase: string) => void,
): Promise<{
  success: boolean;
  error?: string;
  urlCount: number;
  message?: string;
  clipboardText?: string;
  notebookId?: string;
  authuser?: string;
}> {
  const urlCount = urls.length;

  if (urls.length === 0 || urls.every(u => !u)) {
    return { success: false, error: t('error_no_urls'), urlCount: 0 };
  }

  // Determine notebook ID: either passed directly or from open NLM tab
  let notebookId = targetNotebookId || '';
  let authuser = targetAuthuser || '';

  if (!notebookId) {
    // Try to get notebook ID from an open NLM tab
    const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });

    if (nlmTabs[0]?.url?.includes('/notebook/')) {
      const nbMatch = nlmTabs[0].url.match(/\/notebook\/([a-f0-9-]+)/);
      notebookId = nbMatch ? nbMatch[1] : '';
      try { authuser = new URL(nlmTabs[0].url).searchParams.get('authuser') || ''; } catch {}
    }

    // If still no notebook, try to get authuser from NLM homepage tab
    if (!notebookId && nlmTabs[0]?.url) {
      try { authuser = new URL(nlmTabs[0].url).searchParams.get('authuser') || ''; } catch {}
    }
  }

  // Auto-create a notebook if none is open and a title is provided
  if (!notebookId && autoCreateTitle) {
    console.log(`[VideoLM] No notebook open — auto-creating "${autoCreateTitle}"`);
    const newId = await createNlmNotebook(autoCreateTitle, authuser);
    if (newId) {
      notebookId = newId;
      console.log(`[VideoLM] Auto-created notebook: ${newId}`);
      // M-9 FIX: Poll for notebook readiness instead of hardcoded sleep
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1000));
        clearNotebookCache();
        const freshList = await listNlmNotebooks(authuser);
        if (freshList.some(nb => nb.id === newId)) break;
      }
    } else {
      return { success: false, urlCount, error: t('error_cannot_autocreate') };
    }
  }

  if (!notebookId) {
    return { success: false, urlCount, error: t('error_no_notebook') };
  }

  // ═══════════════════════════════════════════════════════════════
  // Direct API approach — same as competitor (200K+ users)
  // Fetch NLM homepage to get session tokens, then POST batchexecute
  // directly from the service worker. No executeScript needed!
  // ═══════════════════════════════════════════════════════════════

  console.log(`[VideoLM] importUrlsToNlm: notebookId=${notebookId}, authuser=${authuser}, urls=${urls.length}`);

  // Step 1: Fetch session tokens via shared helper (C-3 FIX: single source of truth)
  onProgress?.(20, t('toast_connecting'));
  const tokens = await fetchSessionTokens(authuser);
  if (!tokens) {
    return { success: false, urlCount, error: t('error_cannot_connect') };
  }
  const { bl, atToken } = tokens;

  // Step 2: Build sources array — ALL URLs in one API call (like competitor)
  const validUrls = urls.filter(Boolean);
  const remoteQuota = await reserveEntitledQuota('imports', validUrls.length);
  if (!remoteQuota.allowed) {
    return {
      success: false,
      clipboardText: urls.join('\n'),
      urlCount,
      error: t('error_quota_exceeded'),
      notebookId,
      authuser,
    };
  }
  const sources = validUrls.map(url =>
    url.includes('youtube.com')
      ? [null, null, null, null, null, null, null, [url]]   // YouTube URL
      : [null, null, [url]]                                  // Website URL
  );

  onProgress?.(55, t('toast_submitting', [validUrls.length.toString()]));
  console.log(`[VideoLM] Sending ${validUrls.length} URLs to notebook ${notebookId} via batchexecute`);

  try {
    chrome.action.setBadgeText({ text: `${validUrls.length}` });
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } catch { /* ignore */ }

  // Step 3: Single batchexecute call with ALL sources
  const rpcId = 'izAoDd';
  const reqId = Math.floor(100000 + Math.random() * 900000);
  const qp = new URLSearchParams({
    'rpcids': rpcId,
    'source-path': `/notebook/${notebookId}`,
    'bl': bl,
    '_reqid': String(reqId),
    'rt': 'c',
  });
  if (authuser) qp.append('authuser', authuser);

  const fReq = JSON.stringify([[[rpcId, JSON.stringify([sources, notebookId]), null, 'generic']]]);
  const body = new URLSearchParams({ 'f.req': fReq, 'at': atToken });

  let totalSuccess = 0;
  let lastError = '';

  try {
    const resp = await fetch(
      `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${qp.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }
    );

    if (resp.ok) {
      totalSuccess = validUrls.length;
      onProgress?.(90, t('toast_nlm_processing'));
      console.log(`[VideoLM] batchexecute success — ${totalSuccess} sources submitted`);
    } else {
      lastError = `batchexecute returned ${resp.status}`;
      console.log(`[VideoLM] batchexecute failed: ${resp.status}`);
    }
  } catch (e) {
    lastError = String(e);
    console.log(`[VideoLM] batchexecute error:`, e);
  }

  console.log(`[VideoLM] Import complete: ${totalSuccess}/${validUrls.length}`);

  // Clear badge on completion
  try {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#34a853' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 8000);
  } catch { /* ignore */ }

  if (totalSuccess > 0) {
    const unusedReservation = validUrls.length - totalSuccess;
    if (unusedReservation > 0) {
      if (remoteQuota.reservationId) {
        await refundEntitledQuota('imports', remoteQuota.reservationId, unusedReservation);
      }
    }
    // Record in global dedup cache so future imports skip these videos
    await addToDedupCache(validUrls);
    const failCount = validUrls.length - totalSuccess;
    let msg = totalSuccess === 1
      ? t('msg_single_added')
      : t('msg_multi_added', [totalSuccess.toString()]);
    if (failCount > 0) msg += ` (${failCount} failed)`;
    return { success: true, message: msg, urlCount: totalSuccess, notebookId, authuser };
  } else {
    if (remoteQuota.reservationId) {
      await refundEntitledQuota('imports', remoteQuota.reservationId, validUrls.length);
    }
    return {
      success: false, clipboardText: urls.join('\n'), urlCount,
      error: lastError || t('error_api_failed'), notebookId, authuser,
    };
  }
}

// ---------------------------------------------------------------------------
// NLM Notebook Creation — create new notebooks via API for auto-split
// ---------------------------------------------------------------------------

/**
 * Create a new notebook in NLM via batchexecute API (CCqFvf RPC).
 * Returns the new notebook ID, or null on failure.
 */
async function createNlmNotebook(title: string, authuser = ''): Promise<string | null> {
  // C-3 FIX: Use shared fetchSessionTokens helper
  try {
    const tokens = await fetchSessionTokens(authuser);
    if (!tokens) return null;
    const { bl, atToken } = tokens;

    // CCqFvf = Create notebook RPC (same as competitor)
    const rpcId = 'CCqFvf';
    const innerPayload = JSON.stringify([title]);
    const fReq = JSON.stringify([[[rpcId, innerPayload, null, 'generic']]]);
    const reqId = Math.floor(100000 + Math.random() * 900000);

    const qp = new URLSearchParams({
      'rpcids': rpcId, 'source-path': '/', 'bl': bl,
      '_reqid': String(reqId), 'rt': 'c',
    });
    if (authuser) qp.append('authuser', authuser);

    const body = new URLSearchParams({ 'f.req': fReq, 'at': atToken });

    const resp = await fetch(
      `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${qp.toString()}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }
    );

    if (!resp.ok) {
      console.log(`[VideoLM] createNotebook failed: HTTP ${resp.status}`);
      return null;
    }

    const text = await resp.text();
    // H-7 FIX: Parse batchexecute response structure to find the notebook UUID
    // in the CCqFvf response data — not just any UUID in the response body.
    let nbId: string | null = null;
    try {
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.includes('CCqFvf')) {
          // Found the CCqFvf response line — extract UUID from it
          const uuidMatch = trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          if (uuidMatch) { nbId = uuidMatch[1]; break; }
        }
      }
    } catch { /* ignore parse errors */ }
    // Fallback: scan entire body (less precise but compatible)
    if (!nbId) {
      const uuidMatch = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      nbId = uuidMatch ? uuidMatch[1] : null;
    }
    console.log(`[VideoLM] Created notebook "${title}" → ${nbId}`);
    return nbId;
  } catch (e) {
    console.log(`[VideoLM] createNotebook error:`, e);
    return null;
  }
}

/**
 * Post-import: refresh NLM tab (or open notebook) + show notification.
 * Shared by both QUICK_IMPORT and BATCH_IMPORT paths.
 */
async function postImportActions(
  notebookId: string,
  authuser: string,
  totalImported: number,
  pageTitle: string,
): Promise<void> {
  // H-10 FIX: Only open/navigate NLM tab — never force-reload an existing one.
  // Force-reloading can destroy user's in-progress editing.
  try {
    const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    if (nlmTabs[0]?.id) {
      // NLM tab exists — only navigate if it's on a different notebook
      const currentUrl = nlmTabs[0].url || '';
      if (!currentUrl.includes(`/notebook/${notebookId}`)) {
        const qs = authuser ? `?authuser=${authuser}` : '';
        await chrome.tabs.update(nlmTabs[0].id, {
          url: `https://notebooklm.google.com/notebook/${notebookId}${qs}`,
        });
      }
      // If already on the correct notebook, do NOT reload — user may be editing
      console.log('[VideoLM] NLM tab ready (no forced reload)');
    } else if (notebookId) {
      // No NLM tab open (auto-create case) — open a new tab
      const qs = authuser ? `?authuser=${authuser}` : '';
      await chrome.tabs.create({
        url: `https://notebooklm.google.com/notebook/${notebookId}${qs}`,
      });
      console.log('[VideoLM] Opened new NLM tab for notebook');
    }
  } catch { /* tab may have been closed */ }

  // Show floating toast on YouTube tab (primary feedback — always visible)
  const nbUrl = notebookId
    ? `https://notebooklm.google.com/notebook/${notebookId}${authuser ? `?authuser=${authuser}` : ''}`
    : '';
  await showToast({
    state: 'success',
    text: totalImported === 1
      ? t('toast_single_imported', [pageTitle])
      : t('toast_multi_imported', [totalImported.toString(), pageTitle]),
    viewUrl: nbUrl,
    dismissAfter: 8000,
  });

  // Also show system notification as backup (may be blocked by OS)
  try {
    // Use 48px icon — MV3 service workers sometimes fail to load larger icons
    // M-11 FIX: Unique notification ID so concurrent imports don't overwrite
    chrome.notifications.create(`videolm-import-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: t('notif_import_complete'),
      message: totalImported === 1
        ? t('toast_single_imported', [pageTitle])
        : t('toast_multi_imported', [totalImported.toString(), pageTitle]),
      silent: false,
    }, () => {
      // Suppress "Unable to download images" error in callback
      if (chrome.runtime.lastError) {
        console.log('[VideoLM] Notification warning:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.log('[VideoLM] Notification error:', e);
  }
}

/**
 * Run the full auto-split batch import:
 * 1. Import first batch to current notebook
 * 2. For each remaining chunk: auto-create notebook + import
 * 3. Play completion sound
 * All runs in background — popup can be closed.
 */
async function runAutoSplitImport(
  urls: string[],
  pageTitle: string,
  existingCount: number,
  limit: number,
  authuser = '',
  targetNotebookId = '',
): Promise<void> {
  // C-1 FIX: Keep service worker alive during long batch imports
  await startKeepAlive();
  try {
    await _runAutoSplitImportInner(urls, pageTitle, existingCount, limit, authuser, targetNotebookId);
  } finally {
    await stopKeepAlive();
  }
}

async function _runAutoSplitImportInner(
  urls: string[],
  pageTitle: string,
  existingCount: number,
  limit: number,
  authuser: string,
  targetNotebookId: string,
): Promise<void> {
  const availableSlots = Math.max(0, limit - existingCount);
  const firstBatch = urls.slice(0, availableSlots);
  const remaining = urls.slice(availableSlots);

  console.log(`[VideoLM] runAutoSplitImport: total=${urls.length}, existingCount=${existingCount}, limit=${limit}, availableSlots=${availableSlots}, firstBatch=${firstBatch.length}, remaining=${remaining.length}, targetNb=${targetNotebookId}`);

  let totalImported = 0;
  let lastImportedNbId = targetNotebookId || '';
  let firstResultNbId = '';
  let firstResultAuthuser = authuser;

  // Import first batch to current notebook (skip if already full)
  if (firstBatch.length > 0) {
    await setImportStatus({
      active: true, pageTitle, totalUrls: urls.length,
      importedCount: 0, phase: `Importing ${firstBatch.length} to current notebook...`,
      startedAt: Date.now(),
    });
    await showToast({
      state: 'importing',
      text: t('toast_importing_count', [firstBatch.length.toString()]),
      progress: 0,
    });

    const firstResult = await importUrlsToNlm(
      firstBatch,
      targetNotebookId || undefined,
      targetNotebookId ? authuser : undefined,
      targetNotebookId ? undefined : pageTitle,  // Only auto-create if no target
      async (pct, phase) => {
        await showToast({ state: 'importing', text: phase, progress: pct });
      },
    );
    totalImported = firstResult.success ? firstBatch.length : 0;
    firstResultNbId = firstResult.notebookId || '';
    firstResultAuthuser = firstResult.authuser || authuser;

    if (!firstResult.success) {
      await setImportStatus({
        active: false, pageTitle, totalUrls: urls.length,
        importedCount: 0, phase: 'Failed', startedAt: Date.now(),
        lastError: firstResult.error, completed: true,
      });
      await showToast({
        state: 'error',
        text: t('toast_import_failed', [firstResult.error || '']),
      });
      return;
    }
    lastImportedNbId = firstResultNbId || lastImportedNbId;
  } else {
    console.log(`[VideoLM] Target notebook already full (${existingCount}/${limit}), skipping to overflow`);
  }

  // Process remaining chunks — each gets a new or existing Part notebook
  let remainingUrls = remaining;
  let partNumber = 2;

  const MAX_PARTS = 20; // Safety bound to prevent infinite loop
  while (remainingUrls.length > 0 && partNumber <= MAX_PARTS) {
    // Checkpoint: persist remaining URLs for crash recovery
    const checkpoint = createBatchQueue(remainingUrls, pageTitle);
    await saveQueue(checkpoint);

    const pct = Math.round((totalImported / urls.length) * 100);
    const partTitle = `${pageTitle} - Part ${partNumber}`;

    // Check if a "Part N" notebook already exists — reuse it instead of creating duplicate
    // H-9 FIX: Only clear cache once per chunk, not redundantly
    let targetNbId = '';
    let partExistingCount = 0;
    clearNotebookCache();
    const allNotebooks = await listNlmNotebooks(authuser);
    const existingPart = allNotebooks.find(
      (nb) => nb.name.trim().toLowerCase() === partTitle.trim().toLowerCase(),
    );

    if (existingPart) {
      targetNbId = existingPart.id;
      partExistingCount = existingPart.sourceCount;
      const partAvailable = Math.max(0, limit - partExistingCount);
      console.log(`[VideoLM] Found existing "${partTitle}" (${partExistingCount} sources, ${partAvailable} slots)`);

      if (partAvailable === 0) {
        // This Part is full — skip to next part number
        partNumber++;
        continue;
      }

      // Only take what fits in the existing Part
      const chunk = remainingUrls.slice(0, partAvailable);
      remainingUrls = remainingUrls.slice(partAvailable);

      await setImportStatus({
        active: true, pageTitle, totalUrls: urls.length,
        importedCount: totalImported,
        phase: `Merging ${chunk.length} into "${partTitle}"...`,
        startedAt: Date.now(),
      });
      await showToast({
        state: 'importing',
        text: t('toast_merging_part', [partNumber.toString(), totalImported.toString(), urls.length.toString()]),
        progress: pct,
      });

      const chunkResult = await importUrlsToNlm(
        chunk, targetNbId, authuser, undefined,
        async (pct, phase) => {
          await showToast({ state: 'importing', text: phase, progress: pct });
        },
      );
      if (chunkResult.success) {
        totalImported += chunk.length;
        lastImportedNbId = targetNbId;
      }
      partNumber++;
      continue;
    }

    // No existing Part N — create a new one
    const chunk = remainingUrls.slice(0, limit);
    remainingUrls = remainingUrls.slice(limit);

    await setImportStatus({
      active: true, pageTitle, totalUrls: urls.length,
      importedCount: totalImported,
      phase: `Creating "${partTitle}"...`,
      startedAt: Date.now(),
    });
    await showToast({
      state: 'importing',
      text: t('toast_creating_part', [partNumber.toString(), totalImported.toString(), urls.length.toString()]),
      progress: pct,
    });

    const newNbId = await createNlmNotebook(partTitle, authuser);
    clearNotebookCache();
    if (!newNbId) {
      const queue = createBatchQueue(remainingUrls.length > 0 ? [...chunk, ...remainingUrls] : chunk, pageTitle);
      await saveQueue(queue);
      await setImportStatus({
        active: false, pageTitle, totalUrls: urls.length,
        importedCount: totalImported,
        phase: 'Notebook creation failed', startedAt: Date.now(),
        completed: true, needsNewNotebook: true,
        remainingCount: chunk.length + remainingUrls.length,
        completionMessage: `Imported ${totalImported} videos. Could not auto-create Part ${partNumber}. ${chunk.length + remainingUrls.length} remaining in queue.`,
      });
      return;
    }

    // M-9 FIX: Poll for notebook readiness instead of hardcoded sleep
    console.log(`[VideoLM] Waiting for notebook ${newNbId} to be ready...`);
    let nbReady = false;
    for (let i = 0; i < 6; i++) { // 6 × 1s = 6s max wait
      await new Promise(r => setTimeout(r, 1000));
      clearNotebookCache();
      const freshList = await listNlmNotebooks(authuser);
      if (freshList.some(nb => nb.id === newNbId)) { nbReady = true; break; }
    }
    if (!nbReady) console.log(`[VideoLM] Notebook ${newNbId} may not be ready — proceeding anyway`);

    await setImportStatus({
      active: true, pageTitle, totalUrls: urls.length,
      importedCount: totalImported,
      phase: `Importing ${chunk.length} to "${partTitle}"...`,
      startedAt: Date.now(),
    });
    await showToast({
      state: 'importing',
      text: t('toast_importing_to_part', [partNumber.toString(), totalImported.toString(), urls.length.toString()]),
      progress: Math.round((totalImported / urls.length) * 100),
    });

    const chunkResult = await importUrlsToNlm(
      chunk, newNbId, authuser, undefined,
      async (pct, phase) => {
        await showToast({ state: 'importing', text: phase, progress: pct });
      },
    );
    if (chunkResult.success) {
      totalImported += chunk.length;
      lastImportedNbId = newNbId;
    }

    partNumber++;
  }

  // Use the first notebook for navigation (user's primary interest)
  const lastNbId = firstResultNbId || lastImportedNbId;
  const lastAuthuser = firstResultAuthuser || authuser;

  // All done — clear checkpoint queue
  await clearQueue();

  // Update status
  await setImportStatus({
    active: false, pageTitle, totalUrls: urls.length,
    importedCount: totalImported, phase: 'Complete', startedAt: Date.now(),
    completed: true,
    completionMessage: partNumber > 2
      ? `All ${totalImported} videos imported across ${partNumber - 1} notebooks!`
      : `All ${totalImported} videos imported!`,
  });

  // Refresh NLM tab + show notification (shared helper)
  await postImportActions(lastNbId, lastAuthuser, totalImported, pageTitle);
}

// ---------------------------------------------------------------------------
// Store videoContent for NLM content-script copy button
// ---------------------------------------------------------------------------

async function storeVideoContentForNlm(videoContent: VideoContent): Promise<void> {
  const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
  const nlmTabId = nlmTabs[0]?.id ?? 0;
  const payload = {
    [`_videolm_lastVideo_${nlmTabId}`]: {
      videoContent,
      storedAt: Date.now(),
    },
  };
  await Promise.all([
    chrome.storage.session.set(payload),
    chrome.storage.local.set(payload),
  ]);
  console.log('[VideoLM] videoContent stored for NLM tab:', nlmTabId, 'title:', videoContent.title);
}

/** Build minimal VideoContent from just a URL + title (for QUICK_IMPORT) */
function buildMinimalVideoContent(videoUrl: string, title: string): VideoContent | null {
  const m = videoUrl.match(/[?&]v=([\w-]{11})/);
  if (!m) return null;
  return {
    videoId: m[1],
    title,
    author: '',
    platform: 'youtube',
    transcript: [],
    duration: 0,
    language: '',
    url: videoUrl,
    metadata: { publishDate: '', viewCount: 0, tags: [] },
  };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: MessageType, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_VIDEO_CONTENT': {
        // All extraction runs from the background via chrome.scripting.executeScript.
        // This is the most reliable approach because:
        // - world:'MAIN' gives access to page JS (player API, ytInitialPlayerResponse)
        // - No CSP/Trusted Types issues (official Chrome API, not script injection)
        // - No content script isolation issues
        // - Works after SPA navigation
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: 'No active tab' });
              return;
            }

            const expectedVideoId = extractVideoId(tab.url);

            // Step 1: Get playerResponse from MAIN world
            const [prResult] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN' as any,
              func: (expectedId: string, playerSel: string) => {
                // Try player API first (always current after SPA nav)
                let pr: any = null;
                try {
                  const player = document.querySelector(playerSel) as any;
                  if (player?.getPlayerResponse) pr = player.getPlayerResponse();
                } catch {}
                // Fallback to global variable
                if (!pr) pr = (window as any).ytInitialPlayerResponse;
                if (!pr) return null;

                // Verify videoId matches (SPA safety)
                if (expectedId && pr.videoDetails?.videoId !== expectedId) return null;

                return {
                  videoId: pr.videoDetails?.videoId || '',
                  title: pr.videoDetails?.title || '',
                  author: pr.videoDetails?.author || '',
                  lengthSeconds: pr.videoDetails?.lengthSeconds || '0',
                  keywords: pr.videoDetails?.keywords || [],
                  publishDate: pr.microformat?.playerMicroformatRenderer?.publishDate || '',
                  viewCount: pr.microformat?.playerMicroformatRenderer?.viewCount || '0',
                  captionTracks: (pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t: any) => ({
                    baseUrl: t.baseUrl || '',
                    languageCode: t.languageCode || '',
                    name: t.name?.simpleText || '',
                    isAuto: t.kind === 'asr',
                  })),
                  // Chapter data is too deeply nested — extract path
                  chapters: (() => {
                    try {
                      const map = pr.playerOverlays?.playerOverlayRenderer
                        ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer
                        ?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
                      if (!map?.[0]?.value?.chapters) return [];
                      return map[0].value.chapters.map((c: any, i: number, arr: any[]) => ({
                        title: c.chapterRenderer?.title?.simpleText || '',
                        startMs: c.chapterRenderer?.timeRangeStartMillis || 0,
                        nextStartMs: i < arr.length - 1 ? (arr[i+1].chapterRenderer?.timeRangeStartMillis || 0) : Infinity,
                      }));
                    } catch { return []; }
                  })(),
                };
              },
              args: [expectedVideoId || '', YT.PLAYER],
            });

            let prData = prResult?.result;

            // Retry if player wasn't ready yet (SPA nav in progress)
            if (!prData && expectedVideoId) {
              await new Promise(r => setTimeout(r, 1500));
              const [retry] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN' as any,
                func: (playerSel: string) => {
                  let pr: any = null;
                  try {
                    const player = document.querySelector(playerSel) as any;
                    if (player?.getPlayerResponse) pr = player.getPlayerResponse();
                  } catch {}
                  if (!pr) pr = (window as any).ytInitialPlayerResponse;
                  if (!pr) return null;
                  return {
                    videoId: pr.videoDetails?.videoId || '',
                    title: pr.videoDetails?.title || '',
                    author: pr.videoDetails?.author || '',
                    lengthSeconds: pr.videoDetails?.lengthSeconds || '0',
                    keywords: pr.videoDetails?.keywords || [],
                    publishDate: pr.microformat?.playerMicroformatRenderer?.publishDate || '',
                    viewCount: pr.microformat?.playerMicroformatRenderer?.viewCount || '0',
                    captionTracks: (pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t: any) => ({
                      baseUrl: t.baseUrl || '', languageCode: t.languageCode || '',
                      name: t.name?.simpleText || '', isAuto: t.kind === 'asr',
                    })),
                    chapters: (() => { try {
                      const map = pr.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
                      if (!map?.[0]?.value?.chapters) return [];
                      return map[0].value.chapters.map((c: any, i: number, arr: any[]) => ({
                        title: c.chapterRenderer?.title?.simpleText || '', startMs: c.chapterRenderer?.timeRangeStartMillis || 0,
                        nextStartMs: i < arr.length - 1 ? (arr[i+1].chapterRenderer?.timeRangeStartMillis || 0) : Infinity,
                      }));
                    } catch { return []; } })(),
                  };
                },
                args: [YT.PLAYER],
              });
              prData = retry?.result;
            }

            if (!prData) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: t('error_cannot_read_video') });
              return;
            }

            // Step 2: Try Tier 1 — fetch caption XML (from background, has host_permissions)
            let segments: any[] = [];
            const bestTrack = prData.captionTracks.find((t: any) => !t.isAuto) ?? prData.captionTracks[0];

            if (bestTrack?.baseUrl) {
              try {
                const resp = await fetch(bestTrack.baseUrl);
                if (resp.ok) {
                  const xml = await resp.text();
                  if (xml && xml.length > 10) {
                    segments = parseXMLCaptions(xml);
                  }
                }
              } catch {}
            }

            // Step 3: If Tier 1 failed, try Tier 2 — DOM scraping in MAIN world
            // C-4 FIX: chrome.scripting.executeScript does NOT await async funcs.
            // Split into two sync calls: (1) click transcript button, (2) read segments.
            if (segments.length === 0 && prData.captionTracks.length > 0) {
              // Step 3a: Click transcript button (sync — no awaits needed)
              const [clickResult] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN' as any,
                func: (tSel: {
                  PANEL_EXPANDED: readonly string[];
                  OPEN_BUTTONS: string;
                  DESCRIPTION_EXPAND: string;
                  DESCRIPTION_COLLAPSE: string;
                  BUTTON_LABELS: readonly string[];
                }) => {
                  const qf = (ss: readonly string[]) => { for (const s of ss) { const e = document.querySelector(s); if (e) return e; } return null; };
                  // Close any stale transcript panel first
                  const existingPanel = qf(tSel.PANEL_EXPANDED);
                  if (existingPanel) {
                    const cb = existingPanel.querySelector('#header button') as HTMLElement;
                    if (cb) cb.click();
                  }
                  // Expand description
                  const expand = document.querySelector(tSel.DESCRIPTION_EXPAND) as HTMLElement;
                  if (expand) expand.click();
                  // Click transcript button
                  const btns = document.querySelectorAll(tSel.OPEN_BUTTONS);
                  for (const btn of btns) {
                    const t = btn.textContent?.trim() || '';
                    if (tSel.BUTTON_LABELS.some(l => t.includes(l))) {
                      (btn as HTMLElement).click();
                      return true; // clicked
                    }
                  }
                  // Collapse description if no transcript button found
                  const col = document.querySelector(tSel.DESCRIPTION_COLLAPSE) as HTMLElement;
                  if (col) col.click();
                  return false; // not clicked
                },
                args: [YT.TRANSCRIPT],
              });

              const transcriptClicked = clickResult?.result === true;

              if (transcriptClicked) {
                // Wait for transcript panel to load (service worker sleep — no executeScript needed)
                await new Promise(r => setTimeout(r, 4000));

                // Step 3b: Read segments (sync — just reads DOM)
                const [domResult] = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  world: 'MAIN' as any,
                  func: (tSel: {
                    SEGMENT_MODERN: string; SEGMENT_MODERN_TIMESTAMP: string; SEGMENT_MODERN_TEXT: string;
                    SEGMENT_LEGACY: string; SEGMENT_LEGACY_TIMESTAMP: string; SEGMENT_LEGACY_TEXT: string;
                  }) => {
                    // Read segments — modern format
                    const modern = document.querySelectorAll(tSel.SEGMENT_MODERN);
                    if (modern.length > 0) {
                      const segs = [...modern].map(el => {
                        const ts = (el.querySelector(tSel.SEGMENT_MODERN_TIMESTAMP) as HTMLElement)?.textContent?.trim() || '';
                        const tx = (el.querySelector(tSel.SEGMENT_MODERN_TEXT) as HTMLElement)?.textContent?.trim() || '';
                        const parts = ts.split(':').map(Number);
                        let start = 0;
                        if (parts.length === 3) start = parts[0]*3600 + parts[1]*60 + parts[2];
                        else if (parts.length === 2) start = parts[0]*60 + parts[1];
                        return tx ? { text: tx, start, duration: 0 } : null;
                      }).filter(Boolean);
                      return segs;
                    }
                    // Read segments — legacy format
                    const legacy = document.querySelectorAll(tSel.SEGMENT_LEGACY);
                    if (legacy.length > 0) {
                      const segs = [...legacy].map(el => {
                        const ts = (el.querySelector(tSel.SEGMENT_LEGACY_TIMESTAMP) as HTMLElement)?.textContent?.trim() || '';
                        const tx = (el.querySelector(tSel.SEGMENT_LEGACY_TEXT) as HTMLElement)?.textContent?.trim() || '';
                        const parts = ts.split(':').map(Number);
                        let start = 0;
                        if (parts.length === 3) start = parts[0]*3600 + parts[1]*60 + parts[2];
                        else if (parts.length === 2) start = parts[0]*60 + parts[1];
                        return tx ? { text: tx, start, duration: 0 } : null;
                      }).filter(Boolean);
                      return segs;
                    }
                    return [];
                  },
                  args: [YT.TRANSCRIPT],
                });

                segments = (domResult?.result as any[]) || [];

                // Step 3c: Close transcript panel (sync cleanup)
                await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  world: 'MAIN' as any,
                  func: (tSel: { PANEL_CLOSE: readonly string[]; DESCRIPTION_COLLAPSE: string }) => {
                    const qf = (ss: readonly string[]) => { for (const s of ss) { const e = document.querySelector(s); if (e) return e; } return null; };
                    const cp = qf(tSel.PANEL_CLOSE) as HTMLElement;
                    if (cp) cp.click();
                    const col = document.querySelector(tSel.DESCRIPTION_COLLAPSE) as HTMLElement;
                    if (col) col.click();
                  },
                  args: [YT.TRANSCRIPT],
                }).catch(() => { /* ignore cleanup errors */ });
              }
            }

            // Step 4: Build VideoContent
            const chapters = prData.chapters.map((ch: any) => ({
              title: ch.title,
              startTime: ch.startMs / 1000,
              endTime: ch.nextStartMs === Infinity ? Infinity : ch.nextStartMs / 1000,
              segments: segments.filter((s: any) => {
                const startSec = ch.startMs / 1000;
                const endSec = ch.nextStartMs === Infinity ? Infinity : ch.nextStartMs / 1000;
                return s.start >= startSec && s.start < endSec;
              }),
            }));

            const content = {
              videoId: prData.videoId,
              title: prData.title,
              author: prData.author,
              platform: 'youtube' as const,
              transcript: segments,
              chapters: chapters.length > 0 ? chapters : undefined,
              duration: parseInt(prData.lengthSeconds, 10) || 0,
              language: bestTrack?.languageCode || 'unknown',
              url: tab.url,
              metadata: {
                publishDate: prData.publishDate,
                viewCount: parseInt(prData.viewCount, 10) || 0,
                tags: prData.keywords,
              },
            };

            if (segments.length > 0) {
              console.log(`[VideoLM] Extracted ${segments.length} segments for "${prData.title}"`);
            }

            sendResponse({ type: 'VIDEO_CONTENT', data: content });
          } catch (err) {
            sendResponse({ type: 'VIDEO_CONTENT', data: null, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_CONFIG': {
        configPromise.then((config) => {
          sendResponse({ type: 'CONFIG', data: config });
        });
        return true;
      }

      case 'GET_SETTINGS': {
        getSettings().then((settings) => {
          sendResponse({ type: 'SETTINGS', data: settings });
        });
        return true;
      }

      case 'GET_OBSIDIAN_SETTINGS': {
        getSettings().then((settings) => {
          sendResponse({ type: 'OBSIDIAN_SETTINGS', data: settings.obsidian });
        });
        return true;
      }

      case 'SAVE_SETTINGS': {
        saveUserPreferences(message.settings).then(() => {
          sendResponse({ success: true });
        });
        return true;
      }

      case 'REFRESH_ENTITLEMENT' as any: {
        (async () => {
          try {
            const entitlement = await reRegisterServerEntitlement();
            const settings = await getSettings();
            sendResponse({ success: true, entitlement, settings });
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_DIAGNOSTICS_BUNDLE' as any: {
        (async () => {
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const settings = await getSettings();
            const importStatus = await getImportStatus();
            const queue = await loadQueue();
            const extensionVersion = chrome.runtime.getManifest?.().version ?? 'unknown';
            const uiLanguage = chrome.i18n?.getUILanguage?.() ?? 'unknown';
            const bundle = buildDiagnosticsBundle({
              extensionVersion,
              uiLanguage,
              activeTab: {
                url: activeTab?.url,
                title: activeTab?.title,
              },
              pageType: (message as any).pageType || inferPageTypeFromUrl(activeTab?.url),
              settings,
              importStatus,
              pendingQueue: queue ? {
                hasPending: true,
                currentChunk: queue.currentChunk,
                totalChunks: queue.chunks.length,
                pageTitle: queue.pageTitle,
                remainingUrls: queue.totalUrls - queue.currentChunk * MAX_BATCH_SIZE,
              } : { hasPending: false },
            });
            sendResponse({ success: true, text: formatDiagnosticsBundle(bundle), bundle });
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'CHECK_DUPLICATE': {
        (async () => {
          try {
            const sources = await getSourceListFromNlmTab();
            const result = checkDuplicateByTitle(message.videoId, message.videoTitle, sources);
            sendResponse(result);
          } catch {
            sendResponse({ isDuplicate: false });
          }
        })();
        return true;
      }

      case 'PROCESS_AND_IMPORT': {
        // Store videoContent immediately (before import, so even dedup-blocked imports get stored)
        if (message.videoContent) {
          storeVideoContentForNlm(message.videoContent).catch(() => {});
        }
        processAndImport(message.videoContent, message.options, defaultProcessDeps()).then(async (result) => {
          sendResponse(result);
        });
        return true;
      }

      case 'QUICK_IMPORT': {
        (async () => {
          try {
            // Set toast tab to the active YouTube tab
            const [ytTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (ytTab?.id) setToastTab(ytTab.id);

            const rawVideoUrl = (message as any).videoUrl as string | string[];
            const videoTitle = (message as any).videoTitle as string | undefined;
            const urls = Array.isArray(rawVideoUrl) ? rawVideoUrl : [rawVideoUrl];

            await showToast({
              state: 'importing',
              text: t('toast_importing_video', [videoTitle || '']),
              progress: 50,
            });

            // Check merge strategy — auto-merge into matching notebook if set
            let targetNbId: string | undefined;
            let targetAuth: string | undefined;
            const qiSettings = await getSettings();
            if ((qiSettings.duplicateStrategy === 'merge' || qiSettings.duplicateStrategy === 'ask') && videoTitle) {
              const nlmCheckTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
              const qiAuthuser = nlmCheckTabs[0]?.url
                ? (() => { try { return new URL(nlmCheckTabs[0].url!).searchParams.get('authuser') || ''; } catch { return ''; } })()
                : '';
              const matches = findMatchingNotebooks(await listNlmNotebooks(qiAuthuser), videoTitle);
              if (matches.length > 0) {
                targetNbId = matches[0].id;
                targetAuth = qiAuthuser;
              }
            }

            // Store minimal videoContent for NLM copy button (before dedup — even
            // already-imported videos need videoContent for citation links)
            const minVC = buildMinimalVideoContent(urls[0], videoTitle || '');
            if (minVC) {
              storeVideoContentForNlm(minVC).catch(() => {});
            }

            // Store source record EARLY (before dedup) — even re-imports need the record
            for (const url of urls.filter(Boolean)) {
              const vid = extractVideoId(url);
              if (vid) {
                const record = createVideoSourceRecord(vid, videoTitle || '', '', url);
                await upsertSourceRecord(record);
                console.log(`[VideoLM] Stored source record: ${vid} "${videoTitle}"`);
              }
            }

            // Global dedup cache — catches duplicates regardless of notebook
            {
              const cacheCheck = await deduplicateAgainstCache(urls.filter(Boolean));
              if (cacheCheck.uniqueUrls.length === 0) {
                sendResponse({ success: true, message: `"${videoTitle || 'video'}" already imported` });
                await showToast({
                  state: 'success',
                  text: t('toast_video_already_imported'),
                  subtext: t('toast_already_imported_detail', [videoTitle || '']),
                  dismissAfter: 8000,
                  actionLabel: t('toast_reimport_btn'),
                  actionMessage: {
                    type: 'FORCE_REIMPORT',
                    urls: urls.filter(Boolean),
                    videoTitle: videoTitle || '',
                  },
                });
                return;
              }
            }

            // C-2 FIX: Send response immediately so popup doesn't freeze
            sendResponse({ success: true, importing: true, message: `Importing "${videoTitle || 'video'}"...` });

            const result = await importUrlsToNlm(
              urls.filter(Boolean),
              targetNbId,
              targetAuth,
              targetNbId ? undefined : videoTitle,
              async (pct, phase) => {
                await showToast({ state: 'importing', text: phase, progress: pct });
              },
            );

            // Post-import: refresh NLM tab + toast + notification
            if (result.success && result.notebookId) {
              await postImportActions(result.notebookId, result.authuser || '', urls.length, videoTitle || 'Video');
            } else if (!result.success) {
              await showToast({ state: 'error', text: t('toast_import_failed', [result.error || '']) });
            }
          } catch (err) {
            await showToast({ state: 'error', text: t('toast_import_failed', [String(err)]) });
          }
        })();
        return true;
      }

      case 'EXTRACT_VIDEO_URLS': {
        // Extract all video URLs visible on the current YouTube page.
        // Runs a MAIN-world script on the active tab to read the DOM.
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url) {
              sendResponse({ type: 'VIDEO_URLS_RESULT', urls: [], pageType: 'watch', pageTitle: '', totalVisible: 0, error: 'No active tab' });
              return;
            }

            const tabUrl = tab.url;

            // Run extraction in MAIN world (has access to YouTube DOM, no extension APIs)
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN' as any,
              func: (
                currentUrl: string,
                linkSel: { CHANNEL: string; PLAYLIST: string; SEARCH: string },
                adSel: { RENDERERS: string; PROMOTED_SLOT: string; BADGES: string; PATTERN: string },
                titleSel: { PLAYLIST_HEADER: string; CHANNEL_HEADER: string },
              ) => {
                // ---------- Detect page type ----------
                type PageType = 'watch' | 'playlist' | 'channel' | 'search';
                let pageType: PageType = 'watch';
                if (currentUrl.includes('/playlist?list=')) pageType = 'playlist';
                else if (currentUrl.includes('/results?')) pageType = 'search';
                else if (
                  currentUrl.includes('/@') ||
                  currentUrl.includes('/channel/') ||
                  currentUrl.includes('/c/') ||
                  currentUrl.includes('/user/')
                ) pageType = 'channel';
                else if (currentUrl.includes('/watch?')) pageType = 'watch';

                // ---------- Single watch page ----------
                if (pageType === 'watch') {
                  return {
                    rawUrls: [currentUrl],
                    pageType,
                    pageTitle: document.title.replace(/ - YouTube$/, '').trim(),
                    totalVisible: 1,
                  };
                }

                // ---------- Collect hrefs from the DOM ----------
                let selector = '';
                switch (pageType) {
                  case 'playlist': selector = linkSel.PLAYLIST; break;
                  case 'channel':  selector = linkSel.CHANNEL;  break;
                  case 'search':   selector = linkSel.SEARCH;   break;
                }

                const adRe = new RegExp(adSel.PATTERN, 'i');
                const links = document.querySelectorAll<HTMLAnchorElement>(selector);
                const rawUrls: string[] = [];
                links.forEach((a) => {
                  if (!a.href) return;
                  // Ad filtering — selectors from centralized config
                  const renderer = a.closest(adSel.RENDERERS);
                  if (renderer) {
                    if (renderer.hasAttribute('is-promoted')) return;
                    if (a.closest(adSel.PROMOTED_SLOT)) return;
                    const badgeText = renderer.querySelector(adSel.BADGES)?.textContent?.trim() || '';
                    if (adRe.test(badgeText)) return;
                  }
                  rawUrls.push(a.href);
                });

                // ---------- Page title ----------
                let pageTitle = '';
                switch (pageType) {
                  case 'playlist': {
                    const titleEl = document.querySelector(titleSel.PLAYLIST_HEADER);
                    pageTitle = titleEl?.textContent?.trim() || '';
                    break;
                  }
                  case 'channel': {
                    const nameEl = document.querySelector(titleSel.CHANNEL_HEADER);
                    pageTitle = nameEl?.textContent?.trim() || '';
                    break;
                  }
                  case 'search': {
                    try {
                      const sp = new URL(currentUrl).searchParams;
                      pageTitle = sp.get('search_query') || '';
                    } catch { pageTitle = ''; }
                    break;
                  }
                }

                if (!pageTitle) {
                  pageTitle = document.title.replace(/ - YouTube$/, '').trim();
                }

                return {
                  rawUrls,
                  pageType,
                  pageTitle,
                  totalVisible: rawUrls.length,
                };
              },
              args: [tabUrl, YT.LINKS, YT.AD, YT.TITLE],
            });

            const extraction = result?.result as {
              rawUrls: string[];
              pageType: string;
              pageTitle: string;
              totalVisible: number;
            } | null;

            if (!extraction) {
              sendResponse({ type: 'VIDEO_URLS_RESULT', urls: [], pageType: 'watch', pageTitle: '', totalVisible: 0, error: 'Extraction returned null' });
              return;
            }

            // Sanitize and deduplicate in the service worker (where we have imports)
            const sanitized = extraction.rawUrls
              .map((u) => sanitizeYouTubeUrl(u))
              .filter((u): u is string => u !== null);
            const urls = deduplicateUrls(sanitized);

            sendResponse({
              type: 'VIDEO_URLS_RESULT',
              urls,
              pageType: extraction.pageType,
              pageTitle: extraction.pageTitle,
              totalVisible: extraction.totalVisible,
            });
          } catch (err) {
            sendResponse({
              type: 'VIDEO_URLS_RESULT',
              urls: [],
              pageType: 'watch',
              pageTitle: '',
              totalVisible: 0,
              error: String(err),
            });
          }
        })();
        return true;
      }

      // -----------------------------------------------------------------------
      // Batch Import — split large URL sets into ≤50 URL chunks
      // -----------------------------------------------------------------------

      case 'BATCH_IMPORT': {
        (async () => {
          try {
            // Set toast tab to the active YouTube tab
            const [ytTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (ytTab?.id) setToastTab(ytTab.id);

            const { urls: rawUrls, pageTitle: rawPageTitle, source: importSource } = message as any;
            // 'button' = triggered from page button (no popup UI available)
            // 'popup'  = triggered from extension popup (can show NotebookChoice UI)
            // Fallback: if content script didn't extract a title, use a generic one
            const pageTitle = rawPageTitle || `YouTube Import (${rawUrls?.length || 0} videos)`;

            // Immediate toast — user sees feedback right away
            await showToast({
              state: 'importing',
              text: t('toast_processing_videos', [(rawUrls?.length || 0).toString()]),
              progress: 10,
            });
            if (!rawUrls || rawUrls.length === 0) {
              sendResponse({ success: false, error: t('error_no_urls') });
              return;
            }

            // GLOBAL DEDUP CACHE — primary mechanism (always works)
            const cacheResult = await deduplicateAgainstCache(rawUrls);
            let uniqueUrls = cacheResult.uniqueUrls;
            let dupeCount = cacheResult.skippedCount;

            // Also check NLM tab DOM as secondary dedup (if tab is open)
            const nbInfo = await getNlmNotebookInfo();
            if (nbInfo.existingUrls.length > 0) {
              const beforeDom = uniqueUrls.length;
              uniqueUrls = deduplicateAgainstExisting(uniqueUrls, nbInfo.existingUrls);
              dupeCount += beforeDom - uniqueUrls.length;
            }

            if (uniqueUrls.length === 0) {
              sendResponse({
                success: true,
                message: dupeCount > 0
                  ? t('toast_all_exist', [rawUrls.length.toString()])
                  : t('toast_no_new_videos'),
              });
              await showToast({
                state: 'success',
                text: dupeCount > 0 ? t('toast_all_exist', [rawUrls.length.toString()]) : t('toast_no_new_videos'),
              });
              return;
            }

            // Get authuser from NLM tab for multi-account support
            const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
            let authuser = '';
            if (nlmTabs[0]?.url) {
              try { authuser = new URL(nlmTabs[0].url).searchParams.get('authuser') || ''; } catch {}
            }

            // Check duplicate strategy BEFORE responding to popup
            const settings = await getSettings();
            const strategy = settings.duplicateStrategy || 'ask';

            if (strategy !== 'create') {
              const allNotebooks = await listNlmNotebooks(authuser);
              console.log(`[VideoLM] Dedup: strategy=${strategy}, pageTitle="${pageTitle}", notebooks=${allNotebooks.length}, names=[${allNotebooks.map(n => `"${n.name}"`).join(', ')}]`);
              const matches = findMatchingNotebooks(allNotebooks, pageTitle);
              console.log(`[VideoLM] Dedup: matches=${matches.length}${matches.length > 0 ? `, best="${matches[0].name}"` : ''}`);

              if (matches.length > 0) {
                const bestMatch = matches[0];

                // Source-level dedup: filter out URLs already in matched notebooks
                const { uniqueUrls: dedupedUrls, skippedCount: sourceSkipped } = deduplicateAgainstNotebooks(uniqueUrls, matches);
                let totalSkipped = dupeCount + sourceSkipped;
                console.log(`[VideoLM] Dedup result: input=${uniqueUrls.length}, afterDedup=${dedupedUrls.length}, sourceSkipped=${sourceSkipped}`);
                if (dedupedUrls.length > 0) {
                  // Log the remaining URLs that weren't deduped
                  console.log(`[VideoLM] Remaining URLs after dedup:`, dedupedUrls);
                }

                if (dedupedUrls.length === 0) {
                  sendResponse({ success: true, message: t('toast_all_exist_in_notebook', [rawUrls.length.toString(), bestMatch.name]) });
                  await showToast({
                    state: 'success',
                    text: t('toast_all_exist_in_notebook', [rawUrls.length.toString(), bestMatch.name]),
                  });
                  return;
                }

                // M-3 FIX: Removed dead filterValidYouTubeUrls code and invalidUrls var.
                // oEmbed validation disabled — revisit for Pro version.
                const validUrls = dedupedUrls;

                if (strategy === 'merge') {
                  const skipMsg = totalSkipped > 0 ? ` (${totalSkipped} duplicates skipped)` : '';
                  await showToast({
                    state: 'importing',
                    text: t('toast_importing_to_notebook', [validUrls.length.toString(), bestMatch.name]),
                    progress: 30,
                  });
                  sendResponse({
                    success: true, importing: true,
                    message: `Merging ${validUrls.length} new videos into "${bestMatch.name}"...${skipMsg}`,
                  });
                  await runAutoSplitImport(validUrls, pageTitle, bestMatch.sourceCount, 50, authuser, bestMatch.id);
                  return;
                }

                if (strategy === 'ask') {
                  if (importSource === 'button') {
                    // Page button has no popup UI — auto-merge into best match
                    // and show a toast so user knows which notebook was used.
                    await showToast({
                      state: 'importing',
                      text: t('toast_importing_to_notebook', [validUrls.length.toString(), bestMatch.name]),
                      progress: 30,
                    });
                    sendResponse({ success: true, importing: true });
                    await runAutoSplitImport(validUrls, pageTitle, bestMatch.sourceCount, 50, authuser, bestMatch.id);
                    return;
                  }
                  // Popup import — send choice back so popup shows NotebookChoice UI
                  sendResponse({
                    success: true,
                    needsUserChoice: true,
                    existingNotebook: bestMatch,
                    urls: validUrls,
                    pageTitle,
                    authuser,
                  });
                  return;
                }
              }
            }

            // Default: import directly (M-3 FIX: removed dead invalidUrls code)
            const defaultValidUrls = uniqueUrls;
            await showToast({
              state: 'importing',
              text: t('toast_importing_count', [defaultValidUrls.length.toString()]),
              progress: 30,
            });
            sendResponse({
              success: true, importing: true,
              message: t('msg_importing_background', [defaultValidUrls.length.toString()]),
            });
            // For create strategy (no match found), we auto-create a new notebook → existingCount=0
            await runAutoSplitImport(defaultValidUrls, pageTitle, 0, 50, authuser);

          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'BATCH_IMPORT_WITH_TARGET': {
        (async () => {
          try {
            const { urls, pageTitle, targetNotebookId, authuser, existingSourceCount } = message as any;
            console.log(`[VideoLM] BATCH_IMPORT_WITH_TARGET: urls=${urls?.length}, target=${targetNotebookId}, existing=${existingSourceCount}`);
            if (!urls?.length || !targetNotebookId) {
              sendResponse({ success: false, error: 'Missing target notebook or URLs.' });
              return;
            }

            const [ytTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (ytTab?.id) setToastTab(ytTab.id);

            sendResponse({ success: true, importing: true, message: 'Merging into existing notebook...' });

            await runAutoSplitImport(urls, pageTitle, existingSourceCount || 0, 50, authuser || '', targetNotebookId);
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_NOTEBOOK_CHOICE': {
        chrome.storage.local.get('videolm_notebook_choice', (result) => {
          sendResponse(result.videolm_notebook_choice || null);
        });
        return true;
      }

      case 'CLEAR_NOTEBOOK_CHOICE': {
        chrome.storage.local.remove('videolm_notebook_choice');
        sendResponse({ success: true });
        return true;
      }

      case 'RESUME_BATCH': {
        (async () => {
          try {
            const queue = await loadQueue();
            if (!queue) {
              sendResponse({ success: false, error: 'No pending batch to resume.' });
              return;
            }

            // NEW-2 FIX: Keep SW alive during resumed imports
            await startKeepAlive();
            const chunk = queue.chunks[queue.currentChunk];
            const result = await importUrlsToNlm(chunk);

            if (result.success) {
              const next = await advanceQueue();
              if (next) {
                sendResponse({
                  success: true,
                  needsNewNotebook: true,
                  message: `Batch ${queue.currentChunk + 1}/${queue.chunks.length} complete. Create "${queue.pageTitle} - Part ${queue.currentChunk + 2}" and continue.`,
                  remaining: next.totalUrls - (next.currentChunk * 50),
                });
              } else {
                await clearQueue();
                sendResponse({ success: true, message: 'All batches imported!' });
              }
            } else {
              sendResponse(result);
            }
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          } finally {
            await stopKeepAlive(); // NEW-2 FIX
          }
        })();
        return true;
      }

      case 'CHECK_PENDING_QUEUE': {
        (async () => {
          const queue = await loadQueue();
          sendResponse({
            hasPending: !!queue,
            currentChunk: queue?.currentChunk ?? null,
            totalChunks: queue?.chunks.length ?? null,
            pageTitle: queue?.pageTitle ?? null,
            remainingUrls: queue
              ? queue.totalUrls - queue.currentChunk * MAX_BATCH_SIZE
              : 0,
          });
        })();
        return true;
      }

      case 'GET_IMPORT_STATUS' as any: {
        getImportStatus().then(status => sendResponse(status));
        return true;
      }

      case 'CLEAR_IMPORT_STATUS' as any: {
        clearImportStatus().then(() => sendResponse({ ok: true }));
        return true;
      }

      case 'FORCE_REIMPORT' as any: {
        // User clicked "Re-import" on dedup toast — clear cache entry and re-import
        (async () => {
          try {
            const { urls: reimportUrls, videoTitle: reimportTitle } = message as any;
            if (!reimportUrls?.length) { sendResponse({ success: false }); return; }

            // Remove from dedup cache
            await removeFromDedupCache(reimportUrls);

            // Set toast tab
            const [ytTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (ytTab?.id) setToastTab(ytTab.id);

            await showToast({
              state: 'importing',
              text: t('toast_importing_video', [reimportTitle || '']),
              progress: 50,
            });

            // Re-run import (same as QUICK_IMPORT core logic)
            const result = await importUrlsToNlm(
              reimportUrls,
              undefined,
              undefined,
              reimportTitle || undefined,
              async (pct, phase) => {
                await showToast({ state: 'importing', text: phase, progress: pct });
              },
            );

            if (result.success && result.notebookId) {
              await postImportActions(result.notebookId, result.authuser || '', reimportUrls.length, reimportTitle || 'Video');
            } else if (!result.success) {
              await showToast({ state: 'error', text: t('toast_import_failed_short') });
            }
            sendResponse(result);
          } catch (err) {
            await showToast({ state: 'error', text: t('toast_import_failed_short') });
            sendResponse({ success: false, error: String(err) });
          }
        })();
        return true;
      }

      // -----------------------------------------------------------------
      // Notion Export (v0.3.0)
      // -----------------------------------------------------------------

      case 'NOTION_EXPORT': {
        // Static import — dynamic import() triggers Vite's modulePreload polyfill
        // which uses `document.createElement('link')`, crashing in Service Worker context.
        try {
          const { content, videoContent, options, citationHints } = message as any as {
            content: string;
            videoContent: VideoContent;
            options: NotionExportOptions;
            citationHints?: Array<{ id: number; href?: string }>;
          };
          const result = notionExport(content, videoContent, options, citationHints);
          sendResponse(result);
        } catch (err) {
          sendResponse({ markdown: '', citationsResolved: 0, citationsTotal: 0, error: String(err) });
        }
        break;
      }

      case 'STORE_VIDEO_CONTENT': {
        (async () => {
          try {
            const { videoContent } = message as any as { videoContent: VideoContent };
            await storeVideoContentForNlm(videoContent);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'STORE_SOURCE_RECORD': {
        (async () => {
          try {
            const { record } = message as any as { record: VideoSourceRecord };
            await upsertSourceRecord(record);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_SOURCE_INDEX': {
        (async () => {
          try {
            const index = await loadSourceIndex();
            sendResponse({ index });
          } catch (err) {
            sendResponse({ index: [], error: String(err) });
          }
        })();
        return true;
      }

      default:
        break;
    }

    return false;
  },
);

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('VideoLM extension installed');
  }
});
