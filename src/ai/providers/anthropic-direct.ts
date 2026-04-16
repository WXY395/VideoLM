import type { AIProvider, Chapter, ImportMode } from '@/types';
import {
  buildStructuredPrompt,
  buildSummaryPrompt,
  buildChapterSplitPrompt,
  buildTranslatePrompt,
} from '../prompts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 4096;

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AnthropicDirectProvider implements AIProvider {
  readonly name = 'anthropic-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.warn(`Anthropic API retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms`);
        await sleep(delay);
      }

      const response = await fetch(ANTHROPIC_API_URL, {
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
      });

      if (response.ok) {
        const data = await response.json();
        const textBlock = data.content?.find(
          (block: { type: string; text?: string }) => block.type === 'text',
        );
        return textBlock?.text ?? '';
      }

      const errorBody = await response.text();

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        console.error(`Anthropic API error (${response.status}): ${errorBody}`);
        throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
      }

      lastError = new Error(`Anthropic API error (${response.status}): ${errorBody}`);
      console.warn(`Anthropic API retryable error (${response.status}): ${errorBody}`);
    }

    console.error(`Anthropic API failed after ${MAX_RETRIES} retries: ${lastError?.message}`);
    throw lastError ?? new Error('Anthropic API failed after retries');
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    if (mode === 'raw') {
      return transcript;
    }

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

  async splitChapters(transcript: string): Promise<Chapter[]> {
    try {
      const prompt = buildChapterSplitPrompt(transcript);
      const result = await this.chat(prompt);

      const parsed = JSON.parse(result);
      return parsed.map(
        (ch: { chapterTitle: string; startTime: number; endTime: number; content: string }) => ({
          title: ch.chapterTitle,
          startTime: ch.startTime,
          endTime: ch.endTime,
          segments: [],
        }),
      );
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
