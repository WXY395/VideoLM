import { useState, useEffect, useCallback } from 'react';
import type { UserSettings } from '@/types';

interface UseSettingsResult {
  settings: UserSettings | null;
  updateSettings: (partial: Partial<UserSettings>) => void;
  refreshEntitlement: () => Promise<{ success: boolean; error?: string }>;
}

/**
 * Hook to load and update user settings via the background service worker.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    let cancelled = false;

    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      if (cancelled) return;
      if (response?.type === 'SETTINGS' && response.data) {
        setSettings(response.data);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback(
    (partial: Partial<UserSettings>) => {
      const updated = { ...settings, ...partial } as UserSettings;
      setSettings(updated);
      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: updated });
    },
    [settings]
  );

  const refreshEntitlement = useCallback(() => {
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'REFRESH_ENTITLEMENT' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (response?.success && response.settings) {
          setSettings(response.settings);
          resolve({ success: true });
          return;
        }
        resolve({ success: false, error: response?.error || 'refresh_failed' });
      });
    });
  }, []);

  return { settings, updateSettings, refreshEntitlement };
}
