import type { UserSettings } from '@/types';

export const STORAGE_KEY = 'videolm_settings';
export const DEFAULT_BACKEND_URL = 'https://api.videolm.workers.dev';

const FREE_IMPORT_LIMIT = 100;
const FREE_BYOK_IMPORT_LIMIT = 300;

let usageMutationQueue: Promise<unknown> = Promise.resolve();

function withUsageLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = usageMutationQueue.then(operation, operation);
  usageMutationQueue = run.catch(() => {});
  return run;
}

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
  entitlement: {
    backendUrl: DEFAULT_BACKEND_URL,
  },
  obsidian: {
    fileNameTemplate: '{{title}} - {{date}}',
    defaultTags: ['videolm', 'notebooklm'],
    includeEvidenceMap: true,
    includeFollowups: true,
    includeSources: true,
    citationStyle: 'footnotes',
  },
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
  const savedSettings = result[STORAGE_KEY] as UserSettings | undefined;
  const settings: UserSettings = savedSettings ? {
    ...defaultSettings,
    ...savedSettings,
    obsidian: {
      ...defaultSettings.obsidian!,
      ...(savedSettings.obsidian ?? {}),
    },
    entitlement: {
      ...defaultSettings.entitlement!,
      ...(savedSettings.entitlement ?? {}),
    },
    monthlyUsage: {
      ...defaultSettings.monthlyUsage,
      ...savedSettings.monthlyUsage,
    },
  } : {
    ...defaultSettings,
    obsidian: { ...defaultSettings.obsidian! },
    entitlement: { ...defaultSettings.entitlement! },
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
 * Persist user-editable preferences without allowing UI messages to overwrite
 * entitlement or usage counters.
 */
export async function saveUserPreferences(incoming: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  const next: UserSettings = {
    ...current,
    defaultMode: incoming.defaultMode ?? current.defaultMode,
    defaultTranslateLang: incoming.defaultTranslateLang,
    outputLanguage: incoming.outputLanguage ?? current.outputLanguage,
    duplicateStrategy: incoming.duplicateStrategy ?? current.duplicateStrategy,
    byok: incoming.byok,
    entitlement: {
      ...current.entitlement!,
      backendUrl: incoming.entitlement?.backendUrl ?? current.entitlement?.backendUrl ?? DEFAULT_BACKEND_URL,
      licenseKey: incoming.entitlement?.licenseKey ?? current.entitlement?.licenseKey,
    },
    obsidian: {
      ...current.obsidian!,
      ...(incoming.obsidian ?? {}),
    },
    tier: current.tier,
    monthlyUsage: current.monthlyUsage,
  };

  await saveSettings(next);
}

/**
 * Increment a usage counter (imports or aiCalls) and persist.
 */
export async function incrementUsage(type: 'imports' | 'aiCalls', count = 1): Promise<void> {
  await withUsageLock(async () => {
    const settings = await getSettings();
    settings.monthlyUsage[type] += count;
    await saveSettings(settings);
  });
}

function getImportLimit(settings: UserSettings): number | null {
  if (settings.tier === 'pro') return null;
  return settings.byok?.apiKey ? FREE_BYOK_IMPORT_LIMIT : FREE_IMPORT_LIMIT;
}

export interface ImportQuotaReservation {
  allowed: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

/**
 * Reserve import quota before direct NotebookLM imports. This prevents Quick,
 * Batch, and resumed imports from passing quota checks concurrently and then
 * all writing usage afterward.
 */
export async function reserveImportQuota(count = 1): Promise<ImportQuotaReservation> {
  return withUsageLock(async () => {
    const settings = await getSettings();
    const limit = getImportLimit(settings);
    const used = settings.monthlyUsage.imports;
    const requested = Math.max(0, count);

    if (limit !== null && used + requested > limit) {
      return {
        allowed: false,
        limit,
        used,
        remaining: Math.max(0, limit - used),
      };
    }

    settings.monthlyUsage.imports = used + requested;
    await saveSettings(settings);

    return {
      allowed: true,
      limit,
      used: settings.monthlyUsage.imports,
      remaining: limit === null ? null : Math.max(0, limit - settings.monthlyUsage.imports),
    };
  });
}

/**
 * Return unused reserved import quota after a failed or partial direct import.
 */
export async function refundImportQuota(count = 1): Promise<void> {
  await withUsageLock(async () => {
    const settings = await getSettings();
    settings.monthlyUsage.imports = Math.max(0, settings.monthlyUsage.imports - Math.max(0, count));
    await saveSettings(settings);
  });
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

  const importLimit = getImportLimit(settings)!;

  return {
    canImport: settings.monthlyUsage.imports < importLimit,
    canUseAI: Boolean(settings.byok?.apiKey),
  };
}
