import React from 'react';
import { t } from '@/utils/i18n';

interface BatchInfoProps {
  pageType: 'playlist' | 'channel' | 'search';
  pageTitle: string;
  videoCount: number;
  onImportAll: () => void;
  onImportFirst50: () => void;
  importing: boolean;
}

const MAX_BATCH_SIZE = 50;

export function BatchInfo({
  pageType,
  pageTitle,
  videoCount,
  onImportAll,
  onImportFirst50,
  importing,
}: BatchInfoProps) {
  const needsSplit = videoCount > MAX_BATCH_SIZE;
  const notebookCount = Math.ceil(videoCount / MAX_BATCH_SIZE);

  return (
    <div className="batch-info">
      {needsSplit && (
        <div className="batch-info__warning">
          {t('batch_size_warning', [MAX_BATCH_SIZE.toString(), pageType, videoCount.toString()])}
        </div>
      )}

      <div className="batch-info__actions">
        {needsSplit ? (
          <>
            <button
              className="batch-info__button batch-info__button--secondary"
              onClick={onImportFirst50}
              disabled={importing}
            >
              {importing ? t('common_importing') : t('batch_import_first', [MAX_BATCH_SIZE.toString()])}
            </button>
            <button
              className="batch-info__button batch-info__button--primary"
              onClick={onImportAll}
              disabled={importing}
            >
              {importing
                ? t('common_importing')
                : t('batch_auto_split', [notebookCount.toString()])}
            </button>
          </>
        ) : (
          <button
            className="batch-info__button batch-info__button--primary batch-info__button--full"
            onClick={onImportAll}
            disabled={importing || videoCount === 0}
          >
            {importing
              ? t('common_importing')
              : t('batch_import_all', [videoCount.toString()])}
          </button>
        )}
      </div>
    </div>
  );
}
