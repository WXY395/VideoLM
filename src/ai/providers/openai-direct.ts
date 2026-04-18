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

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;

export class OpenAIDirectProvider implements AIProvider {
  readonly name = 'openai-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
    const response = await fetchWithRetry(
      OPENAI_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: TEMPERATURE,
        }),
      },
      { providerName: 'OpenAI' },
    );

    const data = await response.json();
    return stripCodeFence(data.choices[0]?.message?.content ?? '');
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
      console.error('OpenAI summarize failed:', error);
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
      console.error('OpenAI splitChapters failed:', error);
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    try {
      const prompt = buildTranslatePrompt(content, targetLang);
      return await this.chat(prompt);
    } catch (error) {
      console.error('OpenAI translate failed:', error);
      return '';
    }
  }
}
