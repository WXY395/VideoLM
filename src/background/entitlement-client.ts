import type {
  EntitlementSettings,
  QuotaOperation,
  ServerEntitlementSnapshot,
  UserSettings,
} from '@/types';
import { DEFAULT_BACKEND_URL, getSettings, saveSettings } from './usage-tracker';

interface RegisterResponse {
  token: string;
  entitlement: ServerEntitlementSnapshot;
}

interface QuotaResponse {
  allowed: boolean;
  entitlement: ServerEntitlementSnapshot;
  remaining: number | null;
  error?: string;
}

export interface EntitledQuotaResult {
  ok: boolean;
  allowed: boolean;
  reservationId?: string;
  entitlement?: ServerEntitlementSnapshot;
  remaining?: number | null;
  error?: string;
}

function makeInstallId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `install-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeBackendUrl(url?: string): string {
  return (url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
}

function makeReservationId(operation: QuotaOperation): string {
  return `${operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function saveEntitlementPatch(patch: Partial<EntitlementSettings> & { snapshot?: ServerEntitlementSnapshot }): Promise<UserSettings> {
  const current = await getSettings();
  const next: UserSettings = {
    ...current,
    tier: patch.snapshot?.plan ?? current.tier,
    monthlyUsage: patch.snapshot
      ? {
          imports: patch.snapshot.usage.imports,
          aiCalls: patch.snapshot.usage.aiCalls,
          resetDate: patch.snapshot.periodEnd,
        }
      : current.monthlyUsage,
    entitlement: {
      ...current.entitlement!,
      ...patch,
      lastSyncedAt: Date.now(),
    },
  };
  await saveSettings(next);
  return next;
}

async function ensureInstallId(settings: UserSettings): Promise<UserSettings> {
  if (settings.entitlement?.installId) return settings;
  return saveEntitlementPatch({ installId: makeInstallId() });
}

async function registerEntitlement(settings: UserSettings): Promise<UserSettings> {
  const withInstallId = await ensureInstallId(settings);
  const entitlement = withInstallId.entitlement!;
  const backendUrl = normalizeBackendUrl(entitlement.backendUrl);
  const response = await fetch(`${backendUrl}/api/entitlements/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installId: entitlement.installId,
      licenseKey: entitlement.licenseKey,
      extensionVersion: chrome.runtime.getManifest().version,
    }),
  });

  if (!response.ok) {
    return Promise.reject(new Error(`entitlement_register_failed:${response.status}`));
  }

  const data = await response.json() as RegisterResponse;
  return saveEntitlementPatch({
    authToken: data.token,
    snapshot: data.entitlement,
  });
}

async function getRegisteredSettings(): Promise<UserSettings> {
  const settings = await getSettings();
  if (settings.entitlement?.authToken) return settings;
  return registerEntitlement(settings);
}

async function reserveWithToken(
  settings: UserSettings,
  operation: QuotaOperation,
  count: number,
  reservationId: string,
): Promise<Response> {
  const entitlement = settings.entitlement!;
  const backendUrl = normalizeBackendUrl(entitlement.backendUrl);
  return fetch(`${backendUrl}/api/quota/reserve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${entitlement.authToken}`,
    },
    body: JSON.stringify({ operation, count, reservationId }),
  });
}

export async function reserveEntitledQuota(
  operation: QuotaOperation,
  count = 1,
  reservationId = makeReservationId(operation),
): Promise<EntitledQuotaResult> {
  try {
    let settings = await getRegisteredSettings();
    let response = await reserveWithToken(settings, operation, count, reservationId);
    if (response.status === 401) {
      settings = await registerEntitlement(settings);
      response = await reserveWithToken(settings, operation, count, reservationId);
    }

    if (!response.ok) {
      return { ok: false, allowed: false, reservationId, error: `quota_reserve_failed:${response.status}` };
    }

    const data = await response.json() as QuotaResponse;
    await saveEntitlementPatch({ snapshot: data.entitlement });
    return {
      ok: true,
      allowed: data.allowed,
      reservationId,
      entitlement: data.entitlement,
      remaining: data.remaining,
      error: data.error,
    };
  } catch (err) {
    return {
      ok: false,
      allowed: false,
      reservationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refundEntitledQuota(
  operation: QuotaOperation,
  reservationId: string,
  count?: number,
): Promise<void> {
  try {
    const settings = await getRegisteredSettings();
    const entitlement = settings.entitlement;
    if (!entitlement || !entitlement.authToken) return;
    const backendUrl = normalizeBackendUrl(entitlement.backendUrl);
    const response = await fetch(`${backendUrl}/api/quota/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entitlement.authToken}`,
      },
      body: JSON.stringify({ operation, reservationId, count }),
    });
    if (!response.ok) return;
    const data = await response.json() as QuotaResponse;
    if (data.entitlement) {
      await saveEntitlementPatch({ snapshot: data.entitlement });
    }
  } catch {
    // Best-effort refund. The backend reservation id keeps duplicate retries safe.
  }
}

export async function refreshServerEntitlement(): Promise<ServerEntitlementSnapshot | null> {
  const settings = await getRegisteredSettings();
  const entitlement = settings.entitlement;
  if (!entitlement || !entitlement.authToken) return null;
  const backendUrl = normalizeBackendUrl(entitlement.backendUrl);
  const response = await fetch(`${backendUrl}/api/entitlements/me`, {
    headers: { Authorization: `Bearer ${entitlement.authToken}` },
  });
  if (!response.ok) return null;
  const data = await response.json() as { entitlement: ServerEntitlementSnapshot };
  await saveEntitlementPatch({ snapshot: data.entitlement });
  return data.entitlement;
}

export async function reRegisterServerEntitlement(): Promise<ServerEntitlementSnapshot> {
  const settings = await registerEntitlement(await getSettings());
  if (!settings.entitlement?.snapshot) {
    throw new Error('entitlement_register_missing_snapshot');
  }
  return settings.entitlement.snapshot;
}
