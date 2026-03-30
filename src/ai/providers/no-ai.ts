import type { AIProvider, Chapter, ImportMode } from '@/types';

/**
 * Fallback provider when no AI backend is available.
 * Returns transcript as-is for summarize, empty array for chapters,
 * and throws a helpful error for translate.
 */
export class NoAIProvider implements AIProvider {
  readonly name = 'no-ai';

  async summarize(transcript: string, _videoTitle: string, _mode: ImportMode): Promise<string> {
    return transcript;
  }

  async splitChapters(_transcript: string): Promise<Chapter[]> {
    return [];
  }

  async translate(_content: string, _targetLang: string): Promise<string> {
    throw new Error(
      'Translation requires an AI provider. Please configure a BYOK API key (OpenAI or Anthropic) in the extension settings, or upgrade to VideoLM Pro.',
    );
  }
}
