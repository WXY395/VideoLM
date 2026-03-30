import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserSettings } from '@/types';

// ---------------------------------------------------------------------------
// Chrome storage mock
// ---------------------------------------------------------------------------
const storageData: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn((keys: string | string[]) => {
        const result: Record<string, unknown> = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          if (k in storageData) result[k] = storageData[k];
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((items: Record<string, unknown>) => {
        Object.assign(storageData, items);
        return Promise.resolve();
      }),
    },
  },
};

// Assign to globalThis before importing the module under test
(globalThis as any).chrome = chromeMock;

// Dynamic import so chrome mock is in place first
const { getSettings, saveSettings, incrementUsage, checkQuota, STORAGE_KEY, defaultSettings } =
  await import('../usage-tracker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clearStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
}

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    tier: 'free',
    defaultMode: 'raw',
    monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2099-01-01' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('usage-tracker', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  // ---- getSettings --------------------------------------------------------
  describe('getSettings', () => {
    it('returns default settings when storage is empty', async () => {
      const settings = await getSettings();
      expect(settings.tier).toBe('free');
      expect(settings.defaultMode).toBe('raw');
      expect(settings.monthlyUsage.imports).toBe(0);
      expect(settings.monthlyUsage.aiCalls).toBe(0);
    });

    it('returns stored settings when present', async () => {
      const saved = makeSettings({ tier: 'pro', defaultMode: 'summary' });
      storageData[STORAGE_KEY] = saved;

      const settings = await getSettings();
      expect(settings.tier).toBe('pro');
      expect(settings.defaultMode).toBe('summary');
    });

    it('auto-resets monthly usage when past resetDate', async () => {
      const pastDate = '2020-01-01';
      const saved = makeSettings({
        monthlyUsage: { imports: 8, aiCalls: 5, resetDate: pastDate },
      });
      storageData[STORAGE_KEY] = saved;

      const settings = await getSettings();
      expect(settings.monthlyUsage.imports).toBe(0);
      expect(settings.monthlyUsage.aiCalls).toBe(0);
      // resetDate should be first of next month (YYYY-MM-01 format)
      expect(settings.monthlyUsage.resetDate).toMatch(/^\d{4}-\d{2}-01$/);
      // The reset date should be in the future
      const [y, m] = settings.monthlyUsage.resetDate.split('-').map(Number);
      const now = new Date();
      const resetLocal = new Date(y, m - 1, 1);
      expect(resetLocal > now).toBe(true);
    });
  });

  // ---- saveSettings -------------------------------------------------------
  describe('saveSettings', () => {
    it('persists settings to storage', async () => {
      const settings = makeSettings({ tier: 'pro' });
      await saveSettings(settings);
      expect(storageData[STORAGE_KEY]).toEqual(settings);
    });
  });

  // ---- incrementUsage -----------------------------------------------------
  describe('incrementUsage', () => {
    it('increments imports counter', async () => {
      const settings = makeSettings();
      storageData[STORAGE_KEY] = settings;

      await incrementUsage('imports');
      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.monthlyUsage.imports).toBe(1);
    });

    it('increments aiCalls counter', async () => {
      const settings = makeSettings();
      storageData[STORAGE_KEY] = settings;

      await incrementUsage('aiCalls');
      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.monthlyUsage.aiCalls).toBe(1);
    });
  });

  // ---- checkQuota ---------------------------------------------------------
  describe('checkQuota', () => {
    it('free tier: allows up to 10 imports, no AI', () => {
      const settings = makeSettings({
        monthlyUsage: { imports: 9, aiCalls: 0, resetDate: '2099-01-01' },
      });
      const quota = checkQuota(settings);
      expect(quota.canImport).toBe(true);
      expect(quota.canUseAI).toBe(false);
    });

    it('free tier: blocks imports at 10', () => {
      const settings = makeSettings({
        monthlyUsage: { imports: 10, aiCalls: 0, resetDate: '2099-01-01' },
      });
      const quota = checkQuota(settings);
      expect(quota.canImport).toBe(false);
    });

    it('free+BYOK: allows 30 imports and unlimited AI', () => {
      const settings = makeSettings({
        byok: { provider: 'openai', apiKey: 'sk-test' },
        monthlyUsage: { imports: 29, aiCalls: 999, resetDate: '2099-01-01' },
      });
      const quota = checkQuota(settings);
      expect(quota.canImport).toBe(true);
      expect(quota.canUseAI).toBe(true);
    });

    it('free+BYOK: blocks imports at 30', () => {
      const settings = makeSettings({
        byok: { provider: 'openai', apiKey: 'sk-test' },
        monthlyUsage: { imports: 30, aiCalls: 0, resetDate: '2099-01-01' },
      });
      const quota = checkQuota(settings);
      expect(quota.canImport).toBe(false);
    });

    it('pro tier: unlimited everything', () => {
      const settings = makeSettings({
        tier: 'pro',
        monthlyUsage: { imports: 9999, aiCalls: 9999, resetDate: '2099-01-01' },
      });
      const quota = checkQuota(settings);
      expect(quota.canImport).toBe(true);
      expect(quota.canUseAI).toBe(true);
    });
  });
});
