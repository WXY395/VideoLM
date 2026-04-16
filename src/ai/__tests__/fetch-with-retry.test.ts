import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWithRetry,
  NonRetryableApiError,
  RETRYABLE_STATUS_CODES,
  parseRetryAfter,
  computeBackoffDelay,
  INITIAL_DELAY_MS,
  JITTER_MAX_MS,
} from '../fetch-with-retry';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(status: number, body = 'error body', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  // Deterministic jitter: always 0 so delays are predictable
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseRetryAfter', () => {
  it('returns 0 for null', () => {
    expect(parseRetryAfter(null)).toBe(0);
  });

  it('parses seconds form', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('2.5')).toBe(2500);
  });

  it('parses HTTP-date form in the future', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThan(8000);
    expect(result).toBeLessThanOrEqual(10_000);
  });

  it('returns 0 for past dates', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it('returns 0 for invalid values', () => {
    expect(parseRetryAfter('not-a-number')).toBe(0);
    expect(parseRetryAfter('')).toBe(0);
  });
});

describe('computeBackoffDelay', () => {
  it('produces 1s/2s/4s base with no jitter when Math.random=0', () => {
    expect(computeBackoffDelay(1)).toBe(INITIAL_DELAY_MS);
    expect(computeBackoffDelay(2)).toBe(INITIAL_DELAY_MS * 2);
    expect(computeBackoffDelay(3)).toBe(INITIAL_DELAY_MS * 4);
  });

  it('adds jitter up to JITTER_MAX_MS', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const delay = computeBackoffDelay(1);
    expect(delay).toBeGreaterThanOrEqual(INITIAL_DELAY_MS);
    expect(delay).toBeLessThan(INITIAL_DELAY_MS + JITTER_MAX_MS);
  });
});

describe('RETRYABLE_STATUS_CODES', () => {
  it('includes expected retryable codes', () => {
    for (const code of [408, 429, 500, 502, 503, 504, 520, 522, 524, 529]) {
      expect(RETRYABLE_STATUS_CODES.has(code)).toBe(true);
    }
  });

  it('excludes non-retryable codes', () => {
    for (const code of [400, 401, 403, 404, 422]) {
      expect(RETRYABLE_STATUS_CODES.has(code)).toBe(false);
    }
  });
});

describe('fetchWithRetry', () => {
  it('returns response on first success without delay', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });
    await expect(promise).resolves.toBeInstanceOf(Response);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 with 1s delay and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    // Before any timer advance: fetch called once, but not yet retried
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance just under 1s: still not retried
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past the 1s mark: retry fires
    await vi.advanceTimersByTimeAsync(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBeInstanceOf(Response);
  });

  it('uses exponential backoff: 1s, 2s, 4s', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    // Retry 1 after 1s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Retry 2 after 2s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS * 2);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Retry 3 after 4s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS * 4);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    await expect(promise).resolves.toBeInstanceOf(Response);
  });

  it('throws NonRetryableApiError on 401 without retrying', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    await expect(promise).rejects.toBeInstanceOf(NonRetryableApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws NonRetryableApiError with status and body populated', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'MyProvider' });

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NonRetryableApiError);
      if (err instanceof NonRetryableApiError) {
        expect(err.status).toBe(403);
        expect(err.body).toBe('Forbidden');
        expect(err.providerName).toBe('MyProvider');
        expect(err.message).toContain('MyProvider');
        expect(err.message).toContain('403');
      }
    }
  });

  it('retries on network error (fetch throws TypeError)', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBeInstanceOf(Response);
  });

  it('exhausts retries and throws last error', async () => {
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce(errorResponse(500, `fail-${i}`));
    }

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    // Attach rejection handler immediately to avoid unhandledRejection
    const caught = promise.catch((e) => e);

    // Advance through all backoff: 1s + 2s + 4s = 7s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS); // retry 1
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS * 2); // retry 2
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS * 4); // retry 3

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('honors Retry-After header on 429 when larger than backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, 'rate limited', { 'Retry-After': '5' }))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    // Backoff would normally be 1s; Retry-After says 5s
    // Should NOT retry at 1s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Still not retried at 4s
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // At 5s: retry fires
    await vi.advanceTimersByTimeAsync(1001);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBeInstanceOf(Response);
  });

  it('uses backoff when Retry-After is smaller', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, 'rate limited', { 'Retry-After': '0' }))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry('https://example.com', {}, { providerName: 'Test' });

    // Retry-After=0 → fall back to backoff of 1s
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBeInstanceOf(Response);
  });

  it('respects custom maxRetries', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(500));

    const promise = fetchWithRetry(
      'https://example.com',
      {},
      { providerName: 'Test', maxRetries: 1 },
    );

    const caught = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    await caught;
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});
