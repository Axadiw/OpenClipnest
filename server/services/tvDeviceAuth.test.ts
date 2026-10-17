import { describe, it, expect } from 'vitest';
import { story } from '../testing/story.js';
import {
  generateUserCode,
  formatUserCode,
  normalizeUserCode,
  generateDeviceCode,
} from './tvDeviceAuth.js';

// Ambiguity-free alphabet: no I, L, O, 0, 1 (easy to misread on a TV from the couch).
const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;

describe('generateUserCode', () => {
  it('returns an 8-char canonical code drawn only from the ambiguity-free alphabet', (ctx) => {
    story(ctx, 'Kod pokazywany na telewizorze nie może zawierać znaków łatwych do pomylenia (O/0, I/1/L), bo użytkownik przepisuje go z kanapy na telefon — inaczej wpisze zły kod i logowanie się nie uda.');
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(ALPHABET);
    }
  });

  it('is effectively unique across calls', (ctx) => {
    story(ctx, 'Dwa telewizory proszące o kod w tym samym czasie muszą dostać różne kody, żeby zatwierdzenie jednego nie zalogowało przypadkiem drugiego.');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateUserCode());
    expect(seen.size).toBeGreaterThan(190); // collisions vanishingly rare in 31^8
  });
});

describe('formatUserCode', () => {
  it('groups a canonical code into XXXX-XXXX for display', (ctx) => {
    story(ctx, 'Na ekranie telewizora kod jest pokazany jako XXXX-XXXX — myślnik dzieli go na dwie czytelne grupy, żeby łatwiej go było przepisać.');
    expect(formatUserCode('K7QF3M9P')).toBe('K7QF-3M9P');
  });
});

describe('normalizeUserCode', () => {
  it('uppercases and strips dashes/whitespace to the canonical 8-char form', (ctx) => {
    story(ctx, 'Użytkownik na stronie /tv może wpisać kod małymi literami, z myślnikiem albo ze spacjami — wszystkie te warianty muszą trafić w ten sam zapisany kod.');
    expect(normalizeUserCode('k7qf-3m9p')).toBe('K7QF3M9P');
    expect(normalizeUserCode('  K7QF 3M9P ')).toBe('K7QF3M9P');
    expect(normalizeUserCode('K7QF3M9P')).toBe('K7QF3M9P');
  });

  it('returns null for wrong length or out-of-alphabet characters', (ctx) => {
    story(ctx, 'Kod o złej długości albo zawierający znaki spoza alfabetu (np. 0 czy I) jest odrzucany od razu, zanim w ogóle odpytamy bazę — to broni przed zgadywaniem śmieciowych kodów.');
    expect(normalizeUserCode('K7QF3M9')).toBeNull();   // 7 chars
    expect(normalizeUserCode('K7QF3M9PP')).toBeNull();  // 9 chars
    expect(normalizeUserCode('K0QF3M9I')).toBeNull();   // 0 and I are not in the alphabet
    expect(normalizeUserCode('')).toBeNull();
    expect(normalizeUserCode(42 as unknown as string)).toBeNull();
  });
});

describe('generateDeviceCode', () => {
  it('returns a long, opaque, url-safe token', (ctx) => {
    story(ctx, 'device_code to sekret, którym telewizor odpytuje serwer o gotowy token — musi być długi i losowy (url-safe), żeby nie dało się go zgadnąć ani podstawić w URL-u.');
    const d = generateDeviceCode();
    expect(d.length).toBeGreaterThanOrEqual(32);
    expect(d).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateDeviceCode()).not.toBe(d);
  });
});
