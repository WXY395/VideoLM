import React from 'react';

interface ImportButtonProps {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  remainingImports?: number;
}

export function ImportButton({ onClick, loading, disabled, remainingImports }: ImportButtonProps) {
  return (
    <div>
      <button
        className="import-button"
        onClick={onClick}
        disabled={disabled || loading}
      >
        {loading ? 'Processing...' : 'Import to NotebookLM'}
      </button>
      {remainingImports != null && (
        <div className="import-remaining">
          {remainingImports} imports remaining
        </div>
      )}
    </div>
  );
}
