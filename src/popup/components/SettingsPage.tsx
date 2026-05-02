import React, { useState } from 'react';
import type { UserSettings, AIProviderType, BYOKConfig, DuplicateStrategy } from '@/types';
import { t } from '@/utils/i18n';

interface SettingsPageProps {
  settings: UserSettings;
  onSave: (partial: Partial<UserSettings>) => void;
  onRefreshEntitlement: () => Promise<{ success: boolean; error?: string }> | void;
  onBack: () => void;
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
};

export function SettingsPage({ settings, onSave, onRefreshEntitlement, onBack }: SettingsPageProps) {
  const [provider, setProvider] = useState<AIProviderType>(
    settings.byok?.provider ?? 'openai'
  );
  const [apiKey, setApiKey] = useState(settings.byok?.apiKey ?? '');
  const [model, setModel] = useState(settings.byok?.model ?? '');
  const [dupStrategy, setDupStrategy] = useState<DuplicateStrategy>(
    settings.duplicateStrategy ?? 'ask'
  );
  const [outputLanguage, setOutputLanguage] = useState<string>(
    settings.outputLanguage ?? 'auto'
  );
  const [obsidianFileNameTemplate, setObsidianFileNameTemplate] = useState(
    settings.obsidian?.fileNameTemplate ?? '{{title}} - {{date}}'
  );
  const [obsidianTags, setObsidianTags] = useState(
    (settings.obsidian?.defaultTags ?? ['videolm', 'notebooklm']).join(', ')
  );
  const [obsidianIncludeEvidenceMap, setObsidianIncludeEvidenceMap] = useState(
    settings.obsidian?.includeEvidenceMap ?? true
  );
  const [obsidianIncludeFollowups, setObsidianIncludeFollowups] = useState(
    settings.obsidian?.includeFollowups ?? true
  );
  const [obsidianIncludeSources, setObsidianIncludeSources] = useState(
    settings.obsidian?.includeSources ?? true
  );
  const [licenseKey, setLicenseKey] = useState(settings.entitlement?.licenseKey ?? '');
  const [backendUrl, setBackendUrl] = useState(settings.entitlement?.backendUrl ?? '');
  const [refreshingEntitlement, setRefreshingEntitlement] = useState(false);
  const [entitlementMessage, setEntitlementMessage] = useState('');
  const [saved, setSaved] = useState(false);

  const entitlement = settings.entitlement?.snapshot;
  const plan = entitlement?.plan ?? settings.tier;
  const importLimit = entitlement?.limits.imports;
  const importUsed = entitlement?.usage.imports ?? settings.monthlyUsage.imports;
  const importUsageText = importLimit === null
    ? t('settings_entitlement_unlimited')
    : `${importUsed}/${importLimit ?? 100}`;

  const handleSave = () => {
    const byok: BYOKConfig | undefined = apiKey.trim()
      ? {
          provider,
          apiKey: apiKey.trim(),
          model: model.trim() || undefined,
        }
      : undefined;

    const defaultTags = obsidianTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    onSave({
      byok,
      duplicateStrategy: dupStrategy,
      outputLanguage,
      obsidian: {
        fileNameTemplate: obsidianFileNameTemplate.trim() || '{{title}} - {{date}}',
        defaultTags: defaultTags.length ? defaultTags : ['videolm', 'notebooklm'],
        includeEvidenceMap: obsidianIncludeEvidenceMap,
        includeFollowups: obsidianIncludeFollowups,
        includeSources: obsidianIncludeSources,
        citationStyle: 'footnotes',
      },
      entitlement: {
        backendUrl: backendUrl.trim() || settings.entitlement?.backendUrl || '',
        licenseKey: licenseKey.trim() || undefined,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleRefreshEntitlement = async () => {
    setRefreshingEntitlement(true);
    setEntitlementMessage('');
    const result = await Promise.resolve(onRefreshEntitlement?.());
    setRefreshingEntitlement(false);
    const success = typeof result === 'object' && Boolean(result?.success);
    setEntitlementMessage(success ? t('settings_entitlement_refreshed') : t('settings_entitlement_refresh_failed'));
  };

  return (
    <div className="settings-page">
      <button className="back-button" onClick={onBack}>
        {t('common_back')}
      </button>

      <h2 className="settings-title">{t('settings_title')}</h2>

      <div className="settings-section settings-section--entitlement">
        <h3 className="settings-subtitle">{t('settings_entitlement_title')}</h3>
        <div className="settings-entitlement-grid">
          <div>
            <span className="settings-kicker">{t('settings_entitlement_plan')}</span>
            <strong>{t('settings_entitlement_plan_value', [plan.toUpperCase()])}</strong>
          </div>
          <div>
            <span className="settings-kicker">{t('settings_entitlement_import_usage')}</span>
            <strong>{t('settings_entitlement_import_usage_value', [importUsageText])}</strong>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="license-key-input">
          {t('settings_license_key')}
        </label>
        <input
          id="license-key-input"
          type="text"
          value={licenseKey}
          onChange={(e) => setLicenseKey(e.target.value)}
          placeholder="VL-..."
        />
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="backend-url-input">
          {t('settings_backend_url')}
        </label>
        <input
          id="backend-url-input"
          type="text"
          value={backendUrl}
          onChange={(e) => setBackendUrl(e.target.value)}
          placeholder="https://api.videolm.workers.dev"
        />
        <p className="settings-help">{t('settings_backend_url_help')}</p>
      </div>

      <div className="settings-section">
        <button
          className="secondary-button"
          onClick={handleRefreshEntitlement}
          disabled={refreshingEntitlement}
        >
          {refreshingEntitlement ? t('common_processing') : t('settings_refresh_entitlement')}
        </button>
        {entitlementMessage && <p className="settings-help">{entitlementMessage}</p>}
      </div>

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

      <div className="settings-section">
        <label className="settings-label" htmlFor="output-language-select">
          {t('settings_output_language')}
        </label>
        <select
          id="output-language-select"
          value={outputLanguage}
          onChange={(e) => setOutputLanguage(e.target.value)}
        >
          <option value="auto">{t('settings_output_language_auto')}</option>
          <option value="en">English</option>
          <option value="zh-TW">繁體中文 (Traditional Chinese)</option>
          <option value="zh-CN">简体中文 (Simplified Chinese)</option>
          <option value="ja">日本語 (Japanese)</option>
          <option value="ko">한국어 (Korean)</option>
          <option value="es">Español (Spanish)</option>
          <option value="fr">Français (French)</option>
          <option value="de">Deutsch (German)</option>
        </select>
        <p className="settings-help">{t('settings_output_language_help')}</p>
      </div>

      <p className="settings-hint">
        {t('settings_api_hint')}
      </p>

      <div className="settings-section settings-section--divider">
        <h3 className="settings-subtitle">Obsidian</h3>
        <label className="settings-label" htmlFor="obsidian-filename-template">
          檔名模板 File name template
        </label>
        <input
          id="obsidian-filename-template"
          type="text"
          value={obsidianFileNameTemplate}
          onChange={(e) => setObsidianFileNameTemplate(e.target.value)}
          placeholder="{{title}} - {{date}}"
        />
        <p className="settings-help">Supports {'{{title}}'}, {'{{notebook_title}}'}, and {'{{date}}'}.</p>
      </div>

      <div className="settings-section">
        <label className="settings-label" htmlFor="obsidian-tags">
          預設標籤 Default tags
        </label>
        <input
          id="obsidian-tags"
          type="text"
          value={obsidianTags}
          onChange={(e) => setObsidianTags(e.target.value)}
          placeholder="videolm, notebooklm"
        />
      </div>

      <div className="settings-section">
        <label className="settings-label">筆記區塊 Sections</label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={obsidianIncludeEvidenceMap}
            onChange={(e) => setObsidianIncludeEvidenceMap(e.target.checked)}
          />
          <span>包含來源對照表 Evidence Map</span>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={obsidianIncludeFollowups}
            onChange={(e) => setObsidianIncludeFollowups(e.target.checked)}
          />
          <span>包含後續行動 Follow-ups</span>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={obsidianIncludeSources}
            onChange={(e) => setObsidianIncludeSources(e.target.checked)}
          />
          <span>包含來源註腳 Sources</span>
        </label>
      </div>

      <button className="save-button" onClick={handleSave}>
        {saved ? t('settings_saved') : t('settings_save')}
      </button>
    </div>
  );
}
