import type { MessageType, VideoContent, ImportOptions, ImportMode } from '@/types';
import { getConfig } from '@/config/dynamic-config';
import { resolveProvider } from '@/ai/provider-manager';
import { formatTranscript, extractVideoId, parseXMLCaptions } from '@/extractors/youtube-extractor';
import { addMetadataHeader, type MetadataInput } from '@/processing/rag-optimizer';
import { checkDuplicateByTitle } from '@/processing/duplicate-detector';
import { getSettings, saveSettings, incrementUsage, checkQuota } from './usage-tracker';
import { sanitizeYouTubeUrl, deduplicateUrls } from '@/utils/url-sanitizer';

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
        // Quick Import: automatically add YouTube URL as a source in NotebookLM.
        // Requires user to have a NLM notebook already open.
        // Uses DOM automation on the NLM page (same approach as competing extensions).
        (async () => {
          try {
            const videoUrl = (message as any).videoUrl as string;
            if (!videoUrl) {
              sendResponse({ success: false, error: 'No video URL provided.' });
              return;
            }

            // Find an open NotebookLM tab
            const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });

            if (nlmTabs.length === 0 || !nlmTabs[0].id) {
              // No NLM tab open — open one and tell user to select a notebook
              await chrome.tabs.create({ url: 'https://notebooklm.google.com/', active: true });
              sendResponse({
                success: false,
                clipboardText: videoUrl,
                error: 'Please open a notebook in NotebookLM first, then try again. URL copied to clipboard as backup.',
              });
              return;
            }

            const nlmTabId = nlmTabs[0].id;

            // Check if user is inside a notebook (not just the NLM homepage)
            const nlmUrl = nlmTabs[0].url || '';
            const isInNotebook = nlmUrl.includes('/notebook/');

            if (!isInNotebook) {
              await chrome.tabs.update(nlmTabId, { active: true });
              sendResponse({
                success: false,
                clipboardText: videoUrl,
                error: 'Please open a specific notebook in NotebookLM, then try again. URL copied to clipboard as backup.',
              });
              return;
            }

            // Execute DOM automation on the NLM tab to add the YouTube URL as a source
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: nlmTabId },
              world: 'MAIN' as any,
              func: async (url: string) => {
                const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

                // Helper: find element by multiple selectors
                function findEl(selectors: string[]): HTMLElement | null {
                  for (const sel of selectors) {
                    const el = document.querySelector(sel) as HTMLElement;
                    if (el && el.offsetParent !== null) return el;
                  }
                  return null;
                }

                // Helper: find button/chip by text content
                function findByText(selector: string, texts: string[]): HTMLElement | null {
                  const els = document.querySelectorAll(selector);
                  for (const el of els) {
                    const t = el.textContent?.trim().toLowerCase() || '';
                    if (texts.some(txt => t.includes(txt.toLowerCase()))) {
                      return el as HTMLElement;
                    }
                  }
                  return null;
                }

                // Helper: Angular-safe input
                function safeInput(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
                  el.focus();
                  el.value = value;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new Event('blur', { bubbles: true }));
                }

                try {
                  // Step 1: Click "Add source" button
                  const addBtn = findEl([
                    'button[aria-label*="Add"]',
                    '.add-source-button',
                    'button[data-tooltip*="Add"]',
                  ]) || findByText('button', ['add source', 'add sources', '新增來源', '添加来源']);

                  if (!addBtn) return { success: false, error: 'Cannot find "Add Source" button. Make sure you have a notebook open.' };
                  addBtn.click();
                  await sleep(800);

                  // Step 2: Select "YouTube" or "Website" chip
                  const ytChip = findByText(
                    'mat-chip, mat-chip-option, .mdc-evolution-chip, span.mdc-evolution-chip__text-label',
                    ['youtube']
                  );
                  const webChip = findByText(
                    'mat-chip, mat-chip-option, .mdc-evolution-chip, span.mdc-evolution-chip__text-label',
                    ['website', '網站', '网站']
                  );

                  const chip = ytChip || webChip;
                  if (chip) {
                    // Click the chip or its parent
                    const clickTarget = chip.closest('mat-chip-option') || chip.closest('.mdc-evolution-chip') || chip;
                    (clickTarget as HTMLElement).click();
                    await sleep(500);
                  }

                  // Step 3: Fill in the URL
                  const urlInput = findEl([
                    'textarea[formcontrolname="newUrl"]',
                    'input[type="url"]',
                    'textarea[placeholder*="URL"]',
                    'textarea[placeholder*="http"]',
                    'input[placeholder*="URL"]',
                    'input[placeholder*="http"]',
                  ]) as HTMLTextAreaElement | HTMLInputElement | null;

                  if (!urlInput) {
                    // Try finding any textarea in the dialog
                    const dialog = document.querySelector('mat-dialog-container');
                    const anyTextarea = dialog?.querySelector('textarea, input[type="url"], input[type="text"]') as HTMLTextAreaElement | null;
                    if (anyTextarea) {
                      safeInput(anyTextarea, url);
                    } else {
                      return { success: false, error: 'Cannot find URL input field.' };
                    }
                  } else {
                    safeInput(urlInput, url);
                  }

                  // Step 4: Find and click the submit button
                  // NLM 2026 UI uses a blue arrow button (→) next to the input field,
                  // not a traditional "Insert" text button.
                  // Strategy: find the closest button to the URL input field.
                  let inserted = false;
                  for (let attempt = 0; attempt < 8; attempt++) {
                    await sleep(600);

                    // Check if dialog/overlay already closed
                    const panels = document.querySelectorAll(
                      'mat-dialog-container, [class*="dialog"], [class*="modal"], [class*="overlay-panel"]'
                    );

                    // Strategy A: Find submit button near the URL input
                    const activeInput = document.querySelector(
                      'textarea[formcontrolname="newUrl"], input[type="url"], input[placeholder*="http"], textarea[placeholder*="URL"]'
                    );
                    if (activeInput) {
                      // Walk up to find the container row, then find the button
                      let container = activeInput.parentElement;
                      for (let depth = 0; depth < 5 && container; depth++) {
                        const btns = container.querySelectorAll('button:not([disabled])');
                        for (const btn of btns) {
                          // Skip buttons that are clearly not submit (close, cancel)
                          const txt = (btn.textContent?.trim() || '').toLowerCase();
                          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                          if (txt.includes('cancel') || txt.includes('取消') ||
                              txt.includes('close') || txt.includes('關閉') ||
                              label.includes('close') || label.includes('cancel')) continue;

                          // Found a non-cancel, non-disabled button near the input → click it
                          (btn as HTMLElement).click();
                          inserted = true;
                          break;
                        }
                        if (inserted) break;
                        container = container.parentElement;
                      }
                    }

                    if (inserted) break;

                    // Strategy B: Find the submit button by known selectors
                    // NLM 2026 uses: .actions-enter-button with aria-label="提交"
                    const submitByClass = document.querySelector(
                      'button.actions-enter-button:not([disabled]), ' +
                      'button[aria-label="提交"]:not([disabled]), ' +
                      'button[aria-label="Submit"]:not([disabled]), ' +
                      'button[aria-label="Insert"]:not([disabled])'
                    ) as HTMLElement | null;
                    if (submitByClass) {
                      submitByClass.click();
                      inserted = true;
                    }

                    if (!inserted) {
                      // Strategy C: Find by text/aria fallback
                      const allBtns = document.querySelectorAll('button:not([disabled])');
                      for (const btn of allBtns) {
                        const txt = (btn.textContent?.trim() || '').toLowerCase();
                        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if ((txt.includes('insert') || txt.includes('插入') || txt.includes('提交') ||
                             label.includes('insert') || label.includes('submit') || label.includes('提交') ||
                             label.includes('add source') || label.includes('新增來源')) &&
                            !txt.includes('cancel') && !txt.includes('close')) {
                          (btn as HTMLElement).click();
                          inserted = true;
                          break;
                        }
                      }
                    }

                    if (inserted) break;
                  }

                  if (!inserted) {
                    return { success: false, error: 'Submit button not found. URL was filled — please click the arrow (→) button manually.' };
                  }

                  // Step 5: Wait for source to be added (dialog/overlay closes or source appears)
                  for (let i = 0; i < 20; i++) {
                    await sleep(500);
                    // Check if the input field is gone (dialog closed)
                    const input = document.querySelector('textarea[formcontrolname="newUrl"], input[placeholder*="http"]');
                    if (!input) return { success: true };
                  }

                  return { success: true };
                } catch (e: any) {
                  return { success: false, error: e.message || String(e) };
                }
              },
              args: [videoUrl],
            });

            const importResult = result?.result as any;

            if (importResult?.success) {
              await incrementUsage('imports');
              sendResponse({
                success: true,
                message: 'YouTube video added to your NotebookLM notebook!',
              });
            } else {
              // Fallback: copy URL and tell user to paste manually
              sendResponse({
                success: false,
                clipboardText: videoUrl,
                error: importResult?.error || 'Auto-import failed. URL copied to clipboard — paste manually in NotebookLM.',
              });
            }
          } catch (err) {
            sendResponse({
              success: false,
              error: `Quick import failed: ${err instanceof Error ? err.message : String(err)}`,
            });
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
