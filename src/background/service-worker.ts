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
        // Architecture:
        //   1. Content script: extract playerResponse from page HTML
        //   2. Background: extract metadata + caption track URLs from playerResponse
        //   3. MAIN world script: fetch caption XML using page's cookies/origin
        //      (YouTube rejects caption requests from extension origins)
        //   4. Background: parse XML → build VideoContent
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null, error: 'No active tab' });
              return;
            }

            // Wait for content script to be ready
            const ready = await waitForContentScript(tab.id);
            if (!ready) {
              sendResponse({
                type: 'VIDEO_CONTENT',
                data: null,
                error: 'Content script not loaded. Please refresh the YouTube page.',
              });
              return;
            }

            // Step 1: Get playerResponse from content script
            const prResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PLAYER_RESPONSE' });
            if (!prResponse?.data) {
              sendResponse({
                type: 'VIDEO_CONTENT',
                data: null,
                error: prResponse?.error || 'Could not extract player response.',
              });
              return;
            }

            const playerResponse = prResponse.data;

            // Step 2: Extract caption track URLs
            const tracks = extractCaptionTracks(playerResponse);
            let captionXml = '';

            if (tracks.length > 0) {
              const bestTrack = tracks.find((t: any) => !t.isAutoGenerated) ?? tracks[0];

              // Step 3: Fetch caption XML in the page's MAIN world context
              // This is critical — YouTube's timedtext API requires the page's
              // origin and cookies, which only the MAIN world has.
              try {
                const [result] = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  world: 'MAIN',
                  func: async (url: string) => {
                    try {
                      const resp = await fetch(url);
                      return resp.ok ? await resp.text() : '';
                    } catch {
                      return '';
                    }
                  },
                  args: [bestTrack.baseUrl],
                });
                captionXml = result?.result || '';
              } catch {
                // MAIN world execution failed — continue without captions
              }
            }

            // Step 4: Parse and build VideoContent
            const meta = extractVideoMetadata(playerResponse);
            const segments = captionXml ? parseXMLCaptions(captionXml) : [];
            const rawChapters = extractChapters(playerResponse);
            const chapters = rawChapters.length > 0
              ? rawChapters.map((ch: any) => ({
                  ...ch,
                  segments: segments.filter((s: any) => s.start >= ch.startTime && s.start < ch.endTime),
                }))
              : undefined;

            const bestTrack = tracks.find((t: any) => !t.isAutoGenerated) ?? tracks[0];

            const content = {
              videoId: extractVideoId(tab.url) ?? playerResponse?.videoDetails?.videoId ?? '',
              title: meta.title ?? '',
              author: meta.author ?? '',
              platform: 'youtube' as const,
              transcript: segments,
              chapters,
              duration: meta.duration ?? 0,
              language: bestTrack?.languageCode || 'unknown',
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
