/**
 * NLM "Copy for Notion" — Citation-safe DOM capture (Content Integrity Layer)
 *
 * All work runs in the Copy button click handler only (never during streaming).
 * Original DOM is never mutated; a deep clone is cleaned and serialized.
 */

/**
 * Remove UI chrome — selector-based, not regex on full HTML.
 * IMPORTANT: citation buttons (button.citation-marker) must be PRESERVED.
 */
export const REMOVE_SELECTORS = [
  'button:not(.citation-marker):not(.xap-inline-dialog)',
  'svg',
  '[data-testid]',
  '[class*="toolbar"]',
  '[aria-hidden="true"]',
  'script',
  'style',
];

export function cloneAndCleanNlmResponse(root: Element): Element {
  const clone = root.cloneNode(true) as Element;
  REMOVE_SELECTORS.forEach((selector) => {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  });
  return clone;
}

/**
 * Detect inline numeric citation nodes.
 *
 * NLM 2026 DOM structure per citation:
 *   SPAN.ng-star-inserted > BUTTON.citation-marker.xap-inline-dialog > SPAN
 *
 * We match on the BUTTON (the canonical citation element) by class name.
 * Legacy SUP/A tags are kept as fallback for older NLM versions.
 */
export function isCitationNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  const text = node.textContent?.trim() ?? '';
  if (!/^\d{1,3}$/.test(text)) return false;

  const el = node as HTMLElement;
  const tag = el.tagName;

  // Primary: NLM 2026 citation button (BUTTON.citation-marker)
  if (tag === 'BUTTON' && el.classList.contains('citation-marker')) {
    return true;
  }

  // Fallback: legacy SUP/A tags (older NLM versions)
  if (tag === 'SUP' || tag === 'A') {
    const prev = node.previousSibling?.textContent ?? '';
    const next = node.nextSibling?.textContent ?? '';
    return /[^\d]$/.test(prev) && /^[^\d]/.test(next || ' ');
  }

  return false;
}

/**
 * Pure text extractor with citation injection.
 *
 * Walks the DOM tree and emits raw `textContent` for every node EXCEPT
 * citation nodes, which are replaced with `<VIDEO_CITATION id="n"/>`.
 *
 * ❌ No structure reconstruction (headings, lists, paragraphs, line breaks).
 *    Content structure is owned by NLM (source) and Notion (target).
 */
export function serializeToProtectedMD(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return Array.from(node.childNodes).map(serializeToProtectedMD).join('');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  // Only allowed injection: citation nodes → <VIDEO_CITATION/>
  if (isCitationNode(node)) {
    const id = node.textContent?.trim();
    return `<VIDEO_CITATION id="${id}"/>`;
  }

  // All other elements: recurse children, preserve original text, no structure markup
  return Array.from(node.childNodes).map(serializeToProtectedMD).join('');
}

/** Extracted citation hint from the DOM (id + optional href from <a> tags) */
export interface DomCitationHint {
  id: number;
  href?: string;
}

/**
 * Walk the DOM and collect citation hints (id + href if available).
 * Runs on the cleaned clone — same tree that serializeToProtectedMD walks.
 */
export function extractCitationHints(root: Element): DomCitationHint[] {
  const hints: DomCitationHint[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    if (isCitationNode(node)) {
      const id = parseInt(node.textContent?.trim() ?? '', 10);
      if (!isNaN(id)) {
        const el = node as HTMLElement;
        const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || undefined;
        hints.push({ id, href });
      }
    }
    node = walker.nextNode();
  }
  return hints;
}

/** Extracted citation-to-source mapping from NLM aria-labels */
export interface CitationSourceName {
  id: number;
  sourceName: string;
}

/**
 * Extract citation source names from NLM citation buttons.
 * NLM citation buttons have aria-labels like "1: Claude Cowork 最友善的..."
 * Walks the response card to find all citation buttons and their labels.
 */
