import { useState, useEffect } from 'react';
import type { VideoContent } from '@/types';

interface UseVideoContentResult {
  content: VideoContent | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook to fetch video content from the active tab.
 * First asks background to inject the content script, then queries it.
 */
export function useVideoContent(): UseVideoContentResult {
  const [content, setContent] = useState<VideoContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchContent() {
      try {
        // Step 1: Ask background to inject content script via activeTab
        await chrome.runtime.sendMessage({ type: 'INJECT_YOUTUBE_SCRIPT' });

        // Step 2: Query the active tab for video content
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          throw new Error('No active tab found');
        }

        if (!tab.url?.includes('youtube.com/watch')) {
          throw new Error('Not a YouTube video page');
        }

        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_CONTENT' });

        if (cancelled) return;

        if (response?.type === 'VIDEO_CONTENT' && response.data) {
          setContent(response.data);
        } else if (response?.error) {
          setError(response.error);
        } else {
          setError('Could not extract video content');
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load video content';
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchContent();

    return () => {
      cancelled = true;
    };
  }, []);

  return { content, loading, error };
}
