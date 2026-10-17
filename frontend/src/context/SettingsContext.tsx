import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ThumbSize } from '../components/EventList';

interface Settings {
  thumbSize: ThumbSize;
}

interface SettingsContextValue {
  settings: Settings;
  setThumbSize: (size: ThumbSize) => void;
}

const STORAGE_KEY = 'clipnest_settings';

const DEFAULTS: Settings = { thumbSize: 'M' };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: Partial<Settings> = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const setThumbSize = useCallback((thumbSize: ThumbSize) => {
    setSettings(prev => {
      const next = { ...prev, thumbSize };
      saveSettings(next);
      return next;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, setThumbSize }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
