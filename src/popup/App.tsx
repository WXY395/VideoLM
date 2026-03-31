import React, { useState, useCallback } from 'react';
import type { ImportMode, ImportResult } from '@/types';
import { useVideoContent } from './hooks/useVideoContent';
import { useSettings } from './hooks/useSettings';
import { VideoInfo } from './components/VideoInfo';
import { ModeSelector } from './components/ModeSelector';
import { ImportButton } from './components/ImportButton';
import { ProgressBar, type ProgressStatus } from './components/ProgressBar';
import { DuplicateWarning, type DuplicateAction } from './components/DuplicateWarning';
import { SettingsPage } from './components/SettingsPage';
import './styles.css';

const FREE_MONTHLY_LIMIT = 30;

interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

export function App() {
  const { content, loading: contentLoading, error: contentError } = useVideoContent();
  const { settings, updateSettings } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const [mode, setMode] = useState<ImportMode>('structured');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ items: ProgressItem[]; completed: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [duplicateTitle, setDuplicateTitle] = useState<string | null>(null);

  const hasAI = Boolean(settings?.tier === 'pro' || settings?.byok);

  // Fall back to raw mode if AI not available and current mode requires it
  const effectiveMode = (!hasAI && mode !== 'raw') ? 'raw' : mode;

  const remainingImports = settings
    ? FREE_MONTHLY_LIMIT - (settings.monthlyUsage?.imports ?? 0)
    : undefined;

  const handleImport = useCallback(() => {
    if (!content) return;

    setImporting(true);
    setResult(null);
    setProgress(null);

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
              // Clipboard write may fail — content is still in response
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

      {contentLoading && (
        <div className="loading-state">
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          Loading video info...
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
          <VideoInfo content={content} />

          {content.transcript.length === 0 && (
            <div className="status-message status-message--error">
              This video has no subtitles available. VideoLM requires subtitles (CC) to extract content.
              Try a video with the CC icon enabled.
            </div>
          )}

          {content.transcript.length > 0 && (
            <ModeSelector value={effectiveMode} onChange={setMode} hasAI={hasAI} />
          )}

          <ImportButton
            onClick={handleImport}
            loading={importing}
            disabled={!content || content.transcript.length === 0}
            remainingImports={remainingImports}
          />

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
