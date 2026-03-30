import { useState, useEffect, useCallback } from 'react';
import type { UserSettings } from '@/types';

interface UseSettingsResult {
  settings: UserSettings | null;
  updateSettings: (partial: Partial<UserSettings>) => void;
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

  return { settings, updateSettings };
}
