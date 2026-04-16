import type { AIProvider, Chapter, ImportMode, TranscriptSegment } from '@/types';

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
      console.error(`Backend error (${response.status}): ${error}`);
      return {} as T;
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

  async splitChapters(
    transcript: string,
    segments: TranscriptSegment[],
  ): Promise<Chapter[]> {
    const result = await this.post<{ chapters: Chapter[] }>('/api/split-chapters', {
      transcript,
    });
    // Backfill segments from the caller-supplied transcript if the backend
    // returned chapters without segment data (same defence as BYOK providers).
    return (result.chapters ?? []).map((ch) => ({
      ...ch,
      segments:
        ch.segments && ch.segments.length > 0
          ? ch.segments
          : segments.filter((s) => s.start >= ch.startTime && s.start < ch.endTime),
    }));
  }

  async translate(content: string, targetLang: string): Promise<string> {
    const result = await this.post<{ content: string }>('/api/translate', {
      content,
      targetLang,
    });
    return result.content;
  }
}
