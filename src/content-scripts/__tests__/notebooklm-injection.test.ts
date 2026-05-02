import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('NotebookLM response button injection startup', () => {
  let observers: Array<{
    callback: MutationCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    observers = [];

    window.history.pushState({}, '', '/');
    (globalThis.chrome as any).runtime = {
      onMessage: {
        addListener: vi.fn(),
      },
      sendMessage: vi.fn(),
    };

    class MockMutationObserver {
      observe = vi.fn();
      disconnect = vi.fn();

      callback: MutationCallback;

      constructor(callback: MutationCallback) {
        this.callback = callback;
        observers.push(this);
      }
    }

    vi.stubGlobal('MutationObserver', MockMutationObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts observing on the NotebookLM homepage so SPA navigation into a notebook can inject buttons without refresh', async () => {
    await import('../notebooklm');

    document.dispatchEvent(new Event('DOMContentLoaded'));
    vi.advanceTimersByTime(1500);

    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  it('injects both export buttons after SPA navigation from homepage into a notebook with an AI response', async () => {
    await import('../notebooklm');

    document.dispatchEvent(new Event('DOMContentLoaded'));
    vi.advanceTimersByTime(1500);

    window.history.pushState({}, '', '/notebook/test-notebook');
    document.body.innerHTML = `
      <mat-card class="to-user-message-card-content">
        <mat-card-content class="message-content">
          <p>NotebookLM answer</p>
        </mat-card-content>
        <mat-card-actions class="message-actions"></mat-card-actions>
      </mat-card>
    `;

    observers[0].callback([
      { type: 'childList', addedNodes: document.body.childNodes } as unknown as MutationRecord,
    ], observers[0] as unknown as MutationObserver);
    vi.advanceTimersByTime(1200);

    const host = document.querySelector('mat-card-actions .videolm-notion-btn-host');
    const shadow = host?.shadowRoot;

    expect(shadow?.querySelector('[aria-label="Copy for Notion"]')).toBeTruthy();
    expect(shadow?.querySelector('[aria-label="Copy for Obsidian"]')).toBeTruthy();
    expect(shadow?.querySelector('[aria-label="Download Obsidian Markdown"]')).toBeTruthy();
  });

  it('does not permanently skip the first AI response when its toolbar renders after the response card', async () => {
    await import('../notebooklm');

    document.dispatchEvent(new Event('DOMContentLoaded'));
    vi.advanceTimersByTime(1500);

    window.history.pushState({}, '', '/notebook/test-notebook');
    document.body.innerHTML = `
      <mat-card class="to-user-message-card-content">
        <mat-card-content class="message-content">
          <p>First generated answer</p>
        </mat-card-content>
      </mat-card>
    `;

    observers[0].callback([
      { type: 'childList', addedNodes: document.body.childNodes } as unknown as MutationRecord,
    ], observers[0] as unknown as MutationObserver);
    vi.advanceTimersByTime(10000);

    const card = document.querySelector('mat-card.to-user-message-card-content');
    const toolbar = document.createElement('mat-card-actions');
    toolbar.className = 'message-actions';
    card?.appendChild(toolbar);

    observers[0].callback([
      { type: 'childList', addedNodes: [toolbar] } as unknown as MutationRecord,
    ], observers[0] as unknown as MutationObserver);
    vi.advanceTimersByTime(1200);

    const host = document.querySelector('mat-card-actions .videolm-notion-btn-host');
    const shadow = host?.shadowRoot;

    expect(shadow?.querySelector('[aria-label="Copy for Notion"]')).toBeTruthy();
    expect(shadow?.querySelector('[aria-label="Copy for Obsidian"]')).toBeTruthy();
    expect(shadow?.querySelector('[aria-label="Download Obsidian Markdown"]')).toBeTruthy();
  });
});
