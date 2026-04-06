import React from 'react';
import type { ImportMode } from '@/types';
import { t } from '@/utils/i18n';

interface ModeSelectorProps {
  value: ImportMode;
  onChange: (mode: ImportMode) => void;
  hasAI: boolean;
}

const modes: Array<{ value: ImportMode; labelKey: string; descKey?: string; needsAI: boolean }> = [
  { value: 'quick', labelKey: 'mode_quick', descKey: 'mode_quick_desc', needsAI: false },
  { value: 'raw', labelKey: 'mode_raw', needsAI: false },
  { value: 'structured', labelKey: 'mode_structured', needsAI: true },
  { value: 'summary', labelKey: 'mode_summary', needsAI: true },
  { value: 'chapters', labelKey: 'mode_chapters', needsAI: true },
];

export function ModeSelector({ value, onChange, hasAI }: ModeSelectorProps) {
  return (
    <div className="mode-selector">
      <div className="mode-selector__label">{t('mode_label')}</div>
      {modes.map((mode) => {
        const disabled = mode.needsAI && !hasAI;
        return (
          <label
            key={mode.value}
            className={`mode-option${disabled ? ' mode-option--disabled' : ''}`}
          >
            <input
              type="radio"
              name="importMode"
              value={mode.value}
              checked={value === mode.value}
              disabled={disabled}
              onChange={() => onChange(mode.value)}
            />
            {t(mode.labelKey)}
            {mode.descKey && (
              <span className="mode-option__desc">{t(mode.descKey)}</span>
            )}
            {disabled && (
              <span className="mode-option__badge">{t('mode_needs_ai')}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
