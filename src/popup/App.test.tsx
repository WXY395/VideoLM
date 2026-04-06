import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

// Mock chrome APIs
const mockSendMessage = vi.fn();
const mockTabsQuery = vi.fn();
const mockTabsSendMessage = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();

  // Default: non-YouTube tab so the hook resolves with an error
  mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);

  // sendMessage must handle both promise-based (hook) and callback-based (App) calls
  mockSendMessage.mockImplementation((msg: unknown, cb?: (resp: unknown) => void) => {
    const resp = undefined;
    if (cb) {
      cb(resp);
      return;
    }
    return Promise.resolve(resp);
  });

  // Install chrome global (including i18n mock that returns the key)
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: { sendMessage: mockSendMessage, lastError: null },
      tabs: { query: mockTabsQuery, sendMessage: mockTabsSendMessage },
      i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en' },
      storage: {
        session: { get: (_k: string, cb: (r: any) => void) => cb({}), set: () => {} },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      },
    },
    writable: true,
    configurable: true,
  });
});

describe('App', () => {
  it('renders the heading', () => {
    render(<App />);
    // i18n mock returns the key itself
    expect(screen.getByText('popup_title')).toBeInTheDocument();
  });

  it('renders the subheading', () => {
    render(<App />);
    expect(screen.getByText('popup_subtitle')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<App />);
    expect(screen.getByText(/popup_loading_video|popup_extracting_urls/)).toBeInTheDocument();
  });

  it('shows error state for non-YouTube pages', async () => {
    render(<App />);

    const errorText = await screen.findByText('Open a YouTube page to use VideoLM');
    expect(errorText).toBeInTheDocument();
  });

  it('shows batch UI for playlist pages', async () => {
    mockTabsQuery.mockResolvedValue([{
      id: 1,
      url: 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      title: 'My Playlist - YouTube',
    }]);

    const extractResponse = {
      urls: ['https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=b'],
      pageTitle: 'My Playlist',
      pageType: 'playlist',
      totalVisible: 2,
    };

    mockSendMessage.mockImplementation((msg: { type: string }, cb?: (resp: unknown) => void) => {
      if (msg.type === 'EXTRACT_VIDEO_URLS') {
        if (cb) { cb(extractResponse); return; }
        return Promise.resolve(extractResponse);
      }
      if (msg.type === 'CHECK_PENDING_QUEUE') {
        const resp = { pending: false };
        if (cb) { cb(resp); return; }
        return Promise.resolve(resp);
      }
      if (cb) { cb(undefined); return; }
      return Promise.resolve(undefined);
    });

    render(<App />);

    // i18n mock returns key — video_count_found with placeholder not substituted
    const videoCount = await screen.findByText('video_count_found');
    expect(videoCount).toBeInTheDocument();
  });

  it('shows split buttons for channel pages with > 50 videos', async () => {
    mockTabsQuery.mockResolvedValue([{
      id: 1,
      url: 'https://www.youtube.com/@SomeChannel/videos',
      title: 'Some Channel - YouTube',
    }]);

    const urls = Array.from({ length: 60 }, (_, i) => `https://youtube.com/watch?v=${i}`);
    const extractResponse = {
      urls,
      pageTitle: 'Some Channel',
      pageType: 'channel',
      totalVisible: 60,
    };

    mockSendMessage.mockImplementation((msg: { type: string }, cb?: (resp: unknown) => void) => {
      if (msg.type === 'EXTRACT_VIDEO_URLS') {
        if (cb) { cb(extractResponse); return; }
        return Promise.resolve(extractResponse);
      }
      if (msg.type === 'CHECK_PENDING_QUEUE') {
        const resp = { pending: false };
        if (cb) { cb(resp); return; }
        return Promise.resolve(resp);
      }
      if (cb) { cb(undefined); return; }
      return Promise.resolve(undefined);
    });

    render(<App />);

    const videoCount = await screen.findByText('video_count_found');
    expect(videoCount).toBeInTheDocument();

    // i18n mock returns key for split/first-N buttons
    const splitButton = await screen.findByText('batch_auto_split');
    expect(splitButton).toBeInTheDocument();

    const first50Button = await screen.findByText('batch_import_first');
    expect(first50Button).toBeInTheDocument();
  });
});
