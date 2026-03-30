import React from 'react';
import type { VideoContent } from '@/types';

interface VideoInfoProps {
  content: VideoContent;
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

export function VideoInfo({ content }: VideoInfoProps) {
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
