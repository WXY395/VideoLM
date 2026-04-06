import React from 'react';
import { t } from '@/utils/i18n';

interface NotebookChoiceProps {
  notebook: { id: string; name: string; sourceCount: number; emoji: string };
  pageTitle: string;
  videoCount: number;
  onMerge: () => void;
  onCreateNew: () => void;
}

export function NotebookChoice({ notebook, pageTitle, videoCount, onMerge, onCreateNew }: NotebookChoiceProps) {
  const availableSlots = 50 - notebook.sourceCount;
  const willOverflow = videoCount > availableSlots;

  return (
    <div className="notebook-choice">
      <div className="notebook-choice__title">{t('notebook_choice_title')}</div>
      <div className="notebook-choice__notebook">
        <span className="notebook-choice__emoji">{notebook.emoji || '\uD83D\uDCD4'}</span>
        <div>
          <div className="notebook-choice__name">{notebook.name}</div>
          <div className="notebook-choice__meta">
            {t('notebook_choice_sources', [notebook.sourceCount.toString()])}
            {willOverflow && ` \u00B7 ${t('notebook_choice_slots', [availableSlots.toString()])}`}
          </div>
        </div>
      </div>
      <div className="notebook-choice__actions">
        <button className="notebook-choice__btn notebook-choice__btn--merge" onClick={onMerge}>
          {t('notebook_choice_merge', [videoCount.toString()])}
        </button>
        <button className="notebook-choice__btn notebook-choice__btn--create" onClick={onCreateNew}>
          {t('notebook_choice_create')}
        </button>
      </div>
      {willOverflow && (
        <div className="notebook-choice__hint">
          {t('notebook_choice_overflow', [pageTitle])}
        </div>
      )}
    </div>
  );
}
