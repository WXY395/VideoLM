import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('YouTube NotebookLM button injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/watch?v=test-video');
    vi.stubGlobal('location', window.location);
    (globalThis.chrome as any).runtime = {};
    Object.defineProperty(globalThis.chrome.runtime, 'id', {
      configurable: true,
      value: 'test-extension',
    });
    (globalThis.chrome as any).runtime.onMessage = {
      addListener: vi.fn(),
    };
    (globalThis.chrome as any).runtime.sendMessage = vi.fn();
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('injects the video button into the visible owner row, not a hidden stale owner row', async () => {
    document.body.innerHTML = `
      <ytd-watch-metadata>
        <div id="owner" hidden></div>
        <div id="top-row">
          <div id="owner"></div>
        </div>
      </ytd-watch-metadata>
    `;

    await import('../youtube');
    vi.advanceTimersByTime(1000);

    const owners = document.querySelectorAll('#owner');
    const hiddenOwner = owners[0];
    const visibleOwner = owners[1];

    expect(hiddenOwner.querySelector('#videolm-nlm-btn-video')).toBeNull();
    expect(visibleOwner.querySelector('#videolm-nlm-btn-video')).toBeTruthy();
  });

  it('falls back to the visible subscribe row when the watch page has no owner id yet', async () => {
    document.body.innerHTML = `
      <ytd-watch-metadata>
        <div id="top-row">
          <div class="channel-action-row">
            <button aria-label="加入">加入</button>
            <div id="subscribe-button">
              <button aria-label="訂閱">訂閱</button>
            </div>
          </div>
        </div>
      </ytd-watch-metadata>
    `;

    await import('../youtube');
    vi.advanceTimersByTime(1000);

    const actionRow = document.querySelector('.channel-action-row');
    expect(actionRow?.querySelector('#videolm-nlm-btn-video')).toBeTruthy();
  });

  it('does not let a hidden stale video button block injection into the current visible row', async () => {
    document.body.innerHTML = `
      <ytd-watch-metadata>
        <div id="owner" hidden>
          <button id="videolm-nlm-btn-video">NotebookLM</button>
        </div>
        <div id="top-row">
          <div id="owner"></div>
        </div>
      </ytd-watch-metadata>
    `;

    await import('../youtube');
    vi.advanceTimersByTime(1000);

    const owners = document.querySelectorAll('#owner');
    const hiddenOwner = owners[0];
    const visibleOwner = owners[1];

    expect(hiddenOwner.querySelector('#videolm-nlm-btn-video')).toBeNull();
    expect(visibleOwner.querySelector('#videolm-nlm-btn-video')).toBeTruthy();
  });

  it('repairs a stale hidden button when the current owner row appears after startup', async () => {
    document.body.innerHTML = '<ytd-watch-metadata></ytd-watch-metadata>';

    await import('../youtube');
    vi.advanceTimersByTime(1000);

    document.querySelector('ytd-watch-metadata')!.innerHTML = `
      <div id="owner" hidden>
        <button id="videolm-nlm-btn-video">NotebookLM</button>
      </div>
      <div id="top-row">
        <div id="owner"></div>
      </div>
    `;
    vi.advanceTimersByTime(1000);

    const owners = document.querySelectorAll('#owner');
    const hiddenOwner = owners[0];
    const visibleOwner = owners[1];

    expect(hiddenOwner.querySelector('#videolm-nlm-btn-video')).toBeNull();
    expect(visibleOwner.querySelector('#videolm-nlm-btn-video')).toBeTruthy();
  });

  it('moves an existing video button from the wrong container when the current owner row appears later', async () => {
    document.body.innerHTML = `
      <div class="stale-actions">
        <button id="videolm-nlm-btn-video">NotebookLM</button>
      </div>
      <ytd-watch-metadata></ytd-watch-metadata>
    `;

    await import('../youtube');
    vi.advanceTimersByTime(1000);

    document.querySelector('ytd-watch-metadata')!.innerHTML = `
      <div id="top-row">
        <div id="owner"></div>
      </div>
    `;
    vi.advanceTimersByTime(1000);

    const staleActions = document.querySelector('.stale-actions');
    const visibleOwner = document.querySelector('#owner');

    expect(staleActions?.querySelector('#videolm-nlm-btn-video')).toBeNull();
    expect(visibleOwner?.querySelector('#videolm-nlm-btn-video')).toBeTruthy();
  });
});
