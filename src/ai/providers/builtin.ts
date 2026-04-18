import type { AIProvider, Chapter, ImportMode, TranscriptSegment } from '@/types';
import { normalizeChapters, type RawChapter } from '../normalize-chapters';

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

  async summarize(transcript: string, videoTitle: string, mode: ImportMode, language: string): Promise<string> {
    const result = await this.post<{ content: string }>('/api/summarize', {
      transcript,
      videoTitle,
      mode,
      language,
    });
    return result.content;
  }

  async splitChapters(
    transcript: string,
    segments: TranscriptSegment[],
    language: string,
  ): Promise<Chapter[]> {
    const result = await this.post<{ chapters: Chapter[] }>('/api/split-chapters', {
      transcript,
      language,
    });

    const backendChapters = result.chapters ?? [];

    // If the backend returned no chapters at all, just pass the empty list through.
    if (backendChapters.length === 0) return [];

    // If every chapter already carries segments, trust the backend.
    const allHaveSegments = backendChapters.every(
      (ch) => ch.segments && ch.segments.length > 0,
    );
    if (allHaveSegments) return backendChapters;

    // Otherwise run the same defensive normalisation as BYOK providers so we
    // never emit overlapping chapters that would duplicate transcript content.
    const raw: RawChapter[] = backendChapters.map((ch) => ({
      chapterTitle: ch.title,
      startTime: ch.startTime,
      endTime: ch.endTime,
    }));
    return normalizeChapters(raw, segments);
  }

  async translate(content: string, targetLang: string): Promise<string> {
    const result = await this.post<{ content: string }>('/api/translate', {
      content,
      targetLang,
    });
    return result.content;
  }
}
