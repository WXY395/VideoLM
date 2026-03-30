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
  return c.json({
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
  });
});
