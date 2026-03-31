import type { MessageType, VideoContent, ImportOptions, ImportMode } from '@/types';
import { getConfig } from '@/config/dynamic-config';
import { resolveProvider } from '@/ai/provider-manager';
import {
  formatTranscript,
  extractCaptionTracks,
  extractVideoMetadata,
  extractChapters,
  extractVideoId,
  parseXMLCaptions,
} from '@/extractors/youtube-extractor';
import { addMetadataHeader, type MetadataInput } from '@/processing/rag-optimizer';
import { checkDuplicateByTitle } from '@/processing/duplicate-detector';
import { getSettings, saveSettings, incrementUsage, checkQuota } from './usage-tracker';

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

    return { success: true, items };
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
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: 'No active tab' });
              return;
            }

            const ready = await waitForContentScript(tab.id);
            if (!ready) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: 'Content script not loaded. Please refresh the YouTube page.' });
              return;
            }

            // Step 1: Get playerResponse from content script
            const prResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PLAYER_RESPONSE' });
            if (!prResponse?.data) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: prResponse?.error || 'Could not extract player response.' });
              return;
            }

            const playerResponse = prResponse.data;
            const meta = extractVideoMetadata(playerResponse);
            const videoId = extractVideoId(tab.url) ?? playerResponse?.videoDetails?.videoId ?? '';

            // Step 2: Fetch transcript via DOM scraping
            // Opens YouTube's built-in transcript panel and reads the rendered segments.
            // This is the most reliable approach because:
            // - timedtext baseUrl requires POT tokens (returns empty without them)
            // - get_transcript API may need authentication
            // - DOM scraping uses YouTube's own UI, always works when transcripts exist
            let segments: any[] = [];
            let language = 'unknown';

            try {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: async () => {
                  try {
                    // Helper: wait for element
                    const waitFor = (sel: string, timeout = 5000): Promise<Element | null> =>
                      new Promise((resolve) => {
                        const el = document.querySelector(sel);
                        if (el) { resolve(el); return; }
                        const obs = new MutationObserver(() => {
                          const found = document.querySelector(sel);
                          if (found) { obs.disconnect(); resolve(found); }
                        });
                        obs.observe(document.body, { childList: true, subtree: true });
                        setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
                      });

                    // Step A: Click "Show transcript" button
                    // First try the "..." more actions menu below the video
                    const moreBtn = document.querySelector('ytd-video-description-transcript-section-renderer button')
                      || document.querySelector('button[aria-label="Show transcript"]')
                      || document.querySelector('ytd-button-renderer#description-inline-expander button');

                    // Alternative: use the engagement panel trigger
                    // YouTube has a "Show transcript" button in the description area
                    let transcriptPanel = document.querySelector('ytd-transcript-renderer');

                    if (!transcriptPanel) {
                      // Try clicking the transcript button in description
                      const descButtons = document.querySelectorAll('ytd-video-description-transcript-section-renderer button, ytd-button-renderer button');
                      for (const btn of descButtons) {
                        if (btn.textContent?.trim().includes('顯示逐字稿') ||
                            btn.textContent?.trim().includes('Show transcript') ||
                            btn.textContent?.trim().includes('字幕')) {
                          (btn as HTMLElement).click();
                          break;
                        }
                      }

                      // Also try the "..." menu under the video
                      const menuBtns = document.querySelectorAll('#menu button, ytd-menu-renderer button');
                      for (const btn of menuBtns) {
                        const label = btn.getAttribute('aria-label') || btn.textContent || '';
                        if (label.includes('更多') || label.includes('More') || label.includes('...')) {
                          (btn as HTMLElement).click();
                          await new Promise(r => setTimeout(r, 500));

                          // Look for transcript option in dropdown
                          const menuItems = document.querySelectorAll('tp-yt-paper-listbox ytd-menu-service-item-renderer, ytd-menu-popup-renderer ytd-menu-service-item-renderer');
                          for (const item of menuItems) {
                            if (item.textContent?.includes('逐字稿') || item.textContent?.includes('transcript')) {
                              (item as HTMLElement).click();
                              break;
                            }
                          }
                          break;
                        }
                      }

                      // Wait for transcript panel to appear
                      transcriptPanel = await waitFor('ytd-transcript-renderer', 5000);
                    }

                    if (!transcriptPanel) {
                      // Last resort: try the player's built-in transcript data
                      // Access ytInitialPlayerResponse for caption tracks
                      const pr = (window as any).ytInitialPlayerResponse;
                      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                      if (!tracks?.length) return { segments: [], language: '', error: 'no_transcript_panel' };

                      // Try fetching with the page's full credentials
                      const bestTrack = tracks.find((t: any) => t.kind !== 'asr') || tracks[0];
                      const resp = await fetch(bestTrack.baseUrl, { credentials: 'include' });
                      const xml = await resp.text();

                      if (xml && xml.includes('<text')) {
                        const regex = /<text\s+start="([^"]*?)"\s+dur="([^"]*?)"[^>]*>([\s\S]*?)<\/text>/g;
                        const segs: any[] = [];
                        let m;
                        while ((m = regex.exec(xml)) !== null) {
                          segs.push({
                            text: m[3].replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\n/g,' ').trim(),
                            start: parseFloat(m[1]),
                            duration: parseFloat(m[2]),
                          });
                        }
                        return { segments: segs, language: bestTrack.languageCode || '', error: null };
                      }

                      return { segments: [], language: bestTrack.languageCode || '', error: 'caption_fetch_empty' };
                    }

                    // Step B: Wait for transcript segments to load
                    await waitFor('ytd-transcript-segment-renderer', 3000);
                    await new Promise(r => setTimeout(r, 500)); // extra settle time

                    // Step C: Read transcript segments from DOM
                    const segElements = transcriptPanel.querySelectorAll('ytd-transcript-segment-renderer');
                    const segs: any[] = [];

                    segElements.forEach((el: any) => {
                      const timestamp = el.querySelector('.segment-timestamp')?.textContent?.trim() || '';
                      const text = el.querySelector('.segment-text')?.textContent?.trim() || '';

                      // Parse timestamp "0:42" or "1:23:45" to seconds
                      const parts = timestamp.split(':').map(Number);
                      let startSec = 0;
                      if (parts.length === 3) startSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
                      else if (parts.length === 2) startSec = parts[0] * 60 + parts[1];

                      if (text) {
                        segs.push({ text, start: startSec, duration: 0 });
                      }
                    });

                    // Close the transcript panel to clean up
                    const closeBtn = transcriptPanel.querySelector('button[aria-label="Close"]')
                      || transcriptPanel.querySelector('button[aria-label="關閉"]');
                    if (closeBtn) (closeBtn as HTMLElement).click();

                    return { segments: segs, language: '', error: null };
                  } catch (e: any) {
                    return { segments: [], language: '', error: e.message || String(e) };
                  }
                },
                args: [],
              });

              const transcriptResult = result?.result as any;
              if (transcriptResult?.segments?.length > 0) {
                segments = transcriptResult.segments;
                language = transcriptResult.language || 'unknown';
              }
            } catch {
              // Transcript fetch failed — continue with empty transcript
            }

            // Step 3: Build VideoContent
            const rawChapters = extractChapters(playerResponse);
            const chapters = rawChapters.length > 0
              ? rawChapters.map((ch: any) => ({
                  ...ch,
                  segments: segments.filter((s: any) => s.start >= ch.startTime && s.start < ch.endTime),
                }))
              : undefined;

            // Use caption track language if innertube didn't provide one
            const tracks = extractCaptionTracks(playerResponse);
            const bestTrack = tracks.find((t: any) => !t.isAutoGenerated) ?? tracks[0];
            if (language === 'unknown' && bestTrack) {
              language = bestTrack.languageCode;
            }

            const content = {
              videoId,
              title: meta.title ?? '',
              author: meta.author ?? '',
              platform: 'youtube' as const,
              transcript: segments,
              chapters,
              duration: meta.duration ?? 0,
              language,
              url: tab.url,
              metadata: meta.metadata ?? { publishDate: '', viewCount: 0, tags: [] },
            };

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

      case 'IMPORT_TO_NLM': {
        // Forward to NLM content script (handled by import-orchestrator in future)
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
