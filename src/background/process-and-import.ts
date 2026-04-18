import type { VideoContent, ImportOptions, UserSettings, AIProvider } from '@/types';
import { formatTranscript } from '@/extractors/youtube-extractor';
import { addMetadataHeader, type MetadataInput } from '@/processing/rag-optimizer';
import { resolveOutputLanguage } from '@/ai/language';

/**
 * Injectable dependencies for processAndImport.
 *
 * The function itself is chrome-agnostic; the caller wires chrome-specific
 * implementations (storage-backed settings, chrome.storage usage counters,
 * i18n tied to chrome.i18n) or test stubs.
 */
export interface ProcessDeps {
  getSettings: () => Promise<UserSettings>;
  checkQuota: (s: UserSettings) => { canImport: boolean; canUseAI: boolean };
  incrementUsage: (key: 'imports' | 'aiCalls') => Promise<void>;
  resolveProvider: (s: UserSettings, token?: string) => AIProvider;
  t: (key: string) => string;
  authToken?: string;
}

export interface ProcessAndImportResult {
  success: boolean;
  items: Array<{ title: string; content: string }>;
  error?: string;
  clipboardText?: string;
  message?: string;
}

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
 * Process video content according to import mode and return formatted items.
 */
export async function processAndImport(
  videoContent: VideoContent,
  options: ImportOptions,
  deps: ProcessDeps,
): Promise<ProcessAndImportResult> {
  // 1. Check quota
  const settings = await deps.getSettings();
  const quota = deps.checkQuota(settings);

  if (!quota.canImport) {
    return { success: false, items: [], error: deps.t('error_quota_exceeded') };
  }

  const needsAI = options.mode !== 'raw';
  if (needsAI && !quota.canUseAI) {
    return {
      success: false,
      items: [],
      error: deps.t('error_ai_requires_key'),
    };
  }

  // 2. Resolve AI provider
  const provider = deps.resolveProvider(settings, deps.authToken);

  // 3. Format raw transcript
  const rawText = formatTranscript(videoContent.transcript, { timestamps: true });
  const meta = buildMeta(videoContent);
  const language = resolveOutputLanguage(
    settings.outputLanguage ?? 'auto',
    videoContent.language,
  );

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
        const processed = await provider.summarize(rawText, videoContent.title, options.mode, language);
        if (needsAI) await deps.incrementUsage('aiCalls');
        const content = addMetadataHeader(processed, meta);
        items = [{ title: videoContent.title, content }];
        break;
      }

      case 'chapters': {
        // Use YouTube chapters if available, otherwise AI-generated
        let chapters = videoContent.chapters ?? [];

        if (chapters.length === 0) {
          chapters = await provider.splitChapters(rawText, videoContent.transcript, language);
          if (needsAI) await deps.incrementUsage('aiCalls');
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
        await deps.incrementUsage('aiCalls');
      }
    }

    // 6. Increment import usage
    await deps.incrementUsage('imports');

    // 7. Copy to clipboard (Tier 3 — always works)
    // Combine all items into a single text for clipboard
    const clipboardText = items
      .map((item) => item.content)
      .join('\n\n---\n\n');

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
