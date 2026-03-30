/**
 * ImportOrchestrator — orchestrates three-tier import into NotebookLM.
 *
 * Tier 1: Fetch interception (replay captured API request)
 * Tier 2: DOM automation (simulate UI clicks)
 * Tier 3: Clipboard fallback (always works — copy to clipboard for manual paste)
 *
 * Tier 3 is the safety net and must ALWAYS succeed.
 */

import type { ImportResult, DynamicConfig } from '@/types';
import type { FetchInterceptor, ReplayResult } from './fetch-interceptor';
import type { DomAutomation, DomResult } from './dom-automation';

export interface OrchestratorDeps {
  fetchInterceptor?: FetchInterceptor;
  domAutomation?: DomAutomation;
  config: DynamicConfig;
  /** Injected for testability; defaults to navigator.clipboard.writeText */
  clipboardWrite?: (text: string) => Promise<void>;
}

export class ImportOrchestrator {
  private fetchInterceptor?: FetchInterceptor;
  private domAutomation?: DomAutomation;
  private config: DynamicConfig;
  private clipboardWrite: (text: string) => Promise<void>;

  constructor(deps: OrchestratorDeps) {
    this.fetchInterceptor = deps.fetchInterceptor;
    this.domAutomation = deps.domAutomation;
    this.config = deps.config;
    this.clipboardWrite =
      deps.clipboardWrite ?? ((text: string) => navigator.clipboard.writeText(text));
  }

  /**
   * Import content into NotebookLM, trying tiers 1 → 2 → 3.
   */
  async importContent(content: string): Promise<ImportResult> {
    // --- Tier 1: Fetch interception ---
    if (this.config.features.fetchInterceptEnabled && this.fetchInterceptor) {
      try {
        if (this.fetchInterceptor.isArmed()) {
          const result: ReplayResult = await this.fetchInterceptor.replay(content);
          if (result.success) {
            return { success: true, tier: 1, message: 'Source added via API replay.' };
          }
          // Tier 1 failed — fall through
        }
      } catch {
        // Tier 1 error — fall through
      }
    }

    // --- Tier 2: DOM automation ---
    if (this.config.features.domAutomationEnabled && this.domAutomation) {
      try {
        const result: DomResult = await this.domAutomation.addSource(content);
        if (result.success) {
          return { success: true, tier: 2, message: 'Source added via DOM automation.' };
        }
        // Tier 2 failed — fall through
      } catch {
        // Tier 2 error — fall through
      }
    }

    // --- Tier 3: Clipboard fallback (ALWAYS works) ---
    return this.clipboardFallback(content);
  }

  /**
   * Import a batch of items progressively.
   * Calls onProgress after each item. 800ms delay between items.
   */
  async importBatch(
    contents: Array<{ title: string; content: string }>,
    onProgress?: (index: number, result: ImportResult) => void,
  ): Promise<ImportResult[]> {
    const maxBatch = this.config.features.maxBatchSize;
    const items = contents.slice(0, maxBatch);
    const results: ImportResult[] = [];

    for (let i = 0; i < items.length; i++) {
      const result = await this.importContent(items[i].content);
      results.push(result);
      onProgress?.(i, result);

      // 800ms delay between items (skip after last)
      if (i < items.length - 1) {
        await this.delay(800);
      }
    }

    return results;
  }

  // ---- Tier 3 implementation ----

  private async clipboardFallback(content: string): Promise<ImportResult> {
    try {
      await this.clipboardWrite(content);
      return {
        success: true,
        tier: 3,
        manual: true,
        message:
          'Content copied to clipboard. Open NotebookLM, click "Add Source" → "Copied text", and paste.',
      };
    } catch (err) {
      return {
        success: false,
        tier: 3,
        manual: true,
        error: `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
