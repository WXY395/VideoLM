import React from 'react';

export type DuplicateAction = 'overwrite' | 'new' | 'skip';

interface DuplicateWarningProps {
  existingTitle: string;
  onAction: (action: DuplicateAction) => void;
}

export function DuplicateWarning({ existingTitle, onAction }: DuplicateWarningProps) {
  return (
    <div className="duplicate-warning">
      <div className="duplicate-warning__title">Duplicate detected</div>
      <div className="duplicate-warning__message">
        A source with a similar title already exists: &ldquo;{existingTitle}&rdquo;
      </div>
      <div className="duplicate-warning__actions">
        <button onClick={() => onAction('overwrite')}>Overwrite</button>
        <button onClick={() => onAction('new')}>Save as New</button>
        <button onClick={() => onAction('skip')}>Skip</button>
      </div>
    </div>
  );
}
