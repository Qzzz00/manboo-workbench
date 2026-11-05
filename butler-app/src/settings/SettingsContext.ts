import { createContext, useContext } from 'react';
import { DEFAULT_SETTINGS, type Settings } from './settingsStore';

export interface SettingsHandle {
  settings: Settings;
  update(patch: Partial<Settings>): Promise<void>;
}

export const SettingsContext = createContext<SettingsHandle>({ settings: DEFAULT_SETTINGS, update: async () => {} });

export function useSettings(): SettingsHandle {
  return useContext(SettingsContext);
}
