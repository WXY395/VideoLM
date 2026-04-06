/**
 * NotionExportPanel — Notion-Ready Smart Export UI
 *
 * Appears after a successful import. Provides 3 toggles and a "Copy for Notion"
 * button that transforms content into Notion-optimized Markdown.
 *
 * The panel sends NOTION_EXPORT to the service worker (which runs the pure-function
 * pipeline from notion-sync.ts) and writes the result to the clipboard.
 */

import React, { useState, useCallback } from 'react';
import type { VideoContent, NotionExportOptions, NotionExportResult } from '@/types';
import { t } from '@/utils/i18n';

interface NotionExportPanelProps {
  /** The video content from the current import */
  videoContent: VideoContent;
  /** The raw text content (clipboardText from import, or formatted transcript) */
  clipboardText?: string;
}

type CopyState = 'idle' | 'copying' | 'success' | 'error';

/** Send message to service worker (promise-based) */
function sendMsg<T = any>(msg: any): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        console.log('[VideoLM NotionExport]', chrome.runtime.lastError.message);
      }
      resolve(r);
    });
  });
}

export function NotionExportPanel({ videoContent, clipboardText }: NotionExportPanelProps) {
  const [options, setOptions] = useState<NotionExportOptions>({
    includeCallout: true,
    includeCheckboxes: true,
    includeTimestampLinks: true,
  });
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [lastResult, setLastResult] = useState<{ resolved: number; total: number } | null>(null);

  const toggleOption = useCallback((key: keyof NotionExportOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleCopy = useCallback(async () => {
    if (!clipboardText || copyState === 'copying') return;

    setCopyState('copying');

    try {
      // Store videoContent for potential NLM page use (Phase 3)
      sendMsg({ type: 'STORE_VIDEO_CONTENT', videoContent });

      // Run the Notion export pipeline via service worker
      const result = await sendMsg<NotionExportResult & { error?: string }>({
        type: 'NOTION_EXPORT',
        content: clipboardText,
        videoContent,
        options,
      });

      if (result?.error) {
        setCopyState('error');
        setTimeout(() => setCopyState('idle'), 2000);
        return;
      }

      // Write to clipboard
      await navigator.clipboard.writeText(result.markdown);

      // Track citation stats
      setLastResult({
        resolved: result.citationsResolved,
        total: result.citationsTotal,
      });

      // Green checkmark for 2 seconds
      setCopyState('success');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      console.error('[VideoLM NotionExport] Copy failed:', err);
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [clipboardText, videoContent, options, copyState]);

  const isDisabled = !clipboardText;

  return (
    <div className="notion-export">
      <div className="notion-export__header">
        <span className="notion-export__title">{t('notion_section_title')}</span>
      </div>

      <div className="notion-export__toggles">
        <label className="notion-export__toggle">
          <input
            type="checkbox"
            checked={options.includeCallout}
            onChange={() => toggleOption('includeCallout')}
          />
          <span>{t('notion_opt_callout')}</span>
        </label>
        <label className="notion-export__toggle">
          <input
            type="checkbox"
            checked={options.includeCheckboxes}
            onChange={() => toggleOption('includeCheckboxes')}
          />
          <span>{t('notion_opt_checkboxes')}</span>
        </label>
        <label className="notion-export__toggle">
          <input
            type="checkbox"
            checked={options.includeTimestampLinks}
            onChange={() => toggleOption('includeTimestampLinks')}
          />
          <span>{t('notion_opt_timestamps')}</span>
        </label>
      </div>

      <button
        className={`notion-export__btn ${
          copyState === 'success'
            ? 'notion-export__btn--success'
            : copyState === 'error'
            ? 'notion-export__btn--error'
            : ''
        }`}
        onClick={handleCopy}
        disabled={isDisabled || copyState === 'copying'}
      >
        {copyState === 'copying'
          ? t('notion_btn_copying')
          : copyState === 'success'
          ? '\u2714'
          : copyState === 'error'
          ? t('notion_copy_failed')
          : t('notion_btn_copy')}
      </button>

      {/* Citation stats — shown after successful copy */}
      {copyState === 'success' && lastResult && lastResult.total > 0 && (
        <div className="notion-export__stats">
          {t('notion_copied_success', [
            lastResult.resolved.toString(),
            lastResult.total.toString(),
          ])}
        </div>
      )}
      {copyState === 'success' && lastResult && lastResult.total === 0 && (
        <div className="notion-export__stats">
          {t('notion_copied_no_citations')}
        </div>
      )}
    </div>
  );
}
