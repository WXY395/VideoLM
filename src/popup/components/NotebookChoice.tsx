import React from 'react';

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
      <div className="notebook-choice__title">Existing notebook found</div>
      <div className="notebook-choice__notebook">
        <span className="notebook-choice__emoji">{notebook.emoji || '\uD83D\uDCD4'}</span>
        <div>
          <div className="notebook-choice__name">{notebook.name}</div>
          <div className="notebook-choice__meta">
            {notebook.sourceCount} sources
            {willOverflow && ` \u00B7 ${availableSlots} slots available`}
          </div>
        </div>
      </div>
      <div className="notebook-choice__actions">
        <button className="notebook-choice__btn notebook-choice__btn--merge" onClick={onMerge}>
          Merge ({videoCount} videos)
        </button>
        <button className="notebook-choice__btn notebook-choice__btn--create" onClick={onCreateNew}>
          Create New
        </button>
      </div>
      {willOverflow && (
        <div className="notebook-choice__hint">
          Overflow videos will auto-create &ldquo;{pageTitle} - Part 2&rdquo;
        </div>
      )}
    </div>
  );
}
