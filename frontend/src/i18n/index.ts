import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { en } from './en';
import { pl } from './pl';
import { de } from './de';
import { fr } from './fr';
import { it } from './it';
import { no } from './no';
import { es } from './es';
import { tlh } from './tlh';
import React from 'react';

export type Language = 'en' | 'pl' | 'de' | 'fr' | 'it' | 'es' | 'no' | 'tlh';

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'pl', label: 'Polski' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Fran\u00e7ais' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Espa\u00f1ol' },
  { code: 'no', label: 'Norsk' },
  { code: 'tlh', label: 'tlhIngan Hol' },
];

const translations: Record<Language, Record<string, string>> = { en, pl, de, fr, it, es, no, tlh };

/**
 * Merge an edition's catalogs over the core ones. Called once by the edition
 * module at boot (before the first render), so lookups never see a partial
 * catalog. A registration, not an import, so this module stays free of any
 * edition dependency (which would be an import cycle).
 */
export function registerTranslations(extra: Partial<Record<Language, Record<string, string>>>): void {
  for (const lang of Object.keys(extra) as Language[]) {
    Object.assign(translations[lang], extra[lang]);
  }
}

const STORAGE_KEY = 'clipnest-lang';

// Browser locale codes that should resolve to our single Norwegian ('no') catalog.
const NORWEGIAN_PRIMARY_SUBTAGS = new Set(['no', 'nb', 'nn']);

/**
 * Resolve the first browser-preferred locale to a supported UI language.
 * Matches on the primary subtag (e.g. 'pl-PL' -> 'pl', 'nb-NO' -> 'no').
 * The Klingon easter egg ('tlh') is never auto-selected. Returns null when
 * none of the candidates map to a supported language.
 */
export function detectBrowserLanguage(candidates: readonly string[]): Language | null {
  for (const candidate of candidates) {
    const primary = candidate.split('-')[0]?.toLowerCase();
    if (!primary) continue;
    if (NORWEGIAN_PRIMARY_SUBTAGS.has(primary)) return 'no';
    if (primary !== 'tlh' && primary in translations) return primary as Language;
  }
  return null;
}

function getInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && translations[stored as Language]) return stored as Language;
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectBrowserLanguage(candidates) ?? 'en';
}

/**
 * Resolve the active UI language outside the React tree — for code that runs
 * before (or instead of) I18nProvider, e.g. the route error boundary, which
 * renders when the provider itself may have failed to mount. Mirrors the
 * provider's initial-language logic (stored choice, then browser locale).
 */
export function getActiveLanguage(): Language {
  return getInitialLanguage();
}

interface I18nContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: 'en',
  setLanguage: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLang] = useState<Language>(getInitialLanguage);

  const setLanguage = useCallback((lang: Language) => {
    setLang(lang);
    localStorage.setItem(STORAGE_KEY, lang);
  }, []);

  // Keep <html lang> in sync with the active language so screen readers use the
  // right pronunciation rules, browsers offer translation correctly, and CSS
  // hyphenation would resolve per-locale. Runs on mount (for the restored/
  // detected language) and on every switch. Effect-only so it never touches
  // `document` during the landing prerender. tlh is a valid ISO 639-3 code — no
  // special-casing needed even though it has no hyphenation rules.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    let text = translations[language][key] || translations.en[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }, [language]);

  return React.createElement(I18nContext.Provider, { value: { language, setLanguage, t } }, children);
}

export function useTranslation() {
  return useContext(I18nContext);
}
