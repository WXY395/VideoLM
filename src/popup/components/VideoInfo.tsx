import React from 'react';
import type { VideoContent } from '@/types';
import type { PageType } from '../hooks/useVideoContent';

interface VideoInfoProps {
  content: VideoContent;
  pageType?: PageType;
  batchCount?: number;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

const PAGE_TYPE_LABELS: Record<string, { icon: string; label: string }> = {
  playlist: { icon: '\uD83D\uDCCB', label: 'Playlist' },
  channel: { icon: '\uD83D\uDCFA', label: 'Channel' },
  search: { icon: '\uD83D\uDD0D', label: 'Search Results' },
};

export function VideoInfo({ content, pageType, batchCount }: VideoInfoProps) {
  const isBatch = pageType && pageType !== 'watch' && pageType !== 'unknown';

  if (isBatch) {
    const typeInfo = PAGE_TYPE_LABELS[pageType] || { icon: '', label: pageType };
    return (
      <div className="video-info">
        <div className="video-info__badge">
          {typeInfo.icon} {typeInfo.label}
        </div>
        <div className="video-info__title" title={content.title}>
          {content.title}
        </div>
        <div className="video-info__meta">
          <span>{batchCount ?? 0} videos found</span>
        </div>
        {(batchCount ?? 0) < 5 && (
          <div className="video-info__hint">
            Scroll down on YouTube to load more videos, then reopen VideoLM.
          </div>
        )}
      </div>
    );
  }

  // Single video (watch page)
  const chapterCount = content.chapters?.length ?? 0;
  const hasSubtitles = content.transcript.length > 0;

  return (
    <div className="video-info">
      <div className="video-info__title" title={content.title}>
        {content.title}
      </div>
      <div className="video-info__meta">
        <span>{formatDuration(content.duration)}</span>
        {chapterCount > 0 && <span>{chapterCount} chapters</span>}
        <span>{content.language}</span>
        <span>{hasSubtitles ? '\u2713 subtitles' : 'no subtitles'}</span>
      </div>
    </div>
  );
}
