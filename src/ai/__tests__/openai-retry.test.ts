import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIDirectProvider } from '../providers/openai-direct';

// Mock the prompts module so summarize() can build a prompt string
vi.mock('../prompts', () => ({
  buildSummaryPrompt: () => 'mock-summary-prompt',
  buildStructuredPrompt: () => 'mock-structured-prompt',
  buildChapterSplitPrompt: () => 'mock-chapter-prompt',
  buildTranslatePrompt: () => 'mock-translate-prompt',
}));

function makeOkResponse(text: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: text } }] }),
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

describe('OpenAIDirectProvider', () => {
  let provider: OpenAIDirectProvider;

  beforeEach(() => {
    provider = new OpenAIDirectProvider('sk-test-key');
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
  });

  it('returns empty string on non-retryable error (401)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeErrorResponse(401, 'Unauthorized') as unknown as Response,
    );

    const result = await provider.summarize('transcript', 'title', 'summary', 'English');

    // summarize catches the NonRetryableApiError and returns ''
    expect(result).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns raw transcript for raw mode without API call', async () => {
    const result = await provider.summarize('raw transcript text', 'title', 'raw', 'English');

    expect(result).toBe('raw transcript text');
    expect(fetch).not.toHaveBeenCalled();
  });
});
