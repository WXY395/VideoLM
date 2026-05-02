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
const {
  getSettings,
  saveSettings,
  saveUserPreferences,
  incrementUsage,
  reserveImportQuota,
  refundImportQuota,
  checkQuota,
  STORAGE_KEY,
  defaultSettings,
} =
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
    duplicateStrategy: 'ask',
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

  // ---- saveUserPreferences -----------------------------------------------
  describe('saveUserPreferences', () => {
    it('does not allow preference saves to overwrite tier or monthly usage', async () => {
      storageData[STORAGE_KEY] = makeSettings({
        tier: 'pro',
        defaultMode: 'raw',
        monthlyUsage: { imports: 42, aiCalls: 7, resetDate: '2099-01-01' },
      });

      await saveUserPreferences(makeSettings({
        tier: 'free',
        defaultMode: 'summary',
        monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2099-01-01' },
      }));

      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.tier).toBe('pro');
      expect(updated.defaultMode).toBe('summary');
      expect(updated.monthlyUsage.imports).toBe(42);
      expect(updated.monthlyUsage.aiCalls).toBe(7);
    });

    it('preserves server-owned entitlement fields while saving editable license fields', async () => {
      storageData[STORAGE_KEY] = makeSettings({
        tier: 'pro',
        entitlement: {
          backendUrl: 'https://api.old',
          installId: 'install-1',
          authToken: 'server-token',
          licenseKey: 'OLD-LICENSE',
          snapshot: {
            subjectId: 'license:abc',
            plan: 'pro',
            periodStart: '2099-01-01',
            periodEnd: '2099-02-01',
            limits: { imports: null, aiCalls: null },
            usage: { imports: 12, aiCalls: 3 },
          },
          lastSyncedAt: 123,
        },
      });

      await saveUserPreferences({
        entitlement: {
          backendUrl: 'https://api.new',
          licenseKey: 'NEW-LICENSE',
        } as any,
      });

      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.entitlement?.backendUrl).toBe('https://api.new');
      expect(updated.entitlement?.licenseKey).toBe('NEW-LICENSE');
      expect(updated.entitlement?.installId).toBe('install-1');
      expect(updated.entitlement?.authToken).toBe('server-token');
      expect(updated.entitlement?.snapshot?.plan).toBe('pro');
      expect(updated.entitlement?.lastSyncedAt).toBe(123);
      expect(updated.tier).toBe('pro');
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

  // ---- reserveImportQuota / refundImportQuota ----------------------------
  describe('reserveImportQuota', () => {
    it('reserves multiple imports atomically before a direct NLM import', async () => {
      storageData[STORAGE_KEY] = makeSettings({
        monthlyUsage: { imports: 98, aiCalls: 0, resetDate: '2099-01-01' },
      });

      const result = await reserveImportQuota(2);

      expect(result.allowed).toBe(true);
      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.monthlyUsage.imports).toBe(100);
    });

    it('blocks reservations that would exceed the monthly import limit', async () => {
      storageData[STORAGE_KEY] = makeSettings({
        monthlyUsage: { imports: 99, aiCalls: 0, resetDate: '2099-01-01' },
      });

      const result = await reserveImportQuota(2);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(1);
      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.monthlyUsage.imports).toBe(99);
    });
  });

  describe('refundImportQuota', () => {
    it('refunds reserved imports without going below zero', async () => {
      storageData[STORAGE_KEY] = makeSettings({
        monthlyUsage: { imports: 3, aiCalls: 0, resetDate: '2099-01-01' },
      });

      await refundImportQuota(5);

      const updated = storageData[STORAGE_KEY] as UserSettings;
      expect(updated.monthlyUsage.imports).toBe(0);
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

    it('free tier: blocks imports at limit', () => {
      const settings = makeSettings({
        monthlyUsage: { imports: 100, aiCalls: 0, resetDate: '2099-01-01' },
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

    it('free+BYOK: blocks imports at limit', () => {
      const settings = makeSettings({
        byok: { provider: 'openai', apiKey: 'sk-test' },
        monthlyUsage: { imports: 300, aiCalls: 0, resetDate: '2099-01-01' },
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
