import { describe, it, expect } from 'vitest';
import { detectBrowserLanguage } from './index';

describe('detectBrowserLanguage', () => {
  it('matches an exact supported language code', () => {
    expect(detectBrowserLanguage(['pl'])).toBe('pl');
  });

  it('matches on the primary subtag, ignoring region and case', () => {
    expect(detectBrowserLanguage(['pl-PL'])).toBe('pl');
    expect(detectBrowserLanguage(['DE-at'])).toBe('de');
  });

  it('maps Norwegian Bokmål/Nynorsk to "no"', () => {
    expect(detectBrowserLanguage(['nb-NO'])).toBe('no');
    expect(detectBrowserLanguage(['nn'])).toBe('no');
    expect(detectBrowserLanguage(['no'])).toBe('no');
  });

  it('returns the first supported candidate in preference order', () => {
    expect(detectBrowserLanguage(['cs', 'fr-FR', 'pl'])).toBe('fr');
  });

  it('does not auto-select the Klingon easter-egg locale', () => {
    expect(detectBrowserLanguage(['tlh'])).toBe(null);
  });

  it('returns null when no candidate is supported', () => {
    expect(detectBrowserLanguage(['cs', 'ja-JP'])).toBe(null);
  });

  it('returns null for empty input', () => {
    expect(detectBrowserLanguage([])).toBe(null);
  });

  // Regression guard: a US English user must never be auto-switched to a
  // foreign language just because their browser also lists one.
  it('keeps a US English user on English', () => {
    expect(detectBrowserLanguage(['en-US', 'en'])).toBe('en');
    expect(detectBrowserLanguage(['en-US'])).toBe('en');
  });

  it('only picks Polish when the browser prefers it over English', () => {
    expect(detectBrowserLanguage(['en-US', 'pl'])).toBe('en');
    expect(detectBrowserLanguage(['pl', 'en-US'])).toBe('pl');
  });
});
