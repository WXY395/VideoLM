import React, { useState, useCallback, useEffect } from 'react';
import type { ImportMode, ImportResult } from '@/types';
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
import './styles.css';

const FREE_MONTHLY_LIMIT = 100;
const MAX_BATCH_SIZE = 50;

interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

export function App() {
  const { content, loading: contentLoading, error: contentError, batchUrls, pageType, pageTitle } = useVideoContent();
  const { settings, updateSettings } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const [mode, setMode] = useState<ImportMode>('quick');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ items: ProgressItem[]; completed: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [duplicateTitle, setDuplicateTitle] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<{ remaining: number; pageTitle: string } | null>(null);
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
  const [importStatus, setImportStatusState] = useState<any>(null);

  useEffect(() => {
    // Check if there's an active or completed import
    chrome.runtime.sendMessage({ type: 'GET_IMPORT_STATUS' }, (status) => {
      if (status) {
        setImportStatusState(status);
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
    chrome.runtime.sendMessage({ type: 'GET_NOTEBOOK_CHOICE' }, (response) => {
      if (response?.existingNotebook) {
        setNotebookChoice(response);
        setImporting(false); // Stop "importing" state — show choice instead
      }
    });

    // Also check pending queue
    chrome.runtime.sendMessage({ type: 'CHECK_PENDING_QUEUE' }, (response) => {
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

    chrome.runtime.sendMessage(
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
    chrome.runtime.sendMessage({ type: 'RESUME_BATCH' }, (response) => {
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
    chrome.runtime.sendMessage({ type: 'CLEAR_NOTEBOOK_CHOICE' });
    chrome.runtime.sendMessage(
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
    chrome.runtime.sendMessage({ type: 'CLEAR_NOTEBOOK_CHOICE' });
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
      chrome.runtime.sendMessage(
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

    chrome.runtime.sendMessage(
      {
        type: 'PROCESS_AND_IMPORT',
        videoContent: content,
        options: { mode: effectiveMode },
      },
      async (response) => {
        setImporting(false);

        if (response?.success) {
          // Copy processed content to clipboard
          if (response.clipboardText) {
            try {
              await navigator.clipboard.writeText(response.clipboardText);
            } catch {
              // Clipboard write may fail -- content is still in response
            }
          }

          setResult({
            success: true,
            tier: 3,
            manual: true,
            message: response.message || 'Content copied to clipboard! Paste into NotebookLM as a "Copied text" source.',
          });

          // Mark progress items as done
          if (progress) {
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    completed: prev.total,
                    items: prev.items.map((it) => ({ ...it, status: 'done' as ProgressStatus })),
                  }
                : null
            );
          }
        } else {
          setResult({
            success: false,
            tier: 3,
            error: response?.error || 'Import failed.',
          });
        }
      }
    );
  }, [content, effectiveMode, progress]);

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
            <h1>VideoLM</h1>
            <p>AI Video to NotebookLM</p>
          </div>
          <button
            className="settings-gear"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Settings"
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
            Previous batch import has {pendingQueue.remaining} videos remaining
            ({pendingQueue.pageTitle}).
          </div>
          <div className="batch-resume__actions">
            <button
              className="batch-resume__button"
              onClick={handleResumeBatch}
            >
              Resume Import
            </button>
            <button
              className="batch-resume__button batch-resume__button--dismiss"
              onClick={() => setPendingQueue(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {contentLoading && (
        <div className="loading-state">
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          {isBatchPage ? 'Extracting video URLs...' : 'Loading video info...'}
        </div>
      )}

      {contentError && (
        <div className="error-state">
          <div className="error-state__icon">!</div>
          <div className="error-state__title">Cannot import</div>
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
                  This video has no subtitles available. Transcript-based modes require subtitles (CC).
                  Try Quick Import or a video with the CC icon enabled.
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
                ? result.message ?? 'Imported successfully!'
                : result.error ?? 'Import failed.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
