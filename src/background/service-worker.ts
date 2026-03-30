import type { MessageType, VideoContent, ImportOptions, ImportMode } from '@/types';
import { getConfig } from '@/config/dynamic-config';
import { resolveProvider } from '@/ai/provider-manager';
import { formatTranscript } from '@/extractors/youtube-extractor';
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
 * Inject the YouTube content script into the active tab programmatically.
 * Returns the tab ID or null if injection failed.
 */
async function injectYouTubeContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content-scripts/youtube.ts'],
    });
    return true;
  } catch {
    return false;
  }
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
        // Programmatically inject YouTube content script into the active tab
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) {
              sendResponse({ type: 'VIDEO_CONTENT', data: null });
              return;
            }

            // Inject content script
            await injectYouTubeContentScript(tab.id);

            // Now ask the content script for video content
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_CONTENT' });
            sendResponse(response);
          } catch {
            sendResponse({ type: 'VIDEO_CONTENT', data: null });
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
