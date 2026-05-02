import React, { useState, useCallback, useEffect } from 'react';
import type { ImportMode, ImportResult } from '@/types';
import { t } from '@/utils/i18n';
import { useVideoContent } from './hooks/useVideoContent';
import { useSettings } from './hooks/useSettings';
import { VideoInfo } from './components/VideoInfo';
import { ModeSelector } from './components/ModeSelector';
import { ImportButton } from './components/ImportButton';
import { BatchInfo } from './components/BatchInfo';
import { ProgressBar, type ProgressStatus } from './components/ProgressBar';
import { DuplicateWarning, type DuplicateAction } from './components/DuplicateWarning';
import { NotebookChoice } from './components/NotebookChoice';
import { SettingsPage } from './components/SettingsPage';
import { NotionExportPanel } from './components/NotionExportPanel';
import { MAX_BATCH_SIZE } from '@/background/batch-queue';
import { createVideoSourceRecord } from '@/utils/source-resolution';
import './styles.css';

const FREE_MONTHLY_LIMIT = 100;
// H-5 FIX: MAX_BATCH_SIZE imported from batch-queue (single source of truth)

/** NEW-3 FIX: Safe sendMessage wrapper — checks chrome.runtime.lastError */
function safeSendMsg(msg: any, cb: (r: any) => void): void {
  chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) {
      console.log('[VideoLM popup]', chrome.runtime.lastError.message);
    }
    cb(r);
  });
}

interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

