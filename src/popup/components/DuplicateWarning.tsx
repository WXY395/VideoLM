import React from 'react';
import { t } from '@/utils/i18n';

export type DuplicateAction = 'overwrite' | 'new' | 'skip';

interface DuplicateWarningProps {
  existingTitle: string;
  onAction: (action: DuplicateAction) => void;
}

export function DuplicateWarning({ existingTitle, onAction }: DuplicateWarningProps) {
  return (
    <div className="duplicate-warning">
      <div className="duplicate-warning__title">{t('dup_title')}</div>
      <div className="duplicate-warning__message">
        {t('dup_message', [existingTitle])}
      </div>
      <div className="duplicate-warning__actions">
        <button onClick={() => onAction('overwrite')}>{t('dup_overwrite')}</button>
        <button onClick={() => onAction('new')}>{t('dup_save_new')}</button>
        <button onClick={() => onAction('skip')}>{t('dup_skip')}</button>
      </div>
    </div>
  );
}
