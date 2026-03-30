import type { DynamicConfig } from '@/types';

const CONFIG_CACHE_KEY = 'videolm_config_cache';
const CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CONFIG_ENDPOINT = '/api/config';

/** Hardcoded fallback when backend is unreachable.
 *  Real selectors verified from 6 open-source NLM integration projects.
 *  NLM uses Angular + Angular Material (MDC Web components). */
const DEFAULT_CONFIG: DynamicConfig = {
  version: '0.2.0',
  nlm: {
    selectors: {
      addSourceButton: [
        'button[aria-label*="Add"]',
        '.add-source-button',
        'button[data-tooltip*="Add"]',
        'button[title*="Add"]',
      ],
      sourceTypeMenu: [
        'mat-dialog-container',
        'mat-chip-option',
        '.mdc-evolution-chip',
        'span.mat-mdc-chip-action',
      ],
      copiedTextOption: [
        'mat-chip-option:has(span.mdc-evolution-chip__text-label)',
        '.mdc-evolution-chip',
        'span.mdc-evolution-chip__text-label',
      ],
      textInput: [
        'textarea[formcontrolname="textInput"]',
        'textarea[formcontrolname="newText"]',
        'mat-dialog-container textarea',
        'textarea.mat-mdc-input-element',
        'textarea[matinput]',
      ],
      urlInput: [
        'textarea[formcontrolname="newUrl"]',
        'input[type="url"]',
        'input[placeholder*="URL"]',
        'textarea[placeholder*="URL"]',
        'textarea[placeholder*="http"]',
      ],
      submitButton: [
        'button[aria-label="Insert"]',
        'mat-dialog-actions button.mat-primary',
        'button.submit-button',
        'button[mat-flat-button].mat-primary',
        '.mat-mdc-unelevated-button.mat-primary',
      ],
      notebookList: [
        '.notebook-list-item',
        '[role="listitem"]',
      ],
      sourceList: [
        'div.single-source-container',
        '.source-item',
        '[data-source-id]',
      ],
    },
    apiPatterns: {
      addSource: 'LabsTailwindUi/data/batchexecute|izAoDd',
      listNotebooks: 'LabsTailwindUi/data/batchexecute|wXbhsf',
    },
  },
  features: {
    fetchInterceptEnabled: true,
    domAutomationEnabled: true,
    maxBatchSize: 50,
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
