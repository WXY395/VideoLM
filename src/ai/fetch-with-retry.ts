/**
 * fetch with exponential backoff retry for AI provider API calls.
 *
 * Retries on:
 * - Retryable HTTP status codes (408, 429, 500, 502, 503, 504, 520, 522, 524, 529)
 * - Network errors (TypeError from fetch)
 * - JSON parse errors (SyntaxError from response.json())
 *
 * Does NOT retry on:
 * - Client errors (400, 401, 403, 404, etc.) — thrown as NonRetryableApiError
 *
 * On 429, honors `Retry-After` header (max of header value and backoff).
 */

// MAX_RETRIES = 3 means 4 total attempts (1 initial + 3 retries)
export const MAX_RETRIES = 3;
export const INITIAL_DELAY_MS = 1000;
export const JITTER_MAX_MS = 500;
export const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  520, // Cloudflare Unknown Error
  522, // Cloudflare Connection Timed Out
  524, // Cloudflare Timeout
  529, // Anthropic Overloaded
]);

/** Thrown when a server response has a non-retryable HTTP status. */
export class NonRetryableApiError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${providerName} API error (${status}): ${body}`);
    this.name = 'NonRetryableApiError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header value (seconds or HTTP date) into milliseconds.
 * Returns 0 if header is missing or invalid.
 */
export function parseRetryAfter(headerValue: string | null): number {
  if (!headerValue) return 0;

  // Seconds form
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  // HTTP-date form
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return 0;
}

/** Compute the delay in ms before attempt N (1-indexed). */
export function computeBackoffDelay(attempt: number): number {
  const base = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

export interface FetchWithRetryOptions {
  /** Name used in log messages and error objects, e.g. 'Anthropic' or 'OpenAI'. */
  providerName: string;
  /** Max retry attempts (default 3). */
  maxRetries?: number;
}

/**
 * Fetch with exponential backoff retry.
 * Returns the Response on success. Throws NonRetryableApiError on non-retryable
 * status codes, or the last error (network/retryable-status) after retries exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const { providerName } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffDelay = computeBackoffDelay(attempt);
      const delay = lastError instanceof RetryableStatusError && lastError.retryAfterMs > 0
        ? Math.max(lastError.retryAfterMs, backoffDelay)
        : backoffDelay;
      console.warn(
        `[VideoLM] ${providerName} API retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }

    try {
      const response = await fetch(url, init);

      if (response.ok) {
        return response;
      }

      const errorBody = await response.text();

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        throw new NonRetryableApiError(providerName, response.status, errorBody);
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      lastError = new RetryableStatusError(
        providerName,
        response.status,
        errorBody,
        retryAfterMs,
      );
      console.warn(
        `[VideoLM] ${providerName} API retryable error (${response.status}): ${errorBody}`,
      );
    } catch (error) {
      // Re-throw non-retryable errors immediately (using instanceof, not string matching)
      if (error instanceof NonRetryableApiError) {
        throw error;
      }
      // Network error (TypeError) or JSON/parse error — retryable
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `[VideoLM] ${providerName} API network error, will retry...`,
        lastError.message,
      );
    }
  }

  console.error(
    `[VideoLM] ${providerName} API failed after ${maxRetries} retries: ${lastError?.message}`,
  );
  throw lastError ?? new Error(`${providerName} API failed after retries`);
}

/** Internal: retryable error with optional Retry-After hint. */
class RetryableStatusError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs: number,
  ) {
    super(`${providerName} API error (${status}): ${body}`);
    this.name = 'RetryableStatusError';
  }
}
