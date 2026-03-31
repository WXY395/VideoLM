import React from 'react';

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
          NotebookLM supports up to {MAX_BATCH_SIZE} sources per notebook.
          This {pageType} has {videoCount} videos.
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
              {importing ? 'Importing...' : `Import first ${MAX_BATCH_SIZE} only`}
            </button>
            <button
              className="batch-info__button batch-info__button--primary"
              onClick={onImportAll}
              disabled={importing}
            >
              {importing
                ? 'Importing...'
                : `Auto-split into ${notebookCount} notebooks`}
            </button>
          </>
        ) : (
          <button
            className="batch-info__button batch-info__button--primary batch-info__button--full"
            onClick={onImportAll}
            disabled={importing || videoCount === 0}
          >
            {importing
              ? 'Importing...'
              : `Import ${videoCount} Videos to NotebookLM`}
          </button>
        )}
      </div>
    </div>
  );
}
