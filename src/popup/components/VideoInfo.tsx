import React from 'react';
import type { VideoContent } from '@/types';
import type { PageType } from '../hooks/useVideoContent';
import { t } from '@/utils/i18n';

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

const PAGE_TYPE_LABELS: Record<string, { icon: string; labelKey: string }> = {
  playlist: { icon: '\uD83D\uDCCB', labelKey: 'video_type_playlist' },
  channel: { icon: '\uD83D\uDCFA', labelKey: 'video_type_channel' },
  search: { icon: '\uD83D\uDD0D', labelKey: 'video_type_search' },
};

export function VideoInfo({ content, pageType, batchCount }: VideoInfoProps) {
  const isBatch = pageType && pageType !== 'watch' && pageType !== 'unknown';

  if (isBatch) {
    const typeInfo = PAGE_TYPE_LABELS[pageType] || { icon: '', labelKey: pageType };
    return (
      <div className="video-info">
        <div className="video-info__badge">
          {typeInfo.icon} {t(typeInfo.labelKey)}
        </div>
        <div className="video-info__title" title={content.title}>
          {content.title}
        </div>
        <div className="video-info__meta">
          <span>{t('video_count_found', [(batchCount ?? 0).toString()])}</span>
        </div>
        {(batchCount ?? 0) < 5 && (
          <div className="video-info__hint">
            {t('video_hint_scroll')}
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
        {chapterCount > 0 && <span>{t('video_chapters', [chapterCount.toString()])}</span>}
        <span>{content.language}</span>
        <span>{hasSubtitles ? t('video_subtitles_yes') : t('video_subtitles_no')}</span>
      </div>
    </div>
  );
}
