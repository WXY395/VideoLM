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

            // Step 2: Fetch transcript via Innertube get_transcript API
            // This runs in the page's MAIN world to use YouTube's origin + cookies.
            // The get_transcript endpoint is more reliable than timedtext baseUrl
            // (which now requires Proof-of-Origin tokens).
            let segments: any[] = [];
            let language = 'unknown';

            try {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: async (vid: string) => {
                  try {
                    // Step A: Get transcript params from /next endpoint
                    const nextResp = await fetch(
                      'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          context: { client: { clientName: 'WEB', clientVersion: '2.20250530.01.00' } },
                          videoId: vid,
                        }),
                      }
                    );
                    const nextData = await nextResp.json();

                    // Recursively find getTranscriptEndpoint params
                    function findTranscriptParams(obj: any): string | null {
                      if (!obj || typeof obj !== 'object') return null;
                      if (obj.getTranscriptEndpoint?.params) return obj.getTranscriptEndpoint.params;
                      for (const val of Object.values(obj)) {
                        const found = findTranscriptParams(val);
                        if (found) return found;
                      }
                      return null;
                    }

                    const params = findTranscriptParams(nextData);
                    if (!params) return { segments: [], language: '', error: 'no_transcript_params' };

                    // Step B: Fetch transcript
                    const trResp = await fetch(
                      'https://www.youtube.com/youtubei/v1/get_transcript',
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          context: { client: { clientName: 'WEB', clientVersion: '2.20250530.01.00' } },
                          params,
                        }),
                      }
                    );
                    const trData = await trResp.json();

                    // Parse transcript segments
                    const renderer = trData?.actions?.[0]?.updateEngagementPanelAction
                      ?.content?.transcriptRenderer?.content
                      ?.transcriptSearchPanelRenderer;

                    // Get language
                    const langMenu = renderer?.footer?.transcriptFooterRenderer
                      ?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
                    const selectedLang = langMenu?.find((i: any) => i.selected);
                    const lang = selectedLang?.title || '';

                    const segmentList = renderer?.body
                      ?.transcriptSegmentListRenderer?.initialSegments || [];

                    const segs = segmentList
                      .filter((s: any) => s.transcriptSegmentRenderer)
                      .map((s: any) => {
                        const r = s.transcriptSegmentRenderer;
                        return {
                          text: (r.snippet?.runs || []).map((run: any) => run.text).join(''),
                          start: parseInt(r.startMs || '0', 10) / 1000,
                          duration: (parseInt(r.endMs || '0', 10) - parseInt(r.startMs || '0', 10)) / 1000,
                        };
                      });

                    return { segments: segs, language: lang, error: null };
                  } catch (e: any) {
                    return { segments: [], language: '', error: e.message || String(e) };
                  }
                },
                args: [videoId],
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
