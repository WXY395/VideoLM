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

export class AnthropicDirectProvider implements AIProvider {
  readonly name = 'anthropic-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
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

    if (!response.ok) {
      const error = await response.text();
      console.error(`Anthropic API error (${response.status}): ${error}`);
      return '';
    }

    const data = await response.json();
    const textBlock = data.content?.find(
      (block: { type: string; text?: string }) => block.type === 'text',
    );
    return textBlock?.text ?? '';
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    if (mode === 'raw') {
      return transcript;
    }

    if (mode === 'summary') {
      const prompt = buildSummaryPrompt(transcript, videoTitle, '', 'en');
      return this.chat(prompt);
    }

    const prompt = buildStructuredPrompt(transcript, videoTitle, '', 0, 'en');
    return this.chat(prompt);
  }

  async splitChapters(transcript: string): Promise<Chapter[]> {
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
  }

  async translate(content: string, targetLang: string): Promise<string> {
    const prompt = buildTranslatePrompt(content, targetLang);
    return this.chat(prompt);
  }
}
