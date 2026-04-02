import type { MessageType, VideoContent, ImportOptions, ImportMode } from '@/types';
import { getConfig } from '@/config/dynamic-config';
import { resolveProvider } from '@/ai/provider-manager';
import { formatTranscript, extractVideoId, parseXMLCaptions } from '@/extractors/youtube-extractor';
import { addMetadataHeader, type MetadataInput } from '@/processing/rag-optimizer';
import { checkDuplicateByTitle } from '@/processing/duplicate-detector';
import { getSettings, saveSettings, incrementUsage, checkQuota } from './usage-tracker';
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
import { listNlmNotebooks, findMatchingNotebooks, clearNotebookCache, type NlmNotebook } from './nlm-api';

// ---------------------------------------------------------------------------
// Pre-load config on service worker startup
// ---------------------------------------------------------------------------

let configPromise = getConfig();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMeta(video: VideoContent): MetadataInput {
  return {
    title: video.title,
    author: video.author,
    platform: video.platform,
    publishDate: video.metadata.publishDate,
    duration: video.duration,
    url: video.url,
  };
}

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
 * Process video content according to import mode and return formatted items.
 */
async function processAndImport(
  videoContent: VideoContent,
  options: ImportOptions,
): Promise<{ success: boolean; items: Array<{ title: string; content: string }>; error?: string; clipboardText?: string; message?: string }> {
  // 1. Check quota
  const settings = await getSettings();
  const quota = checkQuota(settings);

  if (!quota.canImport) {
    return { success: false, items: [], error: 'Monthly import quota exceeded.' };
  }

  const needsAI = options.mode !== 'raw';
  if (needsAI && !quota.canUseAI) {
    return {
      success: false,
      items: [],
      error: 'AI processing requires a BYOK API key or VideoLM Pro.',
    };
  }

  // 2. Resolve AI provider
  const provider = resolveProvider(settings);

  // 3. Format raw transcript
  const rawText = formatTranscript(videoContent.transcript, { timestamps: true });
  const meta = buildMeta(videoContent);

  let items: Array<{ title: string; content: string }> = [];

  try {
    switch (options.mode) {
      case 'raw': {
        const content = addMetadataHeader(rawText, meta);
        items = [{ title: videoContent.title, content }];
        break;
      }

      case 'structured':
      case 'summary': {
        const processed = await provider.summarize(rawText, videoContent.title, options.mode);
        if (needsAI) await incrementUsage('aiCalls');
        const content = addMetadataHeader(processed, meta);
        items = [{ title: videoContent.title, content }];
        break;
      }

      case 'chapters': {
        // Use YouTube chapters if available, otherwise AI-generated
        let chapters = videoContent.chapters ?? [];

        if (chapters.length === 0) {
          chapters = await provider.splitChapters(rawText);
          if (needsAI) await incrementUsage('aiCalls');
        }

        if (chapters.length === 0) {
          // Fallback: treat as single item
          const content = addMetadataHeader(rawText, meta);
          items = [{ title: videoContent.title, content }];
        } else {
          items = chapters.map((ch) => {
            const chapterText = ch.segments.length > 0
              ? formatTranscript(ch.segments, { timestamps: true })
              : rawText; // fallback if segments are empty
            const chapterMeta = { ...meta, title: `${videoContent.title} — ${ch.title}` };
            const content = addMetadataHeader(chapterText, chapterMeta);
            return { title: ch.title, content };
          });
        }
        break;
      }
    }

    // 5. Translate if requested
    if (options.translate) {
      for (let i = 0; i < items.length; i++) {
        items[i].content = await provider.translate(items[i].content, options.translate);
        await incrementUsage('aiCalls');
      }
    }

    // 6. Increment import usage
    await incrementUsage('imports');

    // 7. Copy to clipboard (Tier 3 — always works)
    // Combine all items into a single text for clipboard
    const clipboardText = items
      .map((item) => item.content)
      .join('\n\n---\n\n');

    // Use offscreen document to write to clipboard from service worker
    // (Service workers don't have navigator.clipboard)
    // For now, send the text back to the popup to handle clipboard
    return {
      success: true,
      items,
      clipboardText,
      message: items.length === 1
        ? `Processed "${items[0].title}". Content copied to clipboard — paste into NotebookLM as a "Copied text" source.`
        : `Processed ${items.length} items. Content copied to clipboard — paste into NotebookLM as a "Copied text" source.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, items: [], error: message };
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

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: nlmTabs[0].id },
      world: 'MAIN' as any,
      func: () => {
        let count = 0;
        let limit = 50; // Default free tier

        // Method 1: Read "X 個來源" or "X sources" text in sidebar header
        const sourceHeaders = document.querySelectorAll('[class*="source"]');
        for (const el of sourceHeaders) {
          const text = el.textContent || '';
          // Match "50 個來源" or "50 sources" or "X/50"
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
          const sourceItems = document.querySelectorAll(
            'a[href*="youtube.com/watch"], a[href*="youtu.be"], [class*="source-item"], [class*="source-container"]'
          );
          count = sourceItems.length;
        }

        // Method 3: Check for "已達上限" (limit reached) warning
        const bodyText = document.body.innerText;
        if (bodyText.includes('已達上限') || bodyText.includes('limit reached')) {
          // If limit warning visible, notebook is full
          // Try to read the actual count from nearby text
          const limitMatch = bodyText.match(/(\d+)\s*\/\s*(\d+)/);
          if (limitMatch) {
            count = parseInt(limitMatch[1], 10);
            limit = parseInt(limitMatch[2], 10);
          } else {
            count = 50; // Assume full at default limit
          }
        }

        // Collect existing YouTube URLs for deduplication
        const existingUrls: string[] = [];
        const allLinks = document.querySelectorAll('a[href*="youtube.com/watch"], a[href*="youtu.be"]');
        allLinks.forEach(a => {
          const href = a.getAttribute('href');
          if (href) existingUrls.push(href);
        });

        // Also check source text content for YouTube URLs
        const sourceElements = document.querySelectorAll('[class*="source"]');
        sourceElements.forEach(el => {
          const text = el.textContent || '';
          const urlMatch = text.match(/youtube\.com\/watch\?v=[\w-]+/g);
          if (urlMatch) urlMatch.forEach(u => existingUrls.push('https://www.' + u));
        });

        return { count, limit, existingUrls };
      },
      args: [],
    });

    return (result?.result as any) || { count: 0, limit: 50, existingUrls: [] };
  } catch {
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

  // Batch check in parallel (max 10 concurrent)
  const CONCURRENCY = 10;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const resp = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
          );
          return { url, ok: resp.ok };
        } catch {
          return { url, ok: false };
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
async function importUrlsToNlm(urls: string[], targetNotebookId?: string, targetAuthuser?: string, autoCreateTitle?: string): Promise<{
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
    return { success: false, error: 'No URLs provided.', urlCount: 0 };
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
      // Wait for NLM to register the notebook
      await new Promise(r => setTimeout(r, 3000));
    } else {
      return { success: false, urlCount, error: 'Could not auto-create notebook. Please open NotebookLM and try again.' };
    }
  }

  if (!notebookId) {
    return { success: false, urlCount, error: 'No notebook found. Please open NotebookLM or try again.' };
  }

  // ═══════════════════════════════════════════════════════════════
  // Direct API approach — same as competitor (200K+ users)
  // Fetch NLM homepage to get session tokens, then POST batchexecute
  // directly from the service worker. No executeScript needed!
  // ═══════════════════════════════════════════════════════════════

  // Get authuser — may have been set from NLM tab URL above, or passed as targetAuthuser
  const authuserParam = authuser ? `?authuser=${authuser}&pageId=none` : '';
  console.log(`[VideoLM] importUrlsToNlm: notebookId=${notebookId}, authuser=${authuser}, urls=${urls.length}`);

  // Step 1: Fetch NLM homepage to get fresh session tokens (bl, at)
  let bl = '';
  let atToken = '';

  try {
    const homepageResp = await fetch(
      `https://notebooklm.google.com/${authuserParam}`,
      { redirect: 'error' }
    );
    if (!homepageResp.ok) {
      return { success: false, urlCount, error: 'Cannot connect to NotebookLM. Please check your login.' };
    }
    const html = await homepageResp.text();

    // Extract tokens from HTML (same regex as competitor)
    const blMatch = html.match(/"cfb2h":"([^"]+)"/);
    const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
    bl = blMatch ? blMatch[1] : '';
    atToken = atMatch ? atMatch[1] : '';
  } catch (e) {
    return { success: false, urlCount, error: 'Cannot reach NotebookLM. Please check your login.' };
  }

  if (!bl || !atToken) {
    return { success: false, urlCount, error: 'Cannot read NLM session tokens. Please refresh NotebookLM.' };
  }

  // Step 2: Build sources array — ALL URLs in one API call (like competitor)
  const validUrls = urls.filter(Boolean);
  const sources = validUrls.map(url =>
    url.includes('youtube.com')
      ? [null, null, null, null, null, null, null, [url]]   // YouTube URL
      : [null, null, [url]]                                  // Website URL
  );

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
    await incrementUsage('imports', totalSuccess);
    const failCount = validUrls.length - totalSuccess;
    let msg = totalSuccess === 1
      ? 'YouTube video added to your NotebookLM notebook!'
      : `Added ${totalSuccess} videos to your NotebookLM notebook!`;
    if (failCount > 0) msg += ` (${failCount} failed)`;
    return { success: true, message: msg, urlCount: totalSuccess, notebookId, authuser };
  } else {
    return {
      success: false, clipboardText: urls.join('\n'), urlCount,
      error: lastError || 'API import failed.', notebookId, authuser,
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
  // Direct fetch from service worker — same pattern as importUrlsToNlm
  // No executeScript needed!
  try {
    const authuserParam = authuser ? `?authuser=${authuser}&pageId=none` : '';

    // Get fresh session tokens
    const homepageResp = await fetch(
      `https://notebooklm.google.com/${authuserParam}`,
      { redirect: 'error' }
    );
    if (!homepageResp.ok) return null;

    const html = await homepageResp.text();
    const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1] || '';
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1] || '';
    if (!bl || !atToken) return null;

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
    const uuidMatch = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const nbId = uuidMatch ? uuidMatch[1] : null;
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
  // Refresh or open NLM tab so user sees the new sources
  try {
    const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    if (nlmTabs[0]?.id) {
      // NLM tab exists — navigate it to the notebook (or reload if already there)
      const currentUrl = nlmTabs[0].url || '';
      if (currentUrl.includes(`/notebook/${notebookId}`)) {
        await chrome.tabs.reload(nlmTabs[0].id);
      } else {
        const qs = authuser ? `?authuser=${authuser}` : '';
        await chrome.tabs.update(nlmTabs[0].id, {
          url: `https://notebooklm.google.com/notebook/${notebookId}${qs}`,
        });
      }
      console.log('[VideoLM] Refreshed/navigated NLM tab');
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
      ? `"${pageTitle}" 已匯入！`
      : `已匯入 ${totalImported} 個影片 — "${pageTitle}"`,
    subtext: totalImported === 1
      ? `"${pageTitle}" imported!`
      : `${totalImported} videos from "${pageTitle}" imported!`,
    viewUrl: nbUrl,
    dismissAfter: 8000,
  });

  // Also show system notification as backup (may be blocked by OS)
  try {
    // Use 48px icon — MV3 service workers sometimes fail to load larger icons
    chrome.notifications.create('videolm-import-done', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: 'VideoLM Import Complete',
      message: totalImported === 1
        ? `"${pageTitle}" imported!`
        : `${totalImported} videos from "${pageTitle}" imported!`,
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
      text: `正在匯入 ${firstBatch.length} 個影片...`,
      subtext: `Importing ${firstBatch.length} videos from "${pageTitle}"...`,
      progress: 0,
    });

    const firstResult = await importUrlsToNlm(
      firstBatch,
      targetNotebookId || undefined,
      targetNotebookId ? authuser : undefined,
      targetNotebookId ? undefined : pageTitle,  // Only auto-create if no target
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
        text: `匯入失敗：${firstResult.error || '未知錯誤'}`,
        subtext: `Import failed: ${firstResult.error || 'Unknown error'}`,
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
    let targetNbId = '';
    let partExistingCount = 0;
    clearNotebookCache();  // Force fresh lookup after previous import/creation
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
        text: `正在合併至 Part ${partNumber}... (${totalImported}/${urls.length})`,
        subtext: `Merging into Part ${partNumber}... (${totalImported}/${urls.length})`,
        progress: pct,
      });

      const chunkResult = await importUrlsToNlm(chunk, targetNbId, authuser);
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
      text: `正在建立 Part ${partNumber}... (${totalImported}/${urls.length})`,
      subtext: `Creating Part ${partNumber}... (${totalImported}/${urls.length})`,
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

    console.log(`[VideoLM] Waiting 3s for notebook ${newNbId} to be ready...`);
    await new Promise(r => setTimeout(r, 3000));

    await setImportStatus({
      active: true, pageTitle, totalUrls: urls.length,
      importedCount: totalImported,
      phase: `Importing ${chunk.length} to "${partTitle}"...`,
      startedAt: Date.now(),
    });
    await showToast({
      state: 'importing',
      text: `正在匯入至 Part ${partNumber}... (${totalImported}/${urls.length})`,
      subtext: `Importing to Part ${partNumber}... (${totalImported}/${urls.length})`,
      progress: Math.round((totalImported / urls.length) * 100),
    });

    const chunkResult = await importUrlsToNlm(chunk, newNbId, authuser);
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
              func: (expectedId: string) => {
                // Try player API first (always current after SPA nav)
                let pr: any = null;
                try {
                  const player = document.querySelector('#movie_player') as any;
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
              args: [expectedVideoId || ''],
            });

            let prData = prResult?.result;

            // Retry if player wasn't ready yet (SPA nav in progress)
            if (!prData && expectedVideoId) {
              await new Promise(r => setTimeout(r, 1500));
              const [retry] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN' as any,
                func: () => {
                  let pr: any = null;
                  try {
                    const player = document.querySelector('#movie_player') as any;
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
                args: [],
              });
              prData = retry?.result;
            }

            if (!prData) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: 'Could not read video data. Try refreshing.' });
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
            if (segments.length === 0 && prData.captionTracks.length > 0) {
              const [domResult] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN' as any,
                func: async () => {
                  // Close any stale transcript panel first
                  const existingPanel = document.querySelector(
                    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"],' +
                    'ytd-engagement-panel-section-list-renderer[target-id*="transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
                  );
                  if (existingPanel) {
                    const cb = existingPanel.querySelector('#header button') as HTMLElement;
                    if (cb) { cb.click(); await new Promise(r => setTimeout(r, 500)); }
                  }

                  // Expand description
                  const expand = document.querySelector('#expand') as HTMLElement;
                  if (expand) { expand.click(); await new Promise(r => setTimeout(r, 500)); }

                  // Click transcript button
                  const labels = ['轉錄稿','转录稿','字幕記錄','字幕记录','transcript','Transcript','文字起こし'];
                  let clicked = false;
                  const btns = document.querySelectorAll('#description button, ytd-video-description-transcript-section-renderer button');
                  for (const btn of btns) {
                    const t = btn.textContent?.trim() || '';
                    if (labels.some(l => t.includes(l))) { (btn as HTMLElement).click(); clicked = true; break; }
                  }
                  if (!clicked) {
                    const col = document.querySelector('#collapse') as HTMLElement;
                    if (col) col.click();
                    return [];
                  }

                  // Wait for segments to stabilize
                  const SELS = ['transcript-segment-view-model', 'ytd-transcript-segment-renderer'];
                  let lastCount = 0, stableAt = 0;
                  for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 400));
                    let count = 0;
                    for (const s of SELS) count += document.querySelectorAll(s).length;
                    if (count > 0 && count === lastCount) {
                      if (!stableAt) stableAt = Date.now();
                      else if (Date.now() - stableAt > 500) break;
                    } else { lastCount = count; stableAt = 0; }
                  }

                  // Read segments — modern format
                  const modern = document.querySelectorAll('transcript-segment-view-model');
                  if (modern.length > 0) {
                    const segs = [...modern].map(el => {
                      const ts = (el.querySelector('.ytwTranscriptSegmentViewModelTimestamp') as HTMLElement)?.textContent?.trim() || '';
                      const tx = (el.querySelector('span.yt-core-attributed-string') as HTMLElement)?.textContent?.trim() || '';
                      const parts = ts.split(':').map(Number);
                      let start = 0;
                      if (parts.length === 3) start = parts[0]*3600 + parts[1]*60 + parts[2];
                      else if (parts.length === 2) start = parts[0]*60 + parts[1];
                      return tx ? { text: tx, start, duration: 0 } : null;
                    }).filter(Boolean);

                    // Close panel + collapse description
                    const cp = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"] #header button') as HTMLElement;
                    if (cp) cp.click();
                    await new Promise(r => setTimeout(r, 100));
                    const col = document.querySelector('#collapse') as HTMLElement;
                    if (col) col.click();

                    return segs;
                  }

                  // Read segments — legacy format
                  const legacy = document.querySelectorAll('ytd-transcript-segment-renderer');
                  if (legacy.length > 0) {
                    const segs = [...legacy].map(el => {
                      const ts = (el.querySelector('.segment-timestamp') as HTMLElement)?.textContent?.trim() || '';
                      const tx = (el.querySelector('.segment-text') as HTMLElement)?.textContent?.trim() || '';
                      const parts = ts.split(':').map(Number);
                      let start = 0;
                      if (parts.length === 3) start = parts[0]*3600 + parts[1]*60 + parts[2];
                      else if (parts.length === 2) start = parts[0]*60 + parts[1];
                      return tx ? { text: tx, start, duration: 0 } : null;
                    }).filter(Boolean);

                    const cp = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #header button') as HTMLElement;
                    if (cp) cp.click();
                    await new Promise(r => setTimeout(r, 100));
                    const col = document.querySelector('#collapse') as HTMLElement;
                    if (col) col.click();

                    return segs;
                  }

                  return [];
                },
                args: [],
              });

              segments = (domResult?.result as any[]) || [];
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

      case 'SAVE_SETTINGS': {
        saveSettings(message.settings).then(() => {
          sendResponse({ success: true });
        });
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
        processAndImport(message.videoContent, message.options).then((result) => {
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
              text: `正在匯入「${videoTitle || '影片'}」...`,
              subtext: `Importing "${videoTitle || 'video'}"...`,
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

            const result = await importUrlsToNlm(
              urls.filter(Boolean),
              targetNbId,
              targetAuth,
              targetNbId ? undefined : videoTitle,
            );
            sendResponse(result);

            // Post-import: refresh NLM tab + toast + notification
            if (result.success && result.notebookId) {
              await postImportActions(result.notebookId, result.authuser || '', urls.length, videoTitle || 'Video');
            } else if (!result.success) {
              await showToast({ state: 'error', text: `匯入失敗`, subtext: result.error || 'Import failed' });
            }
          } catch (err) {
            sendResponse({ success: false, urlCount: 0, error: String(err) });
            await showToast({ state: 'error', text: `匯入失敗`, subtext: String(err) });
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
              func: (currentUrl: string) => {
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
                  case 'playlist':
                    selector = 'ytd-playlist-video-renderer a#video-title';
                    break;
                  case 'channel':
                    // Channel pages: /videos, /featured, /streams, homepage
                    // Multiple renderers depending on the sub-page layout
                    selector = 'ytd-rich-item-renderer a#video-title-link, ytd-grid-video-renderer a#video-title, ytd-video-renderer a#video-title, ytd-compact-video-renderer a.yt-simple-endpoint';
                    break;
                  case 'search':
                    selector = 'ytd-video-renderer a#video-title';
                    break;
                }

                const links = document.querySelectorAll<HTMLAnchorElement>(selector);
                const rawUrls: string[] = [];
                links.forEach((a) => {
                  const href = a.href;
                  if (href) rawUrls.push(href);
                });

                // ---------- Page title ----------
                let pageTitle = '';
                switch (pageType) {
                  case 'playlist': {
                    const titleEl = document.querySelector(
                      'yt-formatted-string.ytd-playlist-header-renderer, h1 yt-formatted-string',
                    );
                    pageTitle = titleEl?.textContent?.trim() || '';
                    break;
                  }
                  case 'channel': {
                    const nameEl = document.querySelector(
                      'ytd-channel-name yt-formatted-string, #channel-name yt-formatted-string',
                    );
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
              args: [tabUrl],
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

            const { urls: rawUrls, pageTitle } = message as any;
            if (!rawUrls || rawUrls.length === 0) {
              sendResponse({ success: false, error: 'No URLs provided.' });
              return;
            }

            // Deduplicate against existing notebook sources
            const nbInfo = await getNlmNotebookInfo();
            const uniqueUrls = deduplicateAgainstExisting(rawUrls, nbInfo.existingUrls);
            const dupeCount = rawUrls.length - uniqueUrls.length;

            if (uniqueUrls.length === 0) {
              sendResponse({
                success: true,
                message: dupeCount > 0
                  ? `All ${rawUrls.length} videos are already in this notebook.`
                  : 'No new videos to import.',
              });
              await showToast({
                state: 'success',
                text: dupeCount > 0 ? `全部 ${rawUrls.length} 個影片已存在於筆記本中` : '沒有新影片需要匯入',
                subtext: dupeCount > 0 ? `All ${rawUrls.length} videos are already in this notebook` : 'No new videos to import',
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
                  const nbLabel = matches.length > 1 ? '等相關筆記本' : '';
                  sendResponse({ success: true, message: `All ${rawUrls.length} videos already exist in "${bestMatch.name}".` });
                  await showToast({
                    state: 'success',
                    text: `全部 ${rawUrls.length} 個影片已存在於「${bestMatch.name}」${nbLabel}中`,
                    subtext: `All ${rawUrls.length} videos already exist in "${bestMatch.name}"`,
                  });
                  return;
                }

                // Validate URLs — filter out deleted/private videos
                await showToast({
                  state: 'importing',
                  text: `正在驗證 ${dedupedUrls.length} 個新網址...`,
                  subtext: `Validating ${dedupedUrls.length} new URLs...`,
                  progress: 50,
                });
                const { valid: validUrls, invalid: invalidUrls } = await filterValidYouTubeUrls(dedupedUrls);
                totalSkipped += invalidUrls.length;

                if (validUrls.length === 0) {
                  sendResponse({ success: true, message: `No valid new videos. ${sourceSkipped} duplicates, ${invalidUrls.length} unavailable skipped.` });
                  await showToast({
                    state: 'success',
                    text: `沒有可匯入的新影片（${sourceSkipped} 重複、${invalidUrls.length} 無效）`,
                    subtext: `No valid new videos. ${sourceSkipped} duplicates, ${invalidUrls.length} unavailable skipped.`,
                  });
                  return;
                }

                if (strategy === 'merge') {
                  const skipMsg = totalSkipped > 0 ? ` (${sourceSkipped} duplicates, ${invalidUrls.length} unavailable skipped)` : '';
                  sendResponse({
                    success: true, importing: true,
                    message: `Merging ${validUrls.length} new videos into "${bestMatch.name}"...${skipMsg}`,
                  });
                  await runAutoSplitImport(validUrls, pageTitle, bestMatch.sourceCount, 50, authuser, bestMatch.id);
                  return;
                }

                if (strategy === 'ask') {
                  // Send choice back to popup — popup shows NotebookChoice UI
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

            // Default: validate URLs then import in background
            const { valid: defaultValidUrls, invalid: defaultInvalidUrls } = await filterValidYouTubeUrls(uniqueUrls);
            const totalSkippedDefault = dupeCount + defaultInvalidUrls.length;
            if (defaultValidUrls.length === 0) {
              sendResponse({ success: true, message: `No valid videos to import.` });
              await showToast({
                state: 'success',
                text: `沒有可匯入的影片（${defaultInvalidUrls.length} 個無效）`,
                subtext: `No valid videos to import. ${defaultInvalidUrls.length} unavailable skipped.`,
              });
              return;
            }
            const skipMsg = totalSkippedDefault > 0 ? ` (${totalSkippedDefault} skipped)` : '';
            sendResponse({
              success: true, importing: true,
              message: `Importing ${defaultValidUrls.length} videos in background...${skipMsg} You can close this popup.`,
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
