import { useState, useEffect } from 'react';
import type { VideoContent } from '@/types';

export type PageType = 'watch' | 'playlist' | 'channel' | 'search' | 'unknown';

export interface UseVideoContentResult {
  content: VideoContent | null;
  loading: boolean;
  error: string | null;
  batchUrls: string[];
  pageType: PageType;
  pageTitle: string;
}

/** Detect YouTube page type from tab URL */
function getPageType(url: string): PageType {
  if (url.includes('/watch?v=')) return 'watch';
  if (url.includes('/playlist?list=')) return 'playlist';
  if (url.includes('/@') || url.includes('/channel/')) return 'channel';
  if (url.includes('/results?search_query=')) return 'search';
  return 'unknown';
}

/**
 * Hook to fetch video content from the active tab.
 * Supports single-video watch pages and batch pages (playlist/channel/search).
 */
export function useVideoContent(): UseVideoContentResult {
  const [content, setContent] = useState<VideoContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [batchUrls, setBatchUrls] = useState<string[]>([]);
  const [pageType, setPageType] = useState<PageType>('unknown');
  const [pageTitle, setPageTitle] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchContent() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.includes('youtube.com')) {
          throw new Error('Open a YouTube page to use VideoLM');
        }

        const detectedType = getPageType(tab.url!);
        if (!cancelled) setPageType(detectedType);

        if (detectedType === 'watch') {
          // Single video: existing behavior
          const response = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_CONTENT' });
          if (cancelled) return;

          if (response?.type === 'VIDEO_CONTENT' && response.data) {
            setContent(response.data);
            setPageTitle(response.data.title);
          } else {
            // Fallback: minimal VideoContent from URL
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
            setPageTitle(title);
          }
        } else if (detectedType !== 'unknown') {
          // Batch page: playlist, channel, or search
          const title = tab.title?.replace(' - YouTube', '') || 'YouTube Page';
          if (!cancelled) setPageTitle(title);

          const response = await chrome.runtime.sendMessage({ type: 'EXTRACT_VIDEO_URLS' });
          if (cancelled) return;

          if (response?.urls && Array.isArray(response.urls)) {
            setBatchUrls(response.urls);
            if (response.pageTitle) setPageTitle(response.pageTitle);
            // Create minimal VideoContent for batch context
            setContent({
              videoId: '',
              title: response.pageTitle || title,
              author: '',
              platform: 'youtube',
              transcript: [],
              duration: 0,
              language: 'unknown',
              url: tab.url!,
              metadata: { publishDate: '', viewCount: 0, tags: [] },
            });
          } else {
            throw new Error('Could not extract video URLs from this page. Try scrolling to load more videos.');
          }
        } else {
          throw new Error('Open a YouTube video, playlist, channel, or search page to use VideoLM');
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

  return { content, loading, error, batchUrls, pageType, pageTitle };
}
