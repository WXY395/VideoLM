/**
 * i18n helper — wraps chrome.i18n.getMessage with graceful fallback.
 *
 * Usage:
 *   import { t } from '@/utils/i18n';
 *   t('toast_importing')            // → "Importing..." or "正在匯入..."
 *   t('toast_count', ['23'])        // → "Importing 23 videos..."
 *   t('toast_count', '23')          // → same (string auto-wrapped)
 */

/** Check if a key exists in the current locale */
export const has = (key: string): boolean =>
  chrome.i18n.getMessage(key) !== '';

/** Core translation helper — shows [key] on missing keys instead of crashing */
export const t = (key: string, subs?: string | string[]): string => {
  // Guard for test environments where chrome.i18n may not exist
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return `[${key}]`;
  const substitutions = typeof subs === 'string' ? [subs] : subs;
  return chrome.i18n.getMessage(key, substitutions) || `[${key}]`;
};