export function App() {
  const { content, loading: contentLoading, error: contentError, batchUrls, pageType, pageTitle } = useVideoContent();
  const { settings, updateSettings, refreshEntitlement } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const [mode, setMode] = useState<ImportMode>('quick');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ items: ProgressItem[]; completed: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [duplicateTitle, setDuplicateTitle] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<{ remaining: number; pageTitle: string } | null>(null);
  const [lastClipboardText, setLastClipboardText] = useState<string | null>(null);
  const [notebookChoice, setNotebookChoice] = useState<{
    notebook: { id: string; name: string; sourceCount: number; emoji: string };
    urls: string[];
    pageTitle: string;
    authuser: string;
  } | null>(null);

  const isBatchPage = pageType === 'playlist' || pageType === 'channel' || pageType === 'search';
  const hasAI = Boolean(settings?.tier === 'pro' || settings?.byok);

  // Fall back to raw mode if AI not available and current mode requires it
  // Quick mode never needs AI -- it passes the URL directly to NotebookLM
  // Batch pages always use quick mode
  const effectiveMode = isBatchPage
    ? 'quick'
    : (!hasAI && mode !== 'raw' && mode !== 'quick') ? 'raw' : mode;

  const remainingImports = settings
    ? FREE_MONTHLY_LIMIT - (settings.monthlyUsage?.imports ?? 0)
    : undefined;

  // Check for import status + pending queue on popup open
  // L-3 FIX: Removed unused importStatus state — status is only used for side effects

  useEffect(() => {
    // Check if there's an active or completed import
    safeSendMsg({ type: 'GET_IMPORT_STATUS' }, (status) => {
      if (status) {
        // If import is active, show as importing
        if (status.active) {
          setImporting(true);
        }
        // If completed with result, show the result
        if (status.completed && status.completionMessage) {
          setResult({
            success: !status.lastError,
            tier: 1,
            message: status.completionMessage,
            error: status.lastError,
            manual: status.needsNewNotebook,
          } as any);
        }
        // If needs new notebook, show resume prompt
        if (status.needsNewNotebook && status.remainingCount) {
          setPendingQueue({ remaining: status.remainingCount, pageTitle: status.pageTitle });
        }
      }
    });

    // Check for pending notebook choice (ask-mode dedup)
    safeSendMsg({ type: 'GET_NOTEBOOK_CHOICE' }, (response) => {
      if (response?.existingNotebook) {
        setNotebookChoice(response);
        setImporting(false); // Stop "importing" state — show choice instead
      }
    });

    // Also check pending queue
    safeSendMsg({ type: 'CHECK_PENDING_QUEUE' }, (response) => {
      if (response?.hasPending && response.remainingUrls > 0) {
        setPendingQueue({ remaining: response.remainingUrls, pageTitle: response.pageTitle || 'Batch Import' });
      }
    });
  }, []);

  const handleBatchImport = useCallback((urls: string[]) => {
    setImporting(true);
    setResult(null);
    setProgress(null);

    const items: ProgressItem[] = urls.map((_url, i) => ({
      title: `Video ${i + 1}`,
      status: 'pending' as ProgressStatus,
    }));
    setProgress({ items, completed: 0, total: urls.length });

    safeSendMsg(
      {
        type: 'BATCH_IMPORT',
        urls,
        pageTitle,
      },
      (response) => {
        // Handle ask-mode: background found a matching notebook
        if (response?.needsUserChoice && response.existingNotebook) {
          setNotebookChoice({
            notebook: response.existingNotebook,
            urls: response.urls,
            pageTitle: response.pageTitle,
            authuser: response.authuser || '',
          });
          setImporting(false);
          setProgress(null);
          return;
        }
        // The background responds immediately, then continues importing
        if (response?.importing) {
          // Import started in background — show badge progress
          setResult({
            success: true,
            tier: 1,
            message: response.message || `Importing ${urls.length} videos in background... You can close this popup.`,
          });
          setImporting(false);
        } else if (response?.success) {
          setImporting(false);
          setResult({
            success: true,
            tier: 1,
            message: response.message,
          });
        } else {
          setImporting(false);
          setResult({
            success: false,
            tier: 3,
            error: response?.error || 'Batch import failed.',
          });
        }
      }
    );
  }, [pageTitle]);

  const handleImportAll = useCallback(() => {
    handleBatchImport(batchUrls);
  }, [batchUrls, handleBatchImport]);

  const handleImportFirst50 = useCallback(() => {
    handleBatchImport(batchUrls.slice(0, MAX_BATCH_SIZE));
  }, [batchUrls, handleBatchImport]);

  const handleResumeBatch = useCallback(() => {
    setImporting(true);
    setPendingQueue(null);
    safeSendMsg({ type: 'RESUME_BATCH' }, (response) => {
      setImporting(false);
      if (response?.success) {
        setResult({
          success: true,
          tier: 1,
          message: response.message || 'Batch import resumed!',
        });
      } else {
        setResult({
          success: false,
          tier: 3,
          error: response?.error || 'Failed to resume batch.',
        });
      }
    });
  }, []);

  const handleMergeChoice = useCallback(() => {
    if (!notebookChoice) return;
    setNotebookChoice(null);
    setImporting(true);
    setResult(null);
    safeSendMsg({ type: 'CLEAR_NOTEBOOK_CHOICE' }, () => {});
    safeSendMsg(
      {
        type: 'BATCH_IMPORT_WITH_TARGET',
        urls: notebookChoice.urls,
        pageTitle: notebookChoice.pageTitle,
        targetNotebookId: notebookChoice.notebook.id,
        authuser: notebookChoice.authuser,
        existingSourceCount: notebookChoice.notebook.sourceCount,
      },
      (response) => {
        if (response?.importing) {
          setResult({ success: true, tier: 1, message: 'Merging in background... Check badge for progress.' });
          setImporting(false);
        } else {
          setImporting(false);
          setResult({ success: response?.success, tier: 1, message: response?.message, error: response?.error });
        }
      }
    );
  }, [notebookChoice]);

  const handleCreateNewChoice = useCallback(() => {
    if (!notebookChoice) return;
    safeSendMsg({ type: 'CLEAR_NOTEBOOK_CHOICE' }, () => {});
    const { urls } = notebookChoice;
    setNotebookChoice(null);
    handleBatchImport(urls);
  }, [notebookChoice, handleBatchImport]);

  const handleImport = useCallback(() => {
    if (!content) return;

    setImporting(true);
    setResult(null);
    setProgress(null);

    // Quick Import: send URL directly, no transcript extraction needed
    if (effectiveMode === 'quick') {
      safeSendMsg(
        {
          type: 'QUICK_IMPORT',
          videoUrl: content.url,
          videoTitle: content.title,
        },
        async (response) => {
          setImporting(false);

          // Always copy URL to clipboard (for fallback manual paste)
          if (response?.clipboardText) {
            try { await navigator.clipboard.writeText(response.clipboardText); } catch {}
          }

          if (response?.success) {
            // Store source record for citation resolution
            const sourceRecord = createVideoSourceRecord(content.videoId, content.title, content.author, content.url);
            safeSendMsg({ type: 'STORE_SOURCE_RECORD', record: sourceRecord }, () => {});

            setResult({
              success: true,
              tier: 1,
              message: response.message || 'Added to NotebookLM!',
            });
          } else {
            // Even on failure, URL is copied as fallback
            if (!response?.clipboardText && content.url) {
              try { await navigator.clipboard.writeText(content.url); } catch {}
            }
            setResult({
              success: false,
              tier: 3,
              manual: true,
              error: response?.error || 'Import failed. URL copied to clipboard.',
            });
          }
        }
      );
      return;
    }

    // For chapter mode, set up progress items
    if (effectiveMode === 'chapters' && content.chapters?.length) {
      const items: ProgressItem[] = content.chapters.map((ch) => ({
        title: ch.title,
        status: 'pending' as ProgressStatus,
      }));
      setProgress({ items, completed: 0, total: items.length });
    }

    safeSendMsg(
      {
        type: 'PROCESS_AND_IMPORT',
        videoContent: content,
        options: { mode: effectiveMode },
      },
      async (response) => {
        setImporting(false);

        if (response?.success) {
          // Store source record for citation resolution
          const sourceRecord2 = createVideoSourceRecord(content.videoId, content.title, content.author, content.url);
          safeSendMsg({ type: 'STORE_SOURCE_RECORD', record: sourceRecord2 }, () => {});

          // Copy processed content to clipboard
          if (response.clipboardText) {
            try {
              await navigator.clipboard.writeText(response.clipboardText);
            } catch {
              // Clipboard write may fail -- content is still in response
            }
            // Save for Notion export panel
            setLastClipboardText(response.clipboardText);
          }

          setResult({
            success: true,
            tier: 3,
            manual: true,
            message: response.message || 'Content copied to clipboard! Paste into NotebookLM as a "Copied text" source.',
          });

          // H-11 FIX: Use functional updater — avoids stale `progress` closure
          setProgress((prev) =>
            prev
              ? {
                  ...prev,
                  completed: prev.total,
                  items: prev.items.map((it) => ({ ...it, status: 'done' as ProgressStatus })),
                }
              : null
          );
        } else {
          setResult({
            success: false,
            tier: 3,
            error: response?.error || 'Import failed.',
          });
        }
      }
    );
  }, [content, effectiveMode]);

  const handleDuplicateAction = useCallback(
    (action: DuplicateAction) => {
      setDuplicateTitle(null);
      if (action === 'skip') return;
      // For overwrite or new, proceed with import
      handleImport();
    },
    [handleImport]
  );

  if (showSettings && settings) {
    return (
      <div className="popup">
        <SettingsPage
          settings={settings}
          onSave={updateSettings}
          onRefreshEntitlement={refreshEntitlement}
          onBack={() => setShowSettings(false)}
        />
      </div>
    );
  }

  return (
    <div className="popup">
      <div className="popup-header">
        <div className="popup-header__row">
          <div>
            <h1>{t('popup_title')}</h1>
            <p>{t('popup_subtitle')}</p>
          </div>
          <button
            className="settings-gear"
            onClick={() => setShowSettings(true)}
            aria-label={t('popup_settings')}
            title={t('popup_settings')}
          >
            &#9881;
          </button>
        </div>
      </div>

      <hr className="popup-divider" />

      {/* Pending batch queue resume prompt */}
      {pendingQueue && !importing && (
        <div className="batch-resume">
          <div className="batch-resume__text">
            {t('popup_batch_resume', [pendingQueue.remaining.toString(), pendingQueue.pageTitle])}
          </div>
          <div className="batch-resume__actions">
            <button
              className="batch-resume__button"
              onClick={handleResumeBatch}
            >
              {t('popup_resume_import')}
            </button>
            <button
              className="batch-resume__button batch-resume__button--dismiss"
              onClick={() => setPendingQueue(null)}
            >
              {t('popup_dismiss')}
            </button>
          </div>
        </div>
      )}

      {contentLoading && (
        <div className="loading-state">
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          {isBatchPage ? t('popup_extracting_urls') : t('popup_loading_video')}
        </div>
      )}

      {contentError && (
        <div className="error-state">
          <div className="error-state__icon">!</div>
          <div className="error-state__title">{t('popup_cannot_import')}</div>
          <div>{contentError}</div>
        </div>
      )}

      {content && !contentLoading && (
        <>
          <VideoInfo
            content={content}
            pageType={pageType}
            batchCount={isBatchPage ? batchUrls.length : undefined}
          />

          {isBatchPage ? (
            /* Batch page: show batch-specific controls */
            <BatchInfo
              pageType={pageType as 'playlist' | 'channel' | 'search'}
              pageTitle={pageTitle}
              videoCount={batchUrls.length}
              onImportAll={handleImportAll}
              onImportFirst50={handleImportFirst50}
              importing={importing}
            />
          ) : (
            /* Single watch page: show mode selector + import button */
            <>
              <ModeSelector value={effectiveMode} onChange={setMode} hasAI={hasAI} />

              {effectiveMode === 'quick' && (
                <div className="quick-import-url">
                  URL: {content.url}
                </div>
              )}

              {effectiveMode !== 'quick' && content.transcript.length === 0 && (
                <div className="status-message status-message--error">
                  {t('popup_no_subtitles')}
                </div>
              )}

              <ImportButton
                onClick={handleImport}
                loading={importing}
                disabled={!content || (effectiveMode !== 'quick' && content.transcript.length === 0)}
                remainingImports={remainingImports}
              />
            </>
          )}

          {progress && (
            <ProgressBar
              items={progress.items}
              completed={progress.completed}
              total={progress.total}
            />
          )}

          {duplicateTitle && (
            <DuplicateWarning
              existingTitle={duplicateTitle}
              onAction={handleDuplicateAction}
            />
          )}

          {notebookChoice && !importing && (
            <NotebookChoice
              notebook={notebookChoice.notebook}
              pageTitle={notebookChoice.pageTitle}
              videoCount={notebookChoice.urls.length}
              onMerge={handleMergeChoice}
              onCreateNew={handleCreateNewChoice}
            />
          )}

          {result && (
            <div
              className={`status-message ${
                result.success ? 'status-message--success' : 'status-message--error'
              }`}
            >
              {result.success
                ? result.message ?? t('popup_imported_success')
                : result.error ?? t('popup_import_failed')}
            </div>
          )}

          {/* Notion Export — appears after successful import with text content */}
          {result?.success && content && lastClipboardText && (
            <NotionExportPanel
              videoContent={content}
              clipboardText={lastClipboardText}
            />
          )}
        </>
      )}
    </div>
  );
}
