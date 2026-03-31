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
 * Get the current source count from the open NLM notebook.
 * Reads the "X/50" indicator or counts source items in the sidebar.
 */
async function getNlmSourceCount(): Promise<number> {
  try {
    const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    if (!nlmTabs[0]?.id) return 0;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: nlmTabs[0].id },
      world: 'MAIN' as any,
      func: () => {
        // Method 1: Look for "X/50" progress indicator
        const allText = document.body.innerText;
        const match = allText.match(/(\d+)\s*\/\s*50/);
        if (match) return parseInt(match[1], 10);

        // Method 2: Count source items in sidebar
        const sources = document.querySelectorAll(
          '.source-item, [class*="source-container"], [data-source-id]'
        );
        return sources.length;
      },
      args: [],
    });

    return (result?.result as number) || 0;
  } catch {
    return 0;
  }
}

/**
 * Import one or more YouTube URLs into the currently-open NLM notebook.
 * Returns a result object with success/error info.
 */
async function importUrlsToNlm(urls: string[]): Promise<{
  success: boolean;
  error?: string;
  urlCount: number;
  message?: string;
  clipboardText?: string;
}> {
  const urlString = urls.join('\n');
  const urlCount = urls.length;

  if (urls.length === 0 || urls.every(u => !u)) {
    return { success: false, error: 'No URLs provided.', urlCount: 0 };
  }

  // Find an open NotebookLM tab
  const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });

  if (nlmTabs.length === 0 || !nlmTabs[0].id) {
    await chrome.tabs.create({ url: 'https://notebooklm.google.com/', active: true });
    return {
      success: false, clipboardText: urlString, urlCount,
      error: 'Please open a notebook in NotebookLM first, then try again.',
    };
  }

  const nlmTabId = nlmTabs[0].id;
  const nlmUrl = nlmTabs[0].url || '';

  if (!nlmUrl.includes('/notebook/')) {
    await chrome.tabs.update(nlmTabId, { active: true });
    return {
      success: false, clipboardText: urlString, urlCount,
      error: 'Please open a specific notebook in NotebookLM, then try again.',
    };
  }

  // Execute DOM automation on the NLM tab
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: nlmTabId },
    world: 'MAIN' as any,
    func: async (url: string) => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const startTime = Date.now();
      const TIMEOUT_MS = 30_000;
      const checkTimeout = () => {
        if (Date.now() - startTime > TIMEOUT_MS) throw new Error('NLM processing timed out after 30 seconds.');
      };

      function findEl(selectors: string[]): HTMLElement | null {
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement;
          if (el && el.offsetParent !== null) return el;
        }
        return null;
      }

      function findByText(selector: string, texts: string[]): HTMLElement | null {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          const t = el.textContent?.trim().toLowerCase() || '';
          if (texts.some(txt => t.includes(txt.toLowerCase()))) return el as HTMLElement;
        }
        return null;
      }

      function safeInput(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      try {
        // Step 1: Click "Add source"
        const addBtn = findEl(['button[aria-label*="Add"]', '.add-source-button', 'button[data-tooltip*="Add"]'])
          || findByText('button', ['add source', 'add sources', '新增來源', '添加来源']);
        if (!addBtn) return { success: false, error: 'Cannot find "Add Source" button.' };
        addBtn.click();
        await sleep(800);

        // Step 2: Select chip
        const chip = findByText('mat-chip, mat-chip-option, .mdc-evolution-chip, span.mdc-evolution-chip__text-label', ['youtube'])
          || findByText('mat-chip, mat-chip-option, .mdc-evolution-chip, span.mdc-evolution-chip__text-label', ['website', '網站', '网站']);
        if (chip) {
          const target = chip.closest('mat-chip-option') || chip.closest('.mdc-evolution-chip') || chip;
          (target as HTMLElement).click();
          await sleep(500);
        }

        // Step 3: Fill URL(s)
        const urlInput = findEl([
          'textarea[formcontrolname="newUrl"]', 'input[type="url"]',
          'textarea[placeholder*="URL"]', 'textarea[placeholder*="http"]',
          'input[placeholder*="URL"]', 'input[placeholder*="http"]',
        ]) as HTMLTextAreaElement | HTMLInputElement | null;

        if (!urlInput) {
          const dialog = document.querySelector('mat-dialog-container');
          const any = dialog?.querySelector('textarea, input[type="url"], input[type="text"]') as HTMLTextAreaElement | null;
          if (any) safeInput(any, url);
          else return { success: false, error: 'Cannot find URL input field.' };
        } else {
          safeInput(urlInput, url);
        }

        // Step 4: Click submit
        let inserted = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(600);
          checkTimeout();

          // Strategy A: Proximity to input
          const activeInput = document.querySelector('textarea[formcontrolname="newUrl"], input[type="url"], input[placeholder*="http"]');
          if (activeInput) {
            let container = activeInput.parentElement;
            for (let d = 0; d < 5 && container; d++) {
              const btns = container.querySelectorAll('button:not([disabled])');
              for (const btn of btns) {
                const t = (btn.textContent?.trim() || '').toLowerCase();
                const l = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (t.includes('cancel') || t.includes('取消') || t.includes('close') || l.includes('close') || l.includes('cancel')) continue;
                (btn as HTMLElement).click();
                inserted = true;
                break;
              }
              if (inserted) break;
              container = container.parentElement;
            }
          }
          if (inserted) break;

          // Strategy B: Known selectors
          const submitBtn = document.querySelector(
            'button.actions-enter-button:not([disabled]), button[aria-label="提交"]:not([disabled]), button[aria-label="Submit"]:not([disabled])'
          ) as HTMLElement | null;
          if (submitBtn) { submitBtn.click(); inserted = true; break; }

          // Strategy C: Text fallback
          if (!inserted) {
            for (const btn of document.querySelectorAll('button:not([disabled])')) {
              const t = (btn.textContent?.trim() || '').toLowerCase();
              const l = (btn.getAttribute('aria-label') || '').toLowerCase();
              if ((t.includes('insert') || t.includes('插入') || t.includes('提交') || l.includes('submit') || l.includes('提交')) && !t.includes('cancel')) {
                (btn as HTMLElement).click(); inserted = true; break;
              }
            }
          }
          if (inserted) break;
        }

        if (!inserted) return { success: false, error: 'Submit button not found. URLs were filled — click the arrow (→) manually.' };

        // Step 5: Wait for completion
        for (let i = 0; i < 20; i++) {
          await sleep(500);
          checkTimeout();
          if (!document.querySelector('textarea[formcontrolname="newUrl"], input[placeholder*="http"]')) return { success: true };
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    },
    args: [urlString],
  });

  const importResult = result?.result as any;

  if (importResult?.success) {
    await incrementUsage('imports');
    const msg = urlCount === 1
      ? 'YouTube video added to your NotebookLM notebook!'
      : `Added ${urlCount} videos to your NotebookLM notebook!`;
    return { success: true, message: msg, urlCount };
  } else {
    return {
      success: false, clipboardText: urlString, urlCount,
      error: importResult?.error || 'Auto-import failed. URLs copied to clipboard.',
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
                    selector = 'ytd-rich-item-renderer a#video-title-link, ytd-grid-video-renderer a#video-title';
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
            const { urls, pageTitle } = message as any;
            if (!urls || urls.length === 0) {
              sendResponse({ success: false, error: 'No URLs provided.' });
              return;
            }

            // Check how many sources the current notebook already has
            const currentCount = await getNlmSourceCount();
            const availableSlots = Math.max(0, 50 - currentCount);

            if (availableSlots === 0) {
              sendResponse({
                success: false,
                error: `This notebook is full (${currentCount}/50 sources). Please create a new notebook first.`,
              });
              return;
            }

            // Split: first batch fills remaining slots, rest goes to queue
            const firstBatchSize = Math.min(urls.length, availableSlots);
            const firstBatch = urls.slice(0, firstBatchSize);
            const remaining = urls.slice(firstBatchSize);

            // Import first batch
            const result = await importUrlsToNlm(firstBatch);

            if (!result.success) {
              sendResponse(result);
              return;
            }

            if (remaining.length === 0) {
              // All fit in current notebook
              sendResponse({
                success: true,
                message: `Added ${firstBatchSize} videos to your notebook!`,
              });
              return;
            }

            // Save remaining URLs to queue for next notebook(s)
            const queue = createBatchQueue(remaining, pageTitle);
            await saveQueue(queue);

            const totalChunks = queue.chunks.length + 1; // +1 for the batch we just imported
            sendResponse({
              success: true,
              needsNewNotebook: true,
              message: `Added ${firstBatchSize} videos (notebook full at 50). ${remaining.length} videos remaining — create a new notebook named "${pageTitle} - Part 2" and click "Resume Import".`,
              remaining: remaining.length,
              totalChunks,
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
