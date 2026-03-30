/**
 * Tier 1 — Fetch Interception.
 *
 * Monkey-patches window.fetch on the NotebookLM page to capture the
 * "add source" API request. We can then replay that request with
 * different content, bypassing the UI entirely.
 */

/** Allowed headers to forward when replaying a captured request. */
const HEADER_ALLOW_LIST = new Set([
  'content-type',
  'authorization',
  'x-goog-authuser',
  'x-goog-request-params',
  'x-same-domain',
]);

/** Safe token TTL in milliseconds (25 minutes). */
const TOKEN_TTL_MS = 25 * 60 * 1000;

export interface ReplayResult {
  success: boolean;
  reason?: string;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  capturedAt: number; // Date.now()
}

export class FetchInterceptor {
  private apiPattern: RegExp;
  private captured: CapturedRequest | null = null;

  constructor(apiPattern: string) {
    this.apiPattern = new RegExp(apiPattern);
  }

  /** Whether a matching request has been captured. */
  isArmed(): boolean {
    return this.captured !== null;
  }

  /** Store a captured request (called when postMessage arrives from the page). */
  setCaptured(req: CapturedRequest): void {
    this.captured = { ...req, capturedAt: Date.now() };
  }

  /**
   * Returns a JS string to be injected into the NLM page context.
   * It monkey-patches window.fetch so that any request matching the
   * apiPattern is captured and forwarded via postMessage.
   */
  getInstallScript(): string {
    const pattern = this.apiPattern.source;
    return `
(function() {
  const _origFetch = window.fetch;
  const _pattern = new RegExp(${JSON.stringify(pattern)});

  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

    // Match URL pattern OR check if body contains method ID
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    if ((_pattern.test(url) || _pattern.test(bodyStr)) && init) {
      const headers = {};
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([k, v]) => { headers[k] = v; });
        } else {
          Object.assign(headers, init.headers);
        }
      }

      window.postMessage({
        type: '__VIDEOLM_FETCH_CAPTURED__',
        payload: {
          url: url,
          method: init.method || 'POST',
          headers: headers,
          body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
        }
      }, '*');
    }

    return _origFetch.apply(this, arguments);
  };
})();
`;
  }

  /**
   * Replay the captured request with new content.
   */
  async replay(content: string): Promise<ReplayResult> {
    if (!this.captured) {
      return { success: false, reason: 'No captured request available.' };
    }

    // Check token TTL
    const age = Date.now() - this.captured.capturedAt;
    if (age > TOKEN_TTL_MS) {
      this.captured = null;
      return { success: false, reason: 'Captured token expired (>25 min). Re-add a source manually to refresh.' };
    }

    // Build sanitized headers
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.captured.headers)) {
      if (HEADER_ALLOW_LIST.has(key.toLowerCase())) {
        sanitizedHeaders[key] = value;
      }
    }

    // Construct new body — replace content in the captured body
    let newBody: string;
    try {
      const parsed = JSON.parse(this.captured.body);
      // NLM's add-source body typically has a content/text field;
      // we replace any string value that looks like source content.
      newBody = JSON.stringify(this.replaceContentInPayload(parsed, content));
    } catch {
      // If the body isn't JSON, inject content as-is
      newBody = content;
    }

    try {
      const response = await fetch(this.captured.url, {
        method: this.captured.method,
        headers: sanitizedHeaders,
        body: newBody,
      });

      if (response.ok) {
        return { success: true };
      }
      return { success: false, reason: `API returned ${response.status}: ${response.statusText}` };
    } catch (err) {
      return {
        success: false,
        reason: `Fetch replay failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Recursively walk the parsed JSON body and replace the largest
   * string value (assumed to be the source content) with new content.
   */
  private replaceContentInPayload(obj: unknown, content: string): unknown {
    if (typeof obj !== 'object' || obj === null) return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.replaceContentInPayload(item, content));
    }

    const record = obj as Record<string, unknown>;
    let longestKey: string | null = null;
    let longestLen = 0;

    // Find the longest string value — that's almost certainly the source text
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && value.length > longestLen) {
        longestLen = value.length;
        longestKey = key;
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === longestKey && typeof value === 'string') {
        result[key] = content;
      } else {
        result[key] = this.replaceContentInPayload(value, content);
      }
    }
    return result;
  }
}
