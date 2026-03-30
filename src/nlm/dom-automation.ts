/**
 * Tier 2 — DOM Automation.
 *
 * Drives the NotebookLM UI by clicking buttons, filling text fields,
 * and waiting for confirmations. Uses dynamic selectors from config
 * with ARIA-based fallback.
 */

import type { DynamicConfig } from '@/types';

type Selectors = DynamicConfig['nlm']['selectors'];

export interface DomResult {
  success: boolean;
  reason?: string;
}

export class DomAutomation {
  private selectors: Selectors;

  constructor(selectors: Selectors) {
    this.selectors = selectors;
  }

  /**
   * Full DOM automation flow to add a "Copied text" source.
   *
   *  1. Click "Add Source" button
   *  2. Select "Copied text" option from the source type menu
   *  3. Fill in the text area (Angular-safe)
   *  4. Click Submit
   *  5. Wait for the source to appear / dialog to close
   */
  async addSource(content: string): Promise<DomResult> {
    // Step 1: Click "Add Source"
    const addBtn = this.findElement(this.selectors.addSourceButton);
    if (!addBtn) {
      return { success: false, reason: 'Could not find "Add Source" button.' };
    }
    this.click(addBtn);

    // Wait for the source-type menu to appear
    await this.waitFor(() => this.findElement(this.selectors.sourceTypeMenu) !== null, 3000);

    // Step 2: Click "Copied text"
    const copiedTextOpt = this.findElement(this.selectors.copiedTextOption);
    if (!copiedTextOpt) {
      return { success: false, reason: 'Could not find "Copied text" option.' };
    }
    this.click(copiedTextOpt);

    // Wait for text input to appear
    await this.waitFor(() => this.findElement(this.selectors.textInput) !== null, 3000);

    // Step 3: Fill text
    const textInput = this.findElement(this.selectors.textInput);
    if (!textInput) {
      return { success: false, reason: 'Could not find text input field.' };
    }
    this.safeInput(textInput as HTMLInputElement | HTMLTextAreaElement, content);

    // Step 4: Click Submit
    const submitBtn = this.findElement(this.selectors.submitButton);
    if (!submitBtn) {
      return { success: false, reason: 'Could not find Submit button.' };
    }
    this.click(submitBtn);

    // Step 5: Wait for confirmation (dialog closes or source appears)
    const confirmed = await this.waitFor(() => {
      // If the submit button is no longer visible, the dialog closed
      const btn = this.findElement(this.selectors.submitButton);
      return btn === null;
    }, 10000);

    if (!confirmed) {
      return { success: false, reason: 'Timed out waiting for import confirmation.' };
    }

    return { success: true };
  }

  /**
   * Read existing sources from the sidebar.
   */
  getSourceList(): Array<{ title: string; url?: string }> {
    const sources: Array<{ title: string; url?: string }> = [];

    for (const selector of this.selectors.sourceList) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach((el) => {
          const title = el.textContent?.trim();
          if (title) {
            const linkEl = el.closest('a') ?? el.querySelector('a');
            sources.push({
              title,
              url: linkEl?.getAttribute('href') ?? undefined,
            });
          }
        });
        break; // First matching selector group wins
      }
    }

    return sources;
  }

  /**
   * Multi-strategy element resolution.
   *  1. Try each CSS selector in the array
   *  2. Fall back to ARIA role + text matching
   * Only returns visible elements.
   */
  findElement(selectorGroup: string[]): Element | null {
    // Strategy 1: CSS selectors from config
    for (const selector of selectorGroup) {
      try {
        const el = document.querySelector(selector);
        if (el && this.isVisible(el)) {
          return el;
        }
      } catch {
        // Invalid selector — skip
      }
    }

    // Strategy 2: ARIA fallback — look for button/textbox/option roles
    // matching text content from the selector hints
    const hintText = this.extractHintText(selectorGroup);
    if (hintText) {
      const ariaEl = this.findByAriaAndText(hintText);
      if (ariaEl) return ariaEl;
    }

    return null;
  }

  /**
   * Angular-safe input simulation.
   * Dispatches keydown → input → keyup per character, then change + blur.
   */
  safeInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    // Focus the element first
    element.focus();
    element.dispatchEvent(new Event('focus', { bubbles: true }));

    // Clear existing value
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));

    // Type each character
    for (const char of value) {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: char, bubbles: true }),
      );

      element.value += char;

      element.dispatchEvent(new Event('input', { bubbles: true }));

      element.dispatchEvent(
        new KeyboardEvent('keyup', { key: char, bubbles: true }),
      );
    }

    // Finalize
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---- Private helpers ----

  private click(el: Element): void {
    (el as HTMLElement).click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  private isVisible(el: Element): boolean {
    const htmlEl = el as HTMLElement;
    if (!htmlEl.offsetParent && htmlEl.style?.display !== 'fixed') {
      // offsetParent is null for hidden elements (except position:fixed)
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Extract human-readable hint text from selector strings.
   * e.g., "[aria-label='Add source']" → "Add source"
   */
  private extractHintText(selectors: string[]): string | null {
    for (const sel of selectors) {
      // Match aria-label='...' or text content hints
      const ariaMatch = sel.match(/aria-label[=~]*['"]([^'"]+)['"]/i);
      if (ariaMatch) return ariaMatch[1];

      // Match :contains('...') pseudo-selector
      const containsMatch = sel.match(/:contains\(['"]?([^'")\]]+)['"]?\)/i);
      if (containsMatch) return containsMatch[1];
    }
    return null;
  }

  /**
   * Find an element by ARIA role + text content match.
   */
  private findByAriaAndText(text: string): Element | null {
    const roles = ['button', 'menuitem', 'option', 'textbox', 'link'];
    const lowerText = text.toLowerCase();

    for (const role of roles) {
      const elements = document.querySelectorAll(`[role="${role}"]`);
      for (const el of elements) {
        const elText = el.textContent?.toLowerCase().trim();
        const ariaLabel = el.getAttribute('aria-label')?.toLowerCase();

        if (
          (elText && elText.includes(lowerText)) ||
          (ariaLabel && ariaLabel.includes(lowerText))
        ) {
          if (this.isVisible(el)) return el;
        }
      }
    }

    // Also check plain buttons without explicit role
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const btnText = btn.textContent?.toLowerCase().trim();
      if (btnText && btnText.includes(lowerText) && this.isVisible(btn)) {
        return btn;
      }
    }

    return null;
  }

  /**
   * Poll until predicate returns true, or timeout.
   */
  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (predicate()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }
}
