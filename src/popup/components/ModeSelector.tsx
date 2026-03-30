import React from 'react';
import type { ImportMode } from '@/types';

interface ModeSelectorProps {
  value: ImportMode;
  onChange: (mode: ImportMode) => void;
  hasAI: boolean;
}

const modes: Array<{ value: ImportMode; label: string; needsAI: boolean }> = [
  { value: 'raw', label: 'Raw Transcript', needsAI: false },
  { value: 'structured', label: 'AI Structured', needsAI: true },
  { value: 'summary', label: 'AI Summary', needsAI: true },
  { value: 'chapters', label: 'Chapter Split', needsAI: true },
];

export function ModeSelector({ value, onChange, hasAI }: ModeSelectorProps) {
  return (
    <div className="mode-selector">
      <div className="mode-selector__label">Import Mode</div>
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
            {mode.label}
            {disabled && (
              <span className="mode-option__badge">Needs API Key or Pro</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
