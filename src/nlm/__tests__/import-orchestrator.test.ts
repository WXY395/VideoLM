import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportOrchestrator } from '../import-orchestrator';
import type { DynamicConfig, ImportResult } from '@/types';
import type { FetchInterceptor, ReplayResult } from '../fetch-interceptor';
import type { DomAutomation, DomResult } from '../dom-automation';

// ---- Helpers ----

function makeConfig(overrides: Partial<DynamicConfig['features']> = {}): DynamicConfig {
  return {
    version: '1.0.0',
    nlm: {
      selectors: {
        addSourceButton: [],
        sourceTypeMenu: [],
        copiedTextOption: [],
        textInput: [],
        urlInput: [],
        submitButton: [],
        notebookList: [],
        sourceList: [],
      },
      apiPatterns: { addSource: '', listNotebooks: '' },
    },
    features: {
      fetchInterceptEnabled: true,
      domAutomationEnabled: true,
      maxBatchSize: 10,
      ...overrides,
    },
  };
}

function mockFetchInterceptor(armed: boolean, replayResult: ReplayResult) {
  return {
    isArmed: vi.fn(() => armed),
    replay: vi.fn(async () => replayResult),
    setCaptured: vi.fn(),
    getInstallScript: vi.fn(() => ''),
  } as unknown as FetchInterceptor;
}

function mockDomAutomation(result: DomResult) {
  return {
    addSource: vi.fn(async () => result),
    getSourceList: vi.fn(() => []),
    findElement: vi.fn(() => null),
    safeInput: vi.fn(),
  } as unknown as DomAutomation;
}

// ---- Tests ----

describe('ImportOrchestrator', () => {
  const clipboardWrite = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns tier 1 when fetch replay succeeds', async () => {
    const interceptor = mockFetchInterceptor(true, { success: true });
    const dom = mockDomAutomation({ success: true });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig(),
      clipboardWrite,
    });

    const result = await orch.importContent('test content');

    expect(result.success).toBe(true);
    expect(result.tier).toBe(1);
    expect(interceptor.replay).toHaveBeenCalledWith('test content');
    // DOM and clipboard should NOT have been called
    expect(dom.addSource).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('falls back to tier 2 when fetch replay fails', async () => {
    const interceptor = mockFetchInterceptor(true, { success: false, reason: 'expired' });
    const dom = mockDomAutomation({ success: true });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig(),
      clipboardWrite,
    });

    const result = await orch.importContent('test content');

    expect(result.success).toBe(true);
    expect(result.tier).toBe(2);
    expect(dom.addSource).toHaveBeenCalledWith('test content');
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('falls back to tier 3 when both tier 1 and tier 2 fail', async () => {
    const interceptor = mockFetchInterceptor(true, { success: false, reason: 'err' });
    const dom = mockDomAutomation({ success: false, reason: 'button not found' });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig(),
      clipboardWrite,
    });

    const result = await orch.importContent('test content');

    expect(result.success).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.manual).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledWith('test content');
  });

  it('falls back to tier 3 when tier 1 throws', async () => {
    const interceptor = mockFetchInterceptor(true, { success: true });
    (interceptor.replay as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    const dom = mockDomAutomation({ success: false, reason: 'fail' });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig(),
      clipboardWrite,
    });

    const result = await orch.importContent('test');

    expect(result.tier).toBe(3);
    expect(result.manual).toBe(true);
  });

  it('skips tier 1 when fetchInterceptEnabled is false', async () => {
    const interceptor = mockFetchInterceptor(true, { success: true });
    const dom = mockDomAutomation({ success: true });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig({ fetchInterceptEnabled: false }),
      clipboardWrite,
    });

    const result = await orch.importContent('test');

    expect(result.tier).toBe(2);
    expect(interceptor.replay).not.toHaveBeenCalled();
  });

  it('skips tier 2 when domAutomationEnabled is false', async () => {
    const interceptor = mockFetchInterceptor(true, { success: false });
    const dom = mockDomAutomation({ success: true });
    const orch = new ImportOrchestrator({
      fetchInterceptor: interceptor,
      domAutomation: dom,
      config: makeConfig({ domAutomationEnabled: false }),
      clipboardWrite,
    });

    const result = await orch.importContent('test');

    expect(result.tier).toBe(3);
    expect(dom.addSource).not.toHaveBeenCalled();
  });

  it('skips both tiers when both are disabled, goes straight to tier 3', async () => {
    const orch = new ImportOrchestrator({
      config: makeConfig({ fetchInterceptEnabled: false, domAutomationEnabled: false }),
      clipboardWrite,
    });

    const result = await orch.importContent('test');

    expect(result.success).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.manual).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledWith('test');
  });

  it('returns error when clipboard write fails', async () => {
    const failClipboard = vi.fn(async () => {
      throw new Error('Permission denied');
    });
    const orch = new ImportOrchestrator({
      config: makeConfig({ fetchInterceptEnabled: false, domAutomationEnabled: false }),
      clipboardWrite: failClipboard,
    });

    const result = await orch.importContent('test');

    expect(result.success).toBe(false);
    expect(result.tier).toBe(3);
    expect(result.error).toContain('Permission denied');
  });

  describe('importBatch', () => {
    it('calls onProgress for each item', async () => {
      const orch = new ImportOrchestrator({
        config: makeConfig({ fetchInterceptEnabled: false, domAutomationEnabled: false }),
        clipboardWrite,
      });

      const onProgress = vi.fn();
      const items = [
        { title: 'A', content: 'content-a' },
        { title: 'B', content: 'content-b' },
      ];

      const results = await orch.importBatch(items, onProgress);

      expect(results).toHaveLength(2);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(0, expect.objectContaining({ tier: 3 }));
      expect(onProgress).toHaveBeenCalledWith(1, expect.objectContaining({ tier: 3 }));
    });

    it('respects maxBatchSize', async () => {
      const orch = new ImportOrchestrator({
        config: makeConfig({
          fetchInterceptEnabled: false,
          domAutomationEnabled: false,
          maxBatchSize: 2,
        }),
        clipboardWrite,
      });

      const items = [
        { title: 'A', content: 'a' },
        { title: 'B', content: 'b' },
        { title: 'C', content: 'c' },
      ];

      const results = await orch.importBatch(items);

      expect(results).toHaveLength(2); // maxBatchSize = 2, third item skipped
    });
  });
});
