import React, { useState } from 'react';
import type { UserSettings, AIProviderType, BYOKConfig, DuplicateStrategy } from '@/types';

interface SettingsPageProps {
  settings: UserSettings;
  onSave: (partial: Partial<UserSettings>) => void;
  onBack: () => void;
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
};

export function SettingsPage({ settings, onSave, onBack }: SettingsPageProps) {
  const [provider, setProvider] = useState<AIProviderType>(
    settings.byok?.provider ?? 'openai'
  );
  const [apiKey, setApiKey] = useState(settings.byok?.apiKey ?? '');
  const [model, setModel] = useState(settings.byok?.model ?? '');
  const [dupStrategy, setDupStrategy] = useState<DuplicateStrategy>(
    settings.duplicateStrategy ?? 'ask'
  );
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const byok: BYOKConfig | undefined = apiKey.trim()
      ? {
          provider,
          apiKey: apiKey.trim(),
          model: model.trim() || undefined,
        }
      : undefined;

    onSave({ byok, duplicateStrategy: dupStrategy });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="settings-page">
      <button className="back-button" onClick={onBack}>
        &larr; Back
      </button>

      <h2 className="settings-title">Settings</h2>

      <div className="settings-section">
        <label className="settings-label" htmlFor="provider-select">
          AI Provider
        </label>
        <select
          id="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AIProviderType)}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="api-key-input">
          API Key
        </label>
        <input
          id="api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="model-input">
          Model (optional)
        </label>
        <input
          id="model-input"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={DEFAULT_MODELS[provider] ?? 'default'}
        />
      </div>

      <div className="settings-section">
        <label className="settings-label">When a same-name notebook exists</label>
        <div className="settings-radio-group">
          {([
            ['ask', 'Ask me each time'],
            ['merge', 'Merge into existing notebook'],
            ['create', 'Always create new notebook'],
          ] as const).map(([value, label]) => (
            <label key={value} className="settings-radio">
              <input
                type="radio"
                name="dupStrategy"
                value={value}
                checked={dupStrategy === value}
                onChange={() => setDupStrategy(value as DuplicateStrategy)}
              />
              <span>{label}</span>
            </label>
          ))}
          <label className={`settings-radio ${settings.tier !== 'pro' ? 'settings-radio--disabled' : ''}`}>
            <input
              type="radio"
              name="dupStrategy"
              value="global-dedup"
              checked={dupStrategy === 'global-dedup'}
              onChange={() => setDupStrategy('global-dedup')}
              disabled={settings.tier !== 'pro'}
            />
            <span>Smart global dedup</span>
            {settings.tier !== 'pro' && <span className="settings-pro-badge">PRO</span>}
          </label>
        </div>
      </div>

      <p className="settings-hint">
        Your API key is stored locally and never sent to our servers.
      </p>

      <button className="save-button" onClick={handleSave}>
        {saved ? 'Saved!' : 'Save'}
      </button>
    </div>
  );
}
