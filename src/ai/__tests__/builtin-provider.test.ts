import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuiltinProvider } from '../providers/builtin';

describe('BuiltinProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when the backend returns a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('pro required', { status: 403 })));
    const provider = new BuiltinProvider('token', 'https://api.test');

    await expect(provider.summarize('text', 'Title', 'summary', 'en')).rejects.toThrow('Backend error (403)');
  });

  it('throws when the backend summary payload has no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const provider = new BuiltinProvider('token', 'https://api.test');

    await expect(provider.summarize('text', 'Title', 'summary', 'en')).rejects.toThrow('empty summary');
  });
});
