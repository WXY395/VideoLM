import type { AIProvider, Chapter, ImportMode, TranscriptSegment } from '@/types';

/**
 * Fallback provider when no AI backend is available.
 * Returns transcript as-is for summarize, empty array for chapters,
 * and logs an error for translate (returning content unchanged).
 */
export class NoAIProvider implements AIProvider {
  readonly name = 'no-ai';

  async summarize(transcript: string, _videoTitle: string, _mode: ImportMode): Promise<string> {
    return transcript;
  }

  async splitChapters(
    _transcript: string,
    _segments: TranscriptSegment[],
  ): Promise<Chapter[]> {
    return [];
  }

  async translate(content: string, _targetLang: string): Promise<string> {
    console.error(
      '[VideoLM] Translation requires an AI provider. Please configure a BYOK API key (OpenAI or Anthropic) in the extension settings, or upgrade to VideoLM Pro.',
    );
    return content;
  }
}
