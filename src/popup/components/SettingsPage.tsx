import React, { useState } from 'react';
import type { UserSettings, AIProviderType, BYOKConfig, DuplicateStrategy } from '@/types';
import { t } from '@/utils/i18n';

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
        {t('common_back')}
      </button>

      <h2 className="settings-title">{t('settings_title')}</h2>

      <div className="settings-section">
        <label className="settings-label" htmlFor="provider-select">
          {t('settings_provider')}
        </label>
        <select
          id="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AIProviderType)}
        >
          <option value="openai">{t('settings_provider_openai')}</option>
          <option value="anthropic">{t('settings_provider_anthropic')}</option>
        </select>
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="api-key-input">
          {t('settings_api_key')}
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
          {t('settings_model')}
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
        <label className="settings-label">{t('settings_dup_strategy')}</label>
        <div className="settings-radio-group">
          {([
            ['ask', 'settings_dup_ask'],
            ['merge', 'settings_dup_merge'],
            ['create', 'settings_dup_create'],
          ] as const).map(([value, labelKey]) => (
            <label key={value} className="settings-radio">
              <input
                type="radio"
                name="dupStrategy"
                value={value}
                checked={dupStrategy === value}
                onChange={() => setDupStrategy(value as DuplicateStrategy)}
              />
              <span>{t(labelKey)}</span>
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
            <span>{t('settings_dup_global')}</span>
            {settings.tier !== 'pro' && <span className="settings-pro-badge">{t('common_pro_badge')}</span>}
          </label>
        </div>
      </div>

      <p className="settings-hint">
        {t('settings_api_hint')}
      </p>

      <button className="save-button" onClick={handleSave}>
        {saved ? t('settings_saved') : t('settings_save')}
      </button>
    </div>
  );
}
