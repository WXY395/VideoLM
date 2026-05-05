import { describe, expect, it } from 'vitest';
import { buildDiagnosticsBundle, formatDiagnosticsBundle } from '../diagnostics';
import type { UserSettings } from '@/types';

const settings: UserSettings = {
  tier: 'pro',
  byok: {
    provider: 'openai',
    apiKey: 'sk-secret',
    model: 'gpt-4o-mini',
  },
  defaultMode: 'quick',
  duplicateStrategy: 'ask',
  outputLanguage: 'zh-TW',
  entitlement: {
    backendUrl: 'https://api.videolm.workers.dev',
    installId: 'install-secret',
    authToken: 'auth-secret',
    licenseKey: 'VL-secret',
    snapshot: {
      subjectId: 'license:secret-subject',
      plan: 'pro',
      periodStart: '2026-05-01',
      periodEnd: '2026-06-01',
      limits: { imports: null, aiCalls: null },
      usage: { imports: 12, aiCalls: 2 },
    },
    lastSyncedAt: 123456,
  },
  obsidian: {
    fileNameTemplate: '{{title}} - {{date}}',
    defaultTags: ['videolm', 'notebooklm'],
    includeEvidenceMap: true,
    includeFollowups: false,
    includeSources: true,
    citationStyle: 'footnotes',
  },
  monthlyUsage: {
    imports: 12,
    aiCalls: 2,
    resetDate: '2026-06-01',
  },
};

describe('diagnostics bundle', () => {
  it('redacts secrets while preserving support-useful settings summary', () => {
    const bundle = buildDiagnosticsBundle({
      extensionVersion: '0.4.1',
      uiLanguage: 'zh-TW',
      activeTab: {
        url: 'https://www.youtube.com/watch?v=abc123',
        title: 'Example Video - YouTube',
      },
      pageType: 'watch',
      settings,
      importStatus: {
        active: false,
        lastError: 'Cannot connect to NotebookLM',
        pageTitle: 'Private playlist title',
      },
      pendingQueue: {
        hasPending: true,
        remainingUrls: 30,
        pageTitle: 'Private queue title',
      },
    });

    const formatted = formatDiagnosticsBundle(bundle);

    expect(formatted).toContain('"extensionVersion": "0.4.1"');
    expect(formatted).toContain('"pageType": "watch"');
    expect(formatted).toContain('"tier": "pro"');
    expect(formatted).toContain('"provider": "openai"');
    expect(formatted).toContain('"hasApiKey": true');
    expect(formatted).toContain('"hasLicenseKey": true');
    expect(formatted).toContain('"remainingUrls": 30');
    expect(formatted).not.toContain('abc123');
    expect(formatted).not.toContain('Private playlist title');
    expect(formatted).not.toContain('Private queue title');
    expect(formatted).not.toContain('sk-secret');
    expect(formatted).not.toContain('VL-secret');
    expect(formatted).not.toContain('auth-secret');
    expect(formatted).not.toContain('install-secret');
    expect(formatted).not.toContain('secret-subject');
  });
});
