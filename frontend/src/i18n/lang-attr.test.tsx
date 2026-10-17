import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { I18nProvider, useTranslation } from './index';

// Regression guard for the a11y defect where <html lang> stayed "en" no matter
// the selected UI language (wrong screen-reader pronunciation, wrong browser
// translation prompts, English-only hyphenation). The real I18nProvider must
// keep document.documentElement.lang in sync — on mount and on every switch.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = '';
});

afterEach(() => {
  document.documentElement.lang = '';
});

describe('<html lang> tracks the active language', () => {
  it('sets lang from the restored language on mount', () => {
    localStorage.setItem('clipnest-lang', 'pl');
    renderHook(() => useTranslation(), { wrapper: I18nProvider });
    expect(document.documentElement.lang).toBe('pl');
  });

  it('updates lang when the language is switched', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper: I18nProvider });
    act(() => result.current.setLanguage('de'));
    expect(document.documentElement.lang).toBe('de');
    act(() => result.current.setLanguage('fr'));
    expect(document.documentElement.lang).toBe('fr');
  });

  it('sets the tlh code verbatim without special-casing', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper: I18nProvider });
    act(() => result.current.setLanguage('tlh'));
    expect(document.documentElement.lang).toBe('tlh');
  });
});
