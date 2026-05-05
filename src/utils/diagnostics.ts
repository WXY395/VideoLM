import type { UserSettings } from '@/types';

export interface DiagnosticsInput {
  extensionVersion: string;
  uiLanguage: string;
  activeTab?: {
    url?: string;
    title?: string;
  };
  pageType?: string;
  settings: UserSettings;
  importStatus?: unknown;
  pendingQueue?: unknown;
  generatedAt?: string;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  extensionVersion: string;
  uiLanguage: string;
  activeTab: {
    host: string;
    path: string;
    title?: string;
  };
  pageType?: string;
  settings: {
    tier: UserSettings['tier'];
    defaultMode: UserSettings['defaultMode'];
    duplicateStrategy: UserSettings['duplicateStrategy'];
    outputLanguage?: string;
    byok: {
      provider?: string;
      model?: string;
      hasApiKey: boolean;
    };
    entitlement: {
      backendUrl?: string;
      hasLicenseKey: boolean;
      hasInstallId: boolean;
      hasAuthToken: boolean;
      plan?: string;
      limits?: { imports: number | null; aiCalls: number | null };
      usage?: { imports: number; aiCalls: number };
      lastSyncedAt?: number;
    };
    obsidian?: {
      fileNameTemplate: string;
      defaultTags: string[];
      includeEvidenceMap: boolean;
      includeFollowups: boolean;
      includeSources: boolean;
      citationStyle: string;
    };
    monthlyUsage: UserSettings['monthlyUsage'];
  };
  importStatus?: unknown;
  pendingQueue?: unknown;
}

function sanitizeImportStatus(status: unknown): unknown {
  if (!status || typeof status !== 'object') return status;
  const source = status as Record<string, unknown>;
  return {
    active: source.active,
    totalUrls: source.totalUrls,
    importedCount: source.importedCount,
    phase: source.phase,
    startedAt: source.startedAt,
    lastError: source.lastError,
    completed: source.completed,
    needsNewNotebook: source.needsNewNotebook,
    remainingCount: source.remainingCount,
    completedAt: source.completedAt,
  };
}

function sanitizePendingQueue(queue: unknown): unknown {
  if (!queue || typeof queue !== 'object') return queue;
  const source = queue as Record<string, unknown>;
  return {
    hasPending: source.hasPending,
    currentChunk: source.currentChunk,
    totalChunks: source.totalChunks,
    remainingUrls: source.remainingUrls,
  };
}

function summarizeActiveTab(tab?: DiagnosticsInput['activeTab']): DiagnosticsBundle['activeTab'] {
  if (!tab?.url) return { host: '', path: '', title: tab?.title };
  try {
    const url = new URL(tab.url);
    return {
      host: url.host,
      path: url.pathname,
      title: tab.title,
    };
  } catch {
    return { host: '', path: '', title: tab.title };
  }
}

export function buildDiagnosticsBundle(input: DiagnosticsInput): DiagnosticsBundle {
  const { settings } = input;
  const entitlement = settings.entitlement;
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    extensionVersion: input.extensionVersion,
    uiLanguage: input.uiLanguage,
    activeTab: summarizeActiveTab(input.activeTab),
    pageType: input.pageType,
    settings: {
      tier: settings.tier,
      defaultMode: settings.defaultMode,
      duplicateStrategy: settings.duplicateStrategy,
      outputLanguage: settings.outputLanguage,
      byok: {
        provider: settings.byok?.provider,
        model: settings.byok?.model,
        hasApiKey: Boolean(settings.byok?.apiKey),
      },
      entitlement: {
        backendUrl: entitlement?.backendUrl,
        hasLicenseKey: Boolean(entitlement?.licenseKey),
        hasInstallId: Boolean(entitlement?.installId),
        hasAuthToken: Boolean(entitlement?.authToken),
        plan: entitlement?.snapshot?.plan,
        limits: entitlement?.snapshot?.limits,
        usage: entitlement?.snapshot?.usage,
        lastSyncedAt: entitlement?.lastSyncedAt,
      },
      obsidian: settings.obsidian ? {
        fileNameTemplate: settings.obsidian.fileNameTemplate,
        defaultTags: settings.obsidian.defaultTags,
        includeEvidenceMap: settings.obsidian.includeEvidenceMap,
        includeFollowups: settings.obsidian.includeFollowups,
        includeSources: settings.obsidian.includeSources,
        citationStyle: settings.obsidian.citationStyle,
      } : undefined,
      monthlyUsage: settings.monthlyUsage,
    },
    importStatus: sanitizeImportStatus(input.importStatus),
    pendingQueue: sanitizePendingQueue(input.pendingQueue),
  };
}

export function formatDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2);
}
