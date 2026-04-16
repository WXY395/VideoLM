import type { AIProvider, Chapter, ImportMode } from '@/types';
import {
  buildStructuredPrompt,
  buildSummaryPrompt,
  buildChapterSplitPrompt,
  buildTranslatePrompt,
} from '../prompts';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;

// MAX_RETRIES = 3 means 4 total attempts (1 initial + 3 retries)
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAIDirectProvider implements AIProvider {
  readonly name = 'openai-direct';
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
        console.warn(`OpenAI API retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms`);
        await sleep(delay);
      }

      try {
        const response = await fetch(OPENAI_API_URL, {
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
        });

        if (response.ok) {
          const data = await response.json();
          return data.choices[0]?.message?.content ?? '';
        }

        const errorBody = await response.text();

        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
        }

        lastError = new Error(`OpenAI API error (${response.status}): ${errorBody}`);
        console.warn(`OpenAI API retryable error (${response.status}): ${errorBody}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('OpenAI API error')) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[VideoLM] OpenAI API network error, will retry...`, lastError.message);
      }
    }

    console.error(`OpenAI API failed after ${MAX_RETRIES} retries: ${lastError?.message}`);
    throw lastError ?? new Error('OpenAI API failed after retries');
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
      console.error('OpenAI summarize failed:', error);
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
