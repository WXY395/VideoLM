import '@testing-library/jest-dom/vitest';

// Mock chrome.i18n for test environment — returns the key as the message
// This allows tests to assert on i18n keys rather than translated text
if (typeof globalThis.chrome === 'undefined') {
  (globalThis as any).chrome = {};
}
if (!globalThis.chrome.i18n) {
  (globalThis as any).chrome.i18n = {
    getMessage: (key: string, _subs?: string | string[]) => key,
    getUILanguage: () => 'en',
  };
}
// Ensure chrome.storage.session exists (used by toast.ts)
if (!globalThis.chrome.storage) {
  (globalThis as any).chrome.storage = {
    session: {
      get: (_key: string, cb: (r: any) => void) => cb({}),
      set: (_data: any) => {},
    },
    local: {
      get: (_key: string) => Promise.resolve({}),
      set: (_data: any) => Promise.resolve(),
    },
  };
}
