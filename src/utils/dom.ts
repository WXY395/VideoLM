/**
 * DOM query utilities with fallback-chain support.
 *
 * Designed for YouTube's frequent DOM changes and A/B testing:
 * pass an array of selectors and get the first live match.
 *
 * NOTE: These functions are used DIRECTLY in the content script (youtube.ts).
 * For service-worker executeScript (MAIN world), use the inline `qf` helper
 * defined in service-worker.ts — executeScript funcs cannot import modules.
 */

/**
 * Try selectors in priority order, return the first matching element.
 *
 * @param candidates - Single selector string or array of fallback selectors
 * @param validator  - Optional callback to verify the element is "real"
 *                     (e.g. visible, non-empty, correct content).
 *                     Useful for YouTube A/B tests where old DOM nodes
 *                     remain hidden with display:none.
 * @param root       - Search root (defaults to document)
 *
 * @example
 * // Simple fallback chain
 * const owner = queryFirst(YT.INJECT.VIDEO);
 *
 * // With visibility validator
 * const owner = queryFirst(YT.INJECT.VIDEO, el => el.offsetParent !== null);
 *
 * // Scoped to a sub-tree
 * const title = queryFirst(YT.TITLE.VIDEO, undefined, container);
 */
export function queryFirst<T extends Element = Element>(
  candidates: string | readonly string[],
  validator?: (el: T) => boolean,
  root: ParentNode = document,
): T | null {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const sel of list) {
    const el = root.querySelector<T>(sel);
    if (el && (!validator || validator(el))) return el;
  }
  return null;
}

/**
 * Like queryFirst but returns ALL matches from the first successful selector.
 * Useful for video link extraction where you need all matching <a> elements.
 *
 * @param candidates - Single selector or fallback array
 * @param root       - Search root (defaults to document)
 */
export function queryAllFirst<T extends Element = Element>(
  candidates: string | readonly string[],
  root: ParentNode = document,
): NodeListOf<T> {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const sel of list) {
    const nodes = root.querySelectorAll<T>(sel);
    if (nodes.length > 0) return nodes;
  }
  // Return empty NodeList (same type as querySelectorAll)
  return root.querySelectorAll<T>(':not(*)');
}

/**
 * Inline queryFirst for executeScript MAIN world functions.
 * executeScript `func` closures are serialized — they cannot import modules.
 * Use this 3-line version inside those functions.
 *
 * @example
 * // Inside executeScript func:
 * const qf = (ss: string[]) => {
 *   for (const s of ss) { const e = document.querySelector(s); if (e) return e; }
 *   return null;
 * };
 * const panel = qf(sel.PANEL_EXPANDED);
 *
 * This constant is NOT executed — it's documentation + copy-paste template.
 */
export const INLINE_QF_TEMPLATE = `const qf = (ss) => { for (const s of ss) { const e = document.querySelector(s); if (e) return e; } return null; };`;
