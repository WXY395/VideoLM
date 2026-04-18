import type { Chapter, ImportMode, TranscriptSegment } from '@/types';

/** AI provider interface for content processing */
export interface AIProvider {
  name: string;
  summarize(transcript: string, videoTitle: string, mode: ImportMode, language: string): Promise<string>;
  splitChapters(transcript: string, segments: TranscriptSegment[], language: string): Promise<Chapter[]>;
  translate(content: string, targetLang: string): Promise<string>;
}

/**
 * Check whether the browser supports Gemini Nano via the
 * built-in `window.ai.languageModel` API (Chrome 127+).
 */
export async function isGeminiNanoAvailable(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ai = (window as any).ai;
    if (!ai?.languageModel) return false;

    const capabilities = await ai.languageModel.capabilities();
    return capabilities.available === 'readily' || capabilities.available === 'after-download';
  } catch {
    return false;
  }
}
