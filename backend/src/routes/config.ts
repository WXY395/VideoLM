import { Hono } from 'hono';
import type { Env } from '../index';

export const configRoutes = new Hono<{ Bindings: Env }>();

/**
 * Dynamic config endpoint.
 *
 * The extension's dynamic-config-client fetches this on startup.
 * When NotebookLM updates their UI we update the selectors here --
 * no extension update needed.
 */
configRoutes.get('/api/config', (c) => {
  // ═══════════════════════════════════════════════════════════════
  // REAL NLM SELECTORS — verified from 6 open-source projects
  // (DataNath, israelbls, Jorge-D-Robles, geirsagberg, nguyenak95)
  //
  // NotebookLM uses Angular + Angular Material (MDC).
  // Selectors ordered by stability: formcontrolname > mat-* > text match
  //
  // When NLM updates their UI, update selectors here — the extension
  // fetches this config on startup and caches for 1 hour.
  // ═══════════════════════════════════════════════════════════════
  return c.json({
    version: '0.2.0',
    nlm: {
      selectors: {
        // "Add source" / "Add sources" button
        addSourceButton: [
          'button[aria-label*="Add"]',
          '.add-source-button',
          'button[data-tooltip*="Add"]',
          'button[title*="Add"]',
        ],
        // Source type selection chips (Angular Material)
        sourceTypeMenu: [
          'mat-dialog-container',
          'mat-chip-option',
          '.mdc-evolution-chip',
          'span.mat-mdc-chip-action',
        ],
        // "Copied text" chip — matched by text content in DOM automation
        copiedTextOption: [
          'mat-chip-option:has(span.mdc-evolution-chip__text-label)',
          '.mdc-evolution-chip',
          'span.mdc-evolution-chip__text-label',
        ],
        // Text input for "Copied text" source type
        textInput: [
          'textarea[formcontrolname="textInput"]',
          'textarea[formcontrolname="newText"]',
          'mat-dialog-container textarea',
          'textarea.mat-mdc-input-element',
          'textarea[matinput]',
        ],
        // URL input for "Website" source type
        urlInput: [
          'textarea[formcontrolname="newUrl"]',
          'input[type="url"]',
          'input[placeholder*="URL"]',
          'textarea[placeholder*="URL"]',
          'textarea[placeholder*="http"]',
        ],
        // Submit / Insert button
        submitButton: [
          'button[aria-label="Insert"]',
          'mat-dialog-actions button.mat-primary',
          'button.submit-button',
          'button[mat-flat-button].mat-primary',
          '.mat-mdc-unelevated-button.mat-primary',
        ],
        // Notebook list items
        notebookList: [
          '.notebook-list-item',
          '[role="listitem"]',
          'app-root [data-app-data]',
        ],
        // Existing sources in sidebar
        sourceList: [
          'div.single-source-container',
          '.source-item',
          '[data-source-id]',
        ],
      },
      apiPatterns: {
        // NLM uses batchexecute RPC; "izAoDd" is the "add source" method ID
        addSource: 'LabsTailwindUi/data/batchexecute|izAoDd',
        listNotebooks: 'LabsTailwindUi/data/batchexecute|wXbhsf',
      },
    },
    features: {
      fetchInterceptEnabled: true,
      domAutomationEnabled: true,
      maxBatchSize: 50,
    },
    // Text labels for button matching (multi-language support)
    textLabels: {
      addSource: ['Add source', 'Add sources', '新增來源', 'הוספת מקורות'],
      copiedText: ['Copied text', '已複製的文字', 'טקסט שהועתק'],
      insert: ['Insert', '插入', 'הוספה'],
      website: ['Website', '網站', 'אתר'],
    },
  });
});
