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
        // Check if we're on a YouTube video page first
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.includes('youtube.com/watch')) {
          throw new Error('Open a YouTube video to use VideoLM');
        }

        // First try: get full video content (metadata + transcript)
        const response = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_CONTENT' });

        if (cancelled) return;

        if (response?.type === 'VIDEO_CONTENT' && response.data) {
          setContent(response.data);
        } else {
          // Fallback: create minimal VideoContent from URL alone
          // This ensures Quick Import always works even if extraction fails
          const url = tab.url!;
          const videoId = new URL(url).searchParams.get('v') || '';
          const title = tab.title?.replace(' - YouTube', '') || 'Unknown Video';
          setContent({
            videoId,
            title,
            author: '',
            platform: 'youtube',
            transcript: [],
            duration: 0,
            language: 'unknown',
            url,
            metadata: { publishDate: '', viewCount: 0, tags: [] },
          });
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
