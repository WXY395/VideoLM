import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicDirectProvider } from '../providers/anthropic-direct';

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
    json: () => Promise.resolve({ content: [{ type: 'text', text }] }),
  };
}

function makeErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  };
}

describe('AnthropicDirectProvider retry behavior', () => {
  let provider: AnthropicDirectProvider;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    provider = new AnthropicDirectProvider('sk-ant-test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns result on first success without retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse('summary text') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary');

    expect(result).toBe('summary text');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorResponse(500, 'Internal Server Error') as Response)
      .mockResolvedValueOnce(makeOkResponse('recovered') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary');

    expect(result).toBe('recovered');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 (rate limit)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorResponse(429, 'Rate limited') as Response)
      .mockResolvedValueOnce(makeOkResponse('after rate limit') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary');

    expect(result).toBe('after rate limit');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 401 (bad key)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeErrorResponse(401, 'Unauthorized') as Response,
    );

    const result = await provider.summarize('transcript', 'title', 'summary');

    // summarize catches the thrown error and returns ''
    expect(result).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty string after all retries exhausted', { timeout: 30_000 }, async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorResponse(500, 'fail') as Response)
      .mockResolvedValueOnce(makeErrorResponse(500, 'fail') as Response)
      .mockResolvedValueOnce(makeErrorResponse(500, 'fail') as Response)
      .mockResolvedValueOnce(makeErrorResponse(500, 'fail') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary');

    // 1 initial + 3 retries = 4 total
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result).toBe('');
  });

  it('returns raw transcript for raw mode without API call', async () => {
    const result = await provider.summarize('raw transcript text', 'title', 'raw');

    expect(result).toBe('raw transcript text');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries on network error (fetch throws)', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(makeOkResponse('after network error') as Response);

    const result = await provider.summarize('transcript', 'title', 'summary');

    expect(result).toBe('after network error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
