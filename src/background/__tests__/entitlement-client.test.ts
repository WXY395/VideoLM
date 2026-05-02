import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEntitlementSnapshot, UserSettings } from '@/types';

const storageData: Record<string, unknown> = {};

const chromeMock = {
  runtime: {
    getManifest: vi.fn(() => ({ version: '0.3.1' })),
  },
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

(globalThis as any).chrome = chromeMock;

const { reserveEntitledQuota } = await import('../entitlement-client');
const { STORAGE_KEY } = await import('../usage-tracker');

function clearStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
}

function snapshot(overrides: Partial<ServerEntitlementSnapshot> = {}): ServerEntitlementSnapshot {
  return {
    subjectId: 'install:test',
    plan: 'free',
    periodStart: '2099-01-01',
    periodEnd: '2099-02-01',
    limits: { imports: 100, aiCalls: 0 },
    usage: { imports: 0, aiCalls: 0 },
    ...overrides,
  };
}

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    tier: 'free',
    defaultMode: 'raw',
    duplicateStrategy: 'ask',
    monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2099-02-01' },
    entitlement: {
      backendUrl: 'https://api.test',
    },
    ...overrides,
  };
}

describe('entitlement-client', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a fresh install and reserves server quota', async () => {
    storageData[STORAGE_KEY] = makeSettings();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'token-1',
        entitlement: snapshot(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        allowed: true,
        remaining: 99,
        entitlement: snapshot({ usage: { imports: 1, aiCalls: 0 } }),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reserveEntitledQuota('imports', 1, 'res-1');

    expect(result.allowed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updated = storageData[STORAGE_KEY] as UserSettings;
    expect(updated.entitlement?.authToken).toBe('token-1');
    expect(updated.monthlyUsage.imports).toBe(1);
  });

  it('does not allow quota when the server is unavailable', async () => {
    storageData[STORAGE_KEY] = makeSettings();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const result = await reserveEntitledQuota('imports', 1, 'res-2');

    expect(result.ok).toBe(false);
    expect(result.allowed).toBe(false);
  });

  it('re-registers once when an existing token is rejected', async () => {
    storageData[STORAGE_KEY] = makeSettings({
      entitlement: {
        backendUrl: 'https://api.test',
        installId: 'install-1',
        authToken: 'expired',
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'token-2',
        entitlement: snapshot(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        allowed: true,
        remaining: 98,
        entitlement: snapshot({ usage: { imports: 2, aiCalls: 0 } }),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reserveEntitledQuota('imports', 2, 'res-3');

    expect(result.allowed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const updated = storageData[STORAGE_KEY] as UserSettings;
    expect(updated.entitlement?.authToken).toBe('token-2');
    expect(updated.monthlyUsage.imports).toBe(2);
  });
});
