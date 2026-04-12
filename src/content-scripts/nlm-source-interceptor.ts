/**
 * NLM Source Interceptor — runs in MAIN world.
 *
 * Monkey-patches XMLHttpRequest AND fetch to passively capture YouTube source
 * URLs from NLM batchexecute responses. Sends extracted data back to the
 * isolated-world content script via window.postMessage.
 *
 * This file MUST run in the page's MAIN world (manifest "world": "MAIN")
 * because NLM's Trusted Types policy blocks inline script injection,
 * and XHR/fetch instances in the isolated world cannot see page-initiated requests.
 */

(function () {
  // Guard against double-install (SPA navigation, extension reload)
  if ((window as any).__vlm_batchInterceptInstalled) return;
  (window as any).__vlm_batchInterceptInstalled = true;

  console.log('[VideoLM][interceptor] installed at', performance.now().toFixed(1) + 'ms');

  function processResponse(text: string, transport: string): void {
    if (text.indexOf('youtube.com') !== -1) {
      console.log(`[VideoLM][interceptor] ${transport} batchexecute contains youtube, len=${text.length}`);
      window.postMessage(
        { type: '__VIDEOLM_BATCHEXECUTE__', payload: text },
        '*',
      );
    }
  }

  // --- XHR interception ---
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __vlmUrl?: string },
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    this.__vlmUrl = String(url);
    return _origOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __vlmUrl?: string },
    ...args: any[]
  ) {
    if (this.__vlmUrl && this.__vlmUrl.indexOf('batchexecute') !== -1) {
      this.addEventListener('load', function () {
        try {
          processResponse(this.responseText || '', 'XHR');
        } catch (_) {
          // Silent — never break NLM
        }
      });
    }
    return _origSend.apply(this, args as any);
  };

  // --- fetch interception ---
  const _origFetch = window.fetch;
  (window as any).fetch = function (...args: any[]) {
    const input = args[0];
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request)?.url ?? '';

    const result = _origFetch.apply(window, args as any) as Promise<Response>;

    if (url.indexOf('batchexecute') !== -1) {
      result.then((resp: Response) => {
        const clone = resp.clone();
        clone.text().then((text: string) => {
          try {
            processResponse(text, 'fetch');
          } catch (_) {
            // Silent — never break NLM
          }
        }).catch(() => { /* ignore */ });
      }).catch(() => { /* ignore */ });
    }

    return result;
  };
})();
