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
  mockSendMessage.mockImplementation((_msg: unknown, cb?: (resp: unknown) => void) => {
    if (cb) cb(undefined);
  });

  // Install chrome global
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: { sendMessage: mockSendMessage },
      tabs: { query: mockTabsQuery, sendMessage: mockTabsSendMessage },
    },
    writable: true,
    configurable: true,
  });
});

describe('App', () => {
  it('renders the heading', () => {
    render(<App />);
    expect(screen.getByText('VideoLM')).toBeInTheDocument();
  });

  it('renders the subheading', () => {
    render(<App />);
    expect(screen.getByText('AI Video to NotebookLM')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<App />);
    expect(screen.getByText('Loading video info...')).toBeInTheDocument();
  });

  it('shows error state for non-YouTube pages', async () => {
    // sendMessage for INJECT_YOUTUBE_SCRIPT resolves fine
    mockSendMessage.mockResolvedValue(undefined);

    render(<App />);

    // Wait for the error to appear
    const errorText = await screen.findByText('Not a YouTube video page');
    expect(errorText).toBeInTheDocument();
  });
});
