import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';
import { story } from '../test-story';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    // Mock matchMedia
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: light)' ? false : true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('defaults to auto mode', (ctx) => {
    story(ctx, 'Użytkownik otwiera aplikację pierwszy raz — motyw domyślnie dopasowuje się do ustawień systemu, bez ręcznej konfiguracji.');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('auto');
  });

  it('reads stored theme from localStorage', (ctx) => {
    story(ctx, 'Po ponownym wejściu użytkownik widzi wybrany wcześniej motyw — aplikacja pamięta jego preferencje między sesjami.');
    localStorage.setItem('clipnest-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('light');
  });

  it('applies theme to document on mount', (ctx) => {
    story(ctx, 'Po załadowaniu strony kolory od razu pasują do zapisanego motywu — żadnego migotania czy błysku jasnego tła w trybie ciemnym.');
    localStorage.setItem('clipnest-theme', 'dark');
    renderHook(() => useTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('switches theme and persists to localStorage', (ctx) => {
    story(ctx, 'Użytkownik przełącza motyw w ustawieniach i widzi natychmiastową zmianę, a wybór zostaje zapamiętany do następnej wizyty.');
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setMode('light');
    });
    expect(result.current.mode).toBe('light');
    expect(localStorage.getItem('clipnest-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies dark theme when set explicitly', (ctx) => {
    story(ctx, 'Użytkownik wybiera tryb ciemny — interfejs natychmiast przechodzi na ciemne kolory, co chroni wzrok wieczorem.');
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setMode('dark');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores invalid stored values and defaults to auto', (ctx) => {
    story(ctx, 'Nawet jeśli localStorage zawiera śmieci (np. po ręcznej edycji), aplikacja nie krzyczy błędem — elegancko wraca do trybu automatycznego.');
    localStorage.setItem('clipnest-theme', 'invalid');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('auto');
  });
});
