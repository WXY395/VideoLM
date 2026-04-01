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
): Promise<{ success: boolean; items: Array<{ title: string; content: string }>; error?: string }> {
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
    if (!nlmTabs[0]?.id) return { count: 0, limit: 50, existingUrls: [] };

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
async function importUrlsToNlm(urls: string[]): Promise<{
  success: boolean;
  error?: string;
  urlCount: number;
  message?: string;
  clipboardText?: string;
}> {
  const urlCount = urls.length;

  if (urls.length === 0 || urls.every(u => !u)) {
    return { success: false, error: 'No URLs provided.', urlCount: 0 };
  }

  // Find an open NotebookLM tab in a notebook
  const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });

  if (nlmTabs.length === 0 || !nlmTabs[0].id) {
    await chrome.tabs.create({ url: 'https://notebooklm.google.com/', active: true });
    return {
      success: false, clipboardText: urls.join('\n'), urlCount,
      error: 'Please open a notebook in NotebookLM first, then try again.',
    };
  }

  const nlmTabId = nlmTabs[0].id;
  const nlmUrl = nlmTabs[0].url || '';

  if (!nlmUrl.includes('/notebook/')) {
    await chrome.tabs.update(nlmTabId, { active: true });
    return {
      success: false, clipboardText: urls.join('\n'), urlCount,
      error: 'Please open a specific notebook in NotebookLM, then try again.',
    };
  }

  // Extract notebook ID from URL: /notebook/UUID
  const nbMatch = nlmUrl.match(/\/notebook\/([a-f0-9-]+)/);
  const notebookId = nbMatch ? nbMatch[1] : '';

  if (!notebookId) {
    return { success: false, urlCount, error: 'Cannot extract notebook ID from URL.' };
  }

  // Execute in MAIN world to access NLM's session data and make API calls
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: nlmTabId },
    world: 'MAIN' as any,
    func: async (videoUrls: string[], nbId: string) => {
      try {
        // Extract session parameters from NLM page
        // f.sid: from WIZ_global_data.FdrFJe or page scripts
        // at: CSRF token from WIZ_global_data.SNlM0e
        // bl: build label from WIZ_global_data.cfb2h
        const wizData = (window as any).WIZ_global_data || {};
        const fSid = wizData.FdrFJe || '';
        const atToken = wizData.SNlM0e || '';
        const bl = wizData.cfb2h || '';

        if (!atToken) {
          return { success: false, error: 'Cannot read NLM session token. Try refreshing the NotebookLM page.' };
        }

        // Get authuser from URL or cookies
        const urlParams = new URLSearchParams(window.location.search);
        let authuser = urlParams.get('authuser') || '0';
        // Also try from the page's cookie
        if (authuser === '0') {
          const match = document.cookie.match(/authuser=(\d+)/);
          if (match) authuser = match[1];
        }

        const sourcePath = `/notebook/${nbId}`;
        const lang = document.documentElement.lang || 'en';

        // Helper: send one izAoDd request for a single URL
        async function addSource(videoUrl: string): Promise<boolean> {
          const innerPayload = JSON.stringify([
            [[null, null, null, null, null, null, null, [videoUrl], null, null, 1]],
            nbId,
            [2],
            [1, null, null, null, null, null, null, null, null, [1]],
          ]);
          const fReq = JSON.stringify([[['izAoDd', innerPayload, null, 'generic']]]);
          const reqId = Math.floor(100000 + Math.random() * 900000);

          const qp = new URLSearchParams({
            'rpcids': 'izAoDd', 'source-path': sourcePath, 'bl': bl,
            'f.sid': fSid, 'hl': lang, 'authuser': authuser,
            '_reqid': String(reqId), 'rt': 'c',
          });
          const body = new URLSearchParams({ 'f.req': fReq, 'at': atToken });

          const resp = await fetch(
            `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${qp}`,
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, credentials: 'include', body: body.toString() }
          );
          return resp.ok;
        }

        // Send requests in parallel batches of CONCURRENCY
        // This is ~5x faster than sequential while being respectful to NLM
        const CONCURRENCY = 5;
        let successCount = 0;
        let lastError = '';
        const validUrls = videoUrls.filter(Boolean);

        for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
          const batch = validUrls.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map(u => addSource(u)));

          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) successCount++;
            else if (r.status === 'rejected') lastError = r.reason?.message || String(r.reason);
            else lastError = 'Request failed';
          }

          // Update badge with progress (visible even when popup is closed)
          try {
            chrome.action.setBadgeText({ text: `${successCount}/${validUrls.length}` });
            chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
          } catch { /* badge API may not be available */ }

          // Brief pause between parallel batches
          if (i + CONCURRENCY < validUrls.length) {
            await new Promise(r => setTimeout(r, 300));
          }
        }

        if (successCount === 0) {
          return { success: false, error: lastError || 'All API calls failed.' };
        }

        return {
          success: true,
          successCount,
          total: videoUrls.length,
          failCount: videoUrls.length - successCount,
        };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    },
    args: [urls, notebookId],
  });

  const importResult = result?.result as any;

  // Clear badge on completion (show ✓ briefly)
  try {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#34a853' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 8000);
  } catch { /* ignore */ }

  if (importResult?.success) {
    await incrementUsage('imports');
    const { successCount, failCount } = importResult;
    let msg = successCount === 1
      ? 'YouTube video added to your NotebookLM notebook!'
      : `Added ${successCount} videos to your NotebookLM notebook!`;
    if (failCount > 0) {
      msg += ` (${failCount} failed)`;
    }
    return { success: true, message: msg, urlCount: successCount };
  } else {
    return {
      success: false, clipboardText: urls.join('\n'), urlCount,
      error: importResult?.error || 'API import failed.',
    };
  }
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
            const rawVideoUrl = (message as any).videoUrl as string | string[];
            const urls = Array.isArray(rawVideoUrl) ? rawVideoUrl : [rawVideoUrl];
            sendResponse(await importUrlsToNlm(urls.filter(Boolean)));
          } catch (err) {
            sendResponse({ success: false, urlCount: 0, error: String(err) });
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
            const { urls: rawUrls, pageTitle } = message as any;
            if (!rawUrls || rawUrls.length === 0) {
              sendResponse({ success: false, error: 'No URLs provided.' });
              return;
            }

            // Step 1: Get notebook capacity + existing URLs for deduplication
            const nbInfo = await getNlmNotebookInfo();
            const availableSlots = Math.max(0, nbInfo.limit - nbInfo.count);

            // Step 2: Deduplicate — remove URLs already in the notebook
            const uniqueUrls = deduplicateAgainstExisting(rawUrls, nbInfo.existingUrls);
            const removedDupes = rawUrls.length - uniqueUrls.length;

            if (uniqueUrls.length === 0) {
              sendResponse({
                success: true,
                message: removedDupes > 0
                  ? `All ${rawUrls.length} videos are already in this notebook. Nothing to import.`
                  : 'No new videos to import.',
              });
              return;
            }

            if (availableSlots === 0) {
              sendResponse({
                success: false,
                error: `This notebook is full (${nbInfo.count}/${nbInfo.limit} sources). Please create a new notebook first.`,
              });
              return;
            }

            // Step 3: Split into what fits now vs what needs a new notebook
            const firstBatchSize = Math.min(uniqueUrls.length, availableSlots);
            const firstBatch = uniqueUrls.slice(0, firstBatchSize);
            const remaining = uniqueUrls.slice(firstBatchSize);

            // Step 4: Set import status + import first batch
            await setImportStatus({
              active: true,
              pageTitle,
              totalUrls: uniqueUrls.length,
              importedCount: 0,
              phase: `Importing ${firstBatchSize} videos...`,
              startedAt: Date.now(),
            });

            // Respond immediately so popup can show progress
            sendResponse({ success: true, message: `Importing ${firstBatchSize} videos...`, importing: true });

            // Do the actual import (popup may be closed by now, that's OK)
            const result = await importUrlsToNlm(firstBatch);

            if (!result.success) {
              await setImportStatus({
                active: false, pageTitle, totalUrls: uniqueUrls.length,
                importedCount: 0, phase: 'Failed', startedAt: Date.now(),
                lastError: result.error, completed: true,
              });
              return;
            }

            const dupeMsg = removedDupes > 0 ? ` (${removedDupes} duplicates skipped)` : '';

            if (remaining.length === 0) {
              await setImportStatus({
                active: false, pageTitle, totalUrls: uniqueUrls.length,
                importedCount: firstBatchSize, phase: 'Done', startedAt: Date.now(),
                completed: true,
                completionMessage: `Added ${firstBatchSize} videos!${dupeMsg}`,
              });
              return;
            }

            // Step 5: Save remaining to queue + update status
            const queue = createBatchQueue(remaining, pageTitle);
            await saveQueue(queue);

            await setImportStatus({
              active: false, pageTitle, totalUrls: uniqueUrls.length,
              importedCount: firstBatchSize, phase: 'Waiting for new notebook', startedAt: Date.now(),
              completed: true, needsNewNotebook: true, remainingCount: remaining.length,
              completionMessage: `Added ${firstBatchSize} videos.${dupeMsg} ${remaining.length} remaining — create "${pageTitle} - Part 2" and click Resume.`,
            });
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })();
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

      case 'IMPORT_TO_NLM': {
        sendResponse({
          type: 'IMPORT_RESULT',
          result: { success: false, error: 'Not yet implemented', tier: 1 as const },
        });
        break;
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
