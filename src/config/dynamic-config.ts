import type { DynamicConfig } from '@/types';

const CONFIG_CACHE_KEY = 'videolm_config_cache';
const CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CONFIG_ENDPOINT = '/api/config';

/** Hardcoded fallback when backend is unreachable */
const DEFAULT_CONFIG: DynamicConfig = {
  nlmSelectors: {
    addSourceButton: 'button[aria-label="Add source"]',
    pasteArea: 'textarea[aria-label="Paste text"]',
    sourceTypeSelector: '[data-source-type="text"]',
    confirmButton: 'button[aria-label="Insert"]',
  },
  apiPatterns: {
    youtubeTranscript: 'https://www.youtube.com/api/timedtext',
    notebookLmApi: 'https://notebooklm.google.com',
  },
  features: {
    aiSummaryEnabled: true,
    chapterDetectionEnabled: true,
    multiLanguageEnabled: false,
    geminiNanoEnabled: false,
  },
  version: '0.1.0',
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
