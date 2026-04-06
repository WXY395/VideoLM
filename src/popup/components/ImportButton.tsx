import React from 'react';
import { t } from '@/utils/i18n';

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
        {loading ? t('common_processing') : t('import_btn_label')}
      </button>
      {remainingImports != null && (
        <div className="import-remaining">
          {t('import_remaining', [remainingImports.toString()])}
        </div>
      )}
    </div>
  );
}
