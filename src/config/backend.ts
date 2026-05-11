export const DEFAULT_BACKEND_URL = 'https://videolm-api.videolm.workers.dev';

export const LEGACY_BACKEND_URLS = [
  'https://api.videolm.workers.dev',
  'https://videolm-api.a0970292729.workers.dev',
] as const;

export function normalizeBackendUrl(url?: string): string {
  return (url || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, '');
}

export function migrateBackendUrl(url?: string): string {
  const normalized = normalizeBackendUrl(url);
  return LEGACY_BACKEND_URLS.includes(normalized as typeof LEGACY_BACKEND_URLS[number])
    ? DEFAULT_BACKEND_URL
    : normalized;
}
