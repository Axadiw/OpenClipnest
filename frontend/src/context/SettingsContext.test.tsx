import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, render } from '@testing-library/react';
import { SettingsProvider, useSettings } from './SettingsContext';
import { story } from '../test-story';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);

describe('SettingsContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('provides default settings when localStorage is empty', (ctx) => {
    story(ctx, 'Nowy użytkownik wchodzi do aplikacji — widzi sensowne domyślne ustawienia (średnie miniatury) bez ręcznej konfiguracji.');
    const { result } = renderHook(() => useSettings(), { wrapper });
    expect(result.current.settings.thumbSize).toBe('M');
  });

  it('persists thumbSize change to localStorage', (ctx) => {
    story(ctx, 'Użytkownik wybiera małe miniatury, aby zobaczyć więcej nagrań naraz — wybór jest trwały i nie znika po odświeżeniu.');
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => { result.current.setThumbSize('S'); });
    const saved = JSON.parse(localStorage.getItem('clipnest_settings')!);
    expect(saved.thumbSize).toBe('S');
  });

  it('throws when useSettings is called outside SettingsProvider', (ctx) => {
    story(ctx, 'Programista, który przez pomyłkę użyje ustawień poza SettingsProvider, zobaczy jasny błąd zamiast tajemniczej awarii UI — szybka diagnostyka.');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Consumer() {
      useSettings();
      return null;
    }
    expect(() => render(<Consumer />)).toThrow('useSettings must be used within SettingsProvider');
    spy.mockRestore();
  });
});
