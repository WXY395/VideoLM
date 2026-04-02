import type { UserSettings } from '@/types';

export const STORAGE_KEY = 'videolm_settings';

/**
 * Compute the first day of next month as an ISO date string (YYYY-MM-DD).
 */
function getFirstOfNextMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 2; // +1 for 0-index, +1 for next month
  // Build the string directly to avoid timezone-shift issues with toISOString()
  const y = month > 12 ? year + 1 : year;
  const m = month > 12 ? 1 : month;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/**
 * Default user settings for a fresh install.
 */
export const defaultSettings: UserSettings = {
  tier: 'free',
  defaultMode: 'raw',
  duplicateStrategy: 'ask',
  monthlyUsage: {
    imports: 0,
    aiCalls: 0,
    resetDate: getFirstOfNextMonth(),
  },
};

/**
 * Retrieve user settings from chrome.storage.local.
 * Auto-resets monthly usage if the current date is past the resetDate.
 */
export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const settings: UserSettings = result[STORAGE_KEY] ?? {
    ...defaultSettings,
    monthlyUsage: { ...defaultSettings.monthlyUsage, resetDate: getFirstOfNextMonth() },
  };

  // Auto-reset monthly usage if past resetDate
  const now = new Date();
  const resetDate = new Date(settings.monthlyUsage.resetDate);
  if (now >= resetDate) {
    settings.monthlyUsage = {
      imports: 0,
      aiCalls: 0,
      resetDate: getFirstOfNextMonth(),
    };
    await saveSettings(settings);
  }

  return settings;
}

/**
 * Persist user settings to chrome.storage.local.
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

/**
 * Increment a usage counter (imports or aiCalls) and persist.
 */
export async function incrementUsage(type: 'imports' | 'aiCalls', count = 1): Promise<void> {
  const settings = await getSettings();
  settings.monthlyUsage[type] += count;
  await saveSettings(settings);
}

/**
 * Check whether the user can import and/or use AI based on their tier and usage.
 *
 * Limits:
 *   - Free:       100 imports/month, 0 AI calls (unless BYOK)
 *   - Free+BYOK:  300 imports/month, unlimited AI (user pays)
 *   - Pro:        unlimited everything
 */
export function checkQuota(settings: UserSettings): { canImport: boolean; canUseAI: boolean } {
  if (settings.tier === 'pro') {
    return { canImport: true, canUseAI: true };
  }

  const hasBYOK = Boolean(settings.byok?.apiKey);
  const importLimit = hasBYOK ? 300 : 100;

  return {
    canImport: settings.monthlyUsage.imports < importLimit,
    canUseAI: hasBYOK,
  };
}
