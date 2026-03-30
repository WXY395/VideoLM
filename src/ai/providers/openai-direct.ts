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

export class OpenAIDirectProvider implements AIProvider {
  readonly name = 'openai-direct';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  private async chat(prompt: string): Promise<string> {
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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content ?? '';
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    if (mode === 'raw') {
      return transcript;
    }

    if (mode === 'summary') {
      const prompt = buildSummaryPrompt(transcript, videoTitle, '', 'en');
      return this.chat(prompt);
    }

    // Default: structured
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
