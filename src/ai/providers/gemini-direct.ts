import type { AIProvider, Chapter, ImportMode, TranscriptSegment } from '@/types';
import {
  buildStructuredPrompt,
  buildSummaryPrompt,
  buildChapterSplitPrompt,
  buildTranslatePrompt,
} from '../prompts';
import { fetchWithRetry } from '../fetch-with-retry';
import { stripCodeFence } from '../strip-code-fence';
import { normalizeChapters, type RawChapter } from '../normalize-chapters';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const TEMPERATURE = 0.3;

export class GeminiDirectProvider implements AIProvider {
  readonly name = 'gemini-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
    const endpoint = `${GEMINI_API_BASE_URL}/${encodeURIComponent(this.model)}:generateContent`;
    const response = await fetchWithRetry(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: TEMPERATURE,
          },
        }),
      },
      { providerName: 'Gemini' },
    );

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part: { text?: string }) => part.text ?? '')
      .join('');
    return stripCodeFence(text);
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode, language: string): Promise<string> {
    if (mode === 'raw') return transcript;
    try {
      if (mode === 'summary') {
        const prompt = buildSummaryPrompt(transcript, videoTitle, '', language);
        return await this.chat(prompt);
      }
      const prompt = buildStructuredPrompt(transcript, videoTitle, '', 0, language);
      return await this.chat(prompt);
    } catch (error) {
      console.error('Gemini summarize failed:', error);
      return '';
    }
  }

  async splitChapters(
    transcript: string,
    segments: TranscriptSegment[],
    language: string,
  ): Promise<Chapter[]> {
    try {
      const prompt = buildChapterSplitPrompt(transcript, language);
      const result = await this.chat(prompt);
      const parsed: RawChapter[] = JSON.parse(result);
      return normalizeChapters(parsed, segments);
    } catch (error) {
      console.error('Gemini splitChapters failed:', error);
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    try {
      const prompt = buildTranslatePrompt(content, targetLang);
      return await this.chat(prompt);
    } catch (error) {
      console.error('Gemini translate failed:', error);
      return '';
    }
  }
}
