import type { AIProvider, Chapter, ImportMode } from '@/types';

const DEFAULT_BACKEND_URL = 'https://api.videolm.workers.dev';

export class BuiltinProvider implements AIProvider {
  readonly name = 'builtin';
  private backendUrl: string;
  private authToken: string;

  constructor(authToken: string, backendUrl?: string) {
    this.authToken = authToken;
    this.backendUrl = backendUrl ?? DEFAULT_BACKEND_URL;
  }

  private async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.backendUrl}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Backend error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    const result = await this.post<{ content: string }>('/api/summarize', {
      transcript,
      videoTitle,
      mode,
    });
    return result.content;
  }

  async splitChapters(transcript: string): Promise<Chapter[]> {
    const result = await this.post<{ chapters: Chapter[] }>('/api/split-chapters', {
      transcript,
    });
    return result.chapters;
  }

  async translate(content: string, targetLang: string): Promise<string> {
    const result = await this.post<{ content: string }>('/api/translate', {
      content,
      targetLang,
    });
    return result.content;
  }
}
