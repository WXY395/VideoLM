import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiDirectProvider } from '../providers/gemini-direct';

vi.mock('../prompts', () => ({
  buildSummaryPrompt: () => 'mock-summary-prompt',
  buildStructuredPrompt: () => 'mock-structured-prompt',
  buildChapterSplitPrompt: () => 'mock-chapter-prompt',
  buildTranslatePrompt: () => 'mock-translate-prompt',
}));

function makeOkResponse(text: string) {
  return {
    ok: true,
    json: () => Promise.resolve({
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
        },
      ],
    }),
  };
}

function makeErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

describe('GeminiDirectProvider', () => {
  let provider: GeminiDirectProvider;

  beforeEach(() => {
    provider = new GeminiDirectProvider('gemini-test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed response on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse('summary text') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary', 'English');

    expect(result).toBe('summary text');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/gemini-2.5-flash-lite:generateContent');
    expect(vi.mocked(fetch).mock.calls[0][0]).not.toContain('gemini-test-key');
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      'x-goog-api-key': 'gemini-test-key',
    });
  });

  it('uses a custom model when configured', async () => {
    provider = new GeminiDirectProvider('gemini-test-key', 'gemini-2.5-flash');
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse('summary text') as Response);

    await provider.summarize('transcript', 'title', 'summary', 'English');

    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/gemini-2.5-flash:generateContent');
  });

  it('returns empty string on non-retryable error (401)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeErrorResponse(401, 'Unauthorized') as unknown as Response,
    );

    const result = await provider.summarize('transcript', 'title', 'summary', 'English');

    expect(result).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns raw transcript for raw mode without API call', async () => {
    const result = await provider.summarize('raw transcript text', 'title', 'raw', 'English');

    expect(result).toBe('raw transcript text');
    expect(fetch).not.toHaveBeenCalled();
  });
});
