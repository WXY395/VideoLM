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

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 4096;

export class AnthropicDirectProvider implements AIProvider {
  readonly name = 'anthropic-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
    const response = await fetchWithRetry(
      ANTHROPIC_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
          temperature: TEMPERATURE,
        }),
      },
      { providerName: 'Anthropic' },
    );

    const data = await response.json();
    const textBlock = data.content?.find(
      (block: { type: string; text?: string }) => block.type === 'text',
    );
    return stripCodeFence(textBlock?.text ?? '');
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    if (mode === 'raw') return transcript;
    try {
      if (mode === 'summary') {
        const prompt = buildSummaryPrompt(transcript, videoTitle, '', 'en');
        return await this.chat(prompt);
      }
      const prompt = buildStructuredPrompt(transcript, videoTitle, '', 0, 'en');
      return await this.chat(prompt);
    } catch (error) {
      console.error('Anthropic summarize failed:', error);
      return '';
    }
  }

  async splitChapters(
    transcript: string,
    segments: TranscriptSegment[],
  ): Promise<Chapter[]> {
    try {
      const prompt = buildChapterSplitPrompt(transcript);
      const result = await this.chat(prompt);
      const parsed: RawChapter[] = JSON.parse(result);
      return normalizeChapters(parsed, segments);
    } catch (error) {
      console.error('Anthropic splitChapters failed:', error);
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    try {
      const prompt = buildTranslatePrompt(content, targetLang);
      return await this.chat(prompt);
    } catch (error) {
      console.error('Anthropic translate failed:', error);
      return '';
    }
  }
}
