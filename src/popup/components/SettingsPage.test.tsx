import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '@/types';
import { SettingsPage } from './SettingsPage';

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    tier: 'free',
    defaultMode: 'raw',
    duplicateStrategy: 'ask',
    outputLanguage: 'auto',
    monthlyUsage: { imports: 23, aiCalls: 0, resetDate: '2099-02-01' },
    entitlement: {
      backendUrl: 'https://api.test',
      licenseKey: 'VL-TEST',
      snapshot: {
        subjectId: 'install:test',
        plan: 'free',
        periodStart: '2099-01-01',
        periodEnd: '2099-02-01',
        limits: { imports: 100, aiCalls: 0 },
        usage: { imports: 23, aiCalls: 0 },
      },
    },
    ...overrides,
  };
}

describe('SettingsPage entitlement controls', () => {
  it('shows plan, quota usage, license key, and backend URL', () => {
    render(
      <SettingsPage
        settings={makeSettings()}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onRefreshEntitlement={vi.fn()}
      />,
    );

    expect(screen.getByText('settings_entitlement_title')).toBeInTheDocument();
    expect(screen.getByText('settings_entitlement_plan_value')).toBeInTheDocument();
    expect(screen.getByText('settings_entitlement_import_usage_value')).toBeInTheDocument();
    expect(screen.getByLabelText('settings_license_key')).toHaveValue('VL-TEST');
    expect(screen.getByLabelText('settings_backend_url')).toHaveValue('https://api.test');
  });

  it('saves editable entitlement fields and can refresh entitlement', async () => {
    const onSave = vi.fn();
    const onRefreshEntitlement = vi.fn(async () => ({ success: true }));
    render(
      <SettingsPage
        settings={makeSettings()}
        onSave={onSave}
        onBack={vi.fn()}
        onRefreshEntitlement={onRefreshEntitlement}
      />,
    );

    fireEvent.change(screen.getByLabelText('settings_license_key'), {
      target: { value: 'VL-NEW' },
    });
    fireEvent.click(screen.getByText('settings_save'));
    fireEvent.click(screen.getByText('settings_refresh_entitlement'));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      entitlement: expect.objectContaining({
        backendUrl: 'https://api.test',
        licenseKey: 'VL-NEW',
      }),
    }));
    await waitFor(() => expect(onRefreshEntitlement).toHaveBeenCalledTimes(1));
  });
});
