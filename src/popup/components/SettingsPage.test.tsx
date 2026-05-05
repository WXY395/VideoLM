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
        onCopyDiagnostics={vi.fn()}
        onReportIssue={vi.fn()}
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
        onCopyDiagnostics={vi.fn()}
        onReportIssue={vi.fn()}
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

  it('lets the user copy diagnostic information explicitly', async () => {
    const onCopyDiagnostics = vi.fn(async () => ({ success: true }));
    render(
      <SettingsPage
        settings={makeSettings()}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onRefreshEntitlement={vi.fn()}
        onCopyDiagnostics={onCopyDiagnostics}
        onReportIssue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('settings_copy_diagnostics'));

    await waitFor(() => expect(onCopyDiagnostics).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('settings_diagnostics_copied')).toBeInTheDocument();
  });

  it('opens a user-controlled issue report email draft', async () => {
    const onReportIssue = vi.fn(async () => ({ success: true }));
    render(
      <SettingsPage
        settings={makeSettings()}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onRefreshEntitlement={vi.fn()}
        onCopyDiagnostics={vi.fn()}
        onReportIssue={onReportIssue}
      />,
    );

    fireEvent.click(screen.getByText('settings_report_issue'));

    await waitFor(() => expect(onReportIssue).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('settings_report_issue_opened')).toBeInTheDocument();
  });
});
