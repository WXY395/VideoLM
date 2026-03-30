import type { DynamicConfig } from '@/types';

const CONFIG_CACHE_KEY = 'videolm_config_cache';
const CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CONFIG_ENDPOINT = '/api/config';

/** Hardcoded fallback when backend is unreachable */
const DEFAULT_CONFIG: DynamicConfig = {
  version: '0.1.0',
  nlm: {
    selectors: {
      addSourceButton: ['button[aria-label="Add source"]', 'button.add-source'],
      sourceTypeMenu: ['[data-source-type-menu]', '.source-type-menu'],
      copiedTextOption: ['[data-source-type="text"]', '.copied-text-option'],
      textInput: ['textarea[aria-label="Paste text"]', '.text-input textarea'],
      urlInput: ['input[type="url"]', '.url-input input'],
      submitButton: ['button[aria-label="Insert"]', 'button.submit-source'],
      notebookList: ['.notebook-list', '[data-notebook-list]'],
      sourceList: ['.source-list', '[data-source-list]'],
    },
    apiPatterns: {
      addSource: 'https://notebooklm.google.com/api/source',
      listNotebooks: 'https://notebooklm.google.com/api/notebooks',
    },
  },
  features: {
    fetchInterceptEnabled: true,
    domAutomationEnabled: true,
    maxBatchSize: 10,
  },
};

interface CachedConfig {
  config: DynamicConfig;
  timestamp: number;
}

async function getCachedConfig(): Promise<DynamicConfig | null> {
  try {
    const result = await chrome.storage.local.get(CONFIG_CACHE_KEY);
    const cached: CachedConfig | undefined = result[CONFIG_CACHE_KEY];
    if (!cached) return null;

    const isExpired = Date.now() - cached.timestamp > CONFIG_CACHE_TTL;
    if (isExpired) return null;

    return cached.config;
  } catch {
    return null;
  }
}

async function setCachedConfig(config: DynamicConfig): Promise<void> {
  try {
    const cached: CachedConfig = { config, timestamp: Date.now() };
    await chrome.storage.local.set({ [CONFIG_CACHE_KEY]: cached });
  } catch {
    // Storage write failed — non-critical, continue without cache
  }
}

async function fetchRemoteConfig(): Promise<DynamicConfig | null> {
  try {
    const response = await fetch(CONFIG_ENDPOINT);
    if (!response.ok) return null;
    const config: DynamicConfig = await response.json();
    return config;
  } catch {
    return null;
  }
}

/**
 * Get the dynamic configuration.
 * Priority: cache (if fresh) -> remote fetch -> hardcoded default.
 */
export async function getConfig(): Promise<DynamicConfig> {
  // 1. Try cache
  const cached = await getCachedConfig();
  if (cached) return cached;

  // 2. Try remote
  const remote = await fetchRemoteConfig();
  if (remote) {
    await setCachedConfig(remote);
    return remote;
  }

  // 3. Fall back to hardcoded default
  return DEFAULT_CONFIG;
}

export { DEFAULT_CONFIG };