export function extractCitationSourceNames(root: Element): CitationSourceName[] {
  const results: CitationSourceName[] = [];
  const seen = new Set<number>();

  const buttons = root.querySelectorAll('button.citation-marker, .citation-marker');
  for (const btn of buttons) {
    const id = parseInt(btn.textContent?.trim() ?? '', 10);
    if (isNaN(id) || seen.has(id)) continue;

    const parent = btn.closest('[aria-label]');
    const label = parent?.getAttribute('aria-label')
      ?? btn.getAttribute('aria-label')
      ?? '';

    const match = label.match(/^\d+:\s*(.+)$/);
    if (match) {
      seen.add(id); // Only mark as seen when we actually found a source name
      results.push({ id, sourceName: match[1].trim() });
    }
    // If no aria-label found on button, do NOT add to seen — let span pass handle it
  }

  const labelSpans = root.querySelectorAll('span[aria-label]');
  for (const span of labelSpans) {
    const label = span.getAttribute('aria-label') ?? '';
    const match = label.match(/^(\d+):\s*(.+)$/);
    if (!match) continue;
    const id = parseInt(match[1], 10);
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({ id, sourceName: match[2].trim() });
  }

  return results;
}

/** Result of prepareNlmResponseForNotion — protected text + DOM citation hints */
export interface NlmPrepareResult {
  protectedText: string;
  citationHints: DomCitationHint[];
  citationSourceNames: CitationSourceName[];
}

/**
 * Expand hidden citation lists by clicking "..." (more_horiz) buttons.
 * NLM collapses citation groups — e.g., [1][2]... hides [3][4][5].
 * Clicking reveals all citations in the group.
 *
 * Safeguards:
 *   1. Only clicks unexpanded buttons (data-vlm-expanded marker)
 *   2. Uses MutationObserver to wait for DOM update (not arbitrary timeout)
 *   3. Re-entrancy guard prevents concurrent expansion
 */
async function expandCitationEllipsis(root: Element): Promise<void> {
  if ((root as any).__vlmExpanding) return;
  (root as any).__vlmExpanding = true;

  try {
    const ellipsisBtns = root.querySelectorAll('button.citation-marker');
    let expanded = 0;
    for (const btn of ellipsisBtns) {
      if (
        btn.textContent?.trim() === 'more_horiz' &&
        !(btn as HTMLElement).dataset.vlmExpanded
      ) {
        (btn as HTMLElement).dataset.vlmExpanded = '1';
        (btn as HTMLElement).click();
        expanded++;
      }
    }

    if (expanded > 0) {
      // Wait for NLM to render expanded citations via MutationObserver
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(root, { childList: true, subtree: true });
        // Fallback in case observer doesn't fire
        setTimeout(() => { observer.disconnect(); resolve(); }, 500);
      });
    }
  } finally {
    (root as any).__vlmExpanding = false;
  }
}

/**
 * Full DOM pipeline for one AI response root.
 * @param root — mat-card-content.message-content (text source)
 * @param card — mat-card.to-user-message-card-content (full card, for aria-labels)
 */
export async function prepareNlmResponseForNotion(root: Element, card?: Element): Promise<NlmPrepareResult> {
  // Expand hidden citations first (on original DOM, before cloning)
  await expandCitationEllipsis(card ?? root);

  const clone = cloneAndCleanNlmResponse(root);
  return {
    protectedText: serializeToProtectedMD(clone),
    citationHints: extractCitationHints(clone),
    citationSourceNames: extractCitationSourceNames(card ?? root),
  };
}

/**
 * Dual-channel clipboard write:
 *   text/html  → HTML with <a href="..."> (Notion reads this for clickable links)
 *   text/plain → Markdown fallback (for plain-text editors)
 *
 * ❗ text/html MUST contain <a> tags for Notion to create clickable links.
 *    Markdown [text](url) in text/plain is NOT auto-linked by Notion.
 */
export async function writeNotionToClipboard(plainText: string, html: string): Promise<void> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch (e) {
    console.warn('[VideoLM] ClipboardItem write failed, falling back to writeText', e);
  }
  // Fallback: plain text only (no HTML links)
  await navigator.clipboard.writeText(plainText);
}
