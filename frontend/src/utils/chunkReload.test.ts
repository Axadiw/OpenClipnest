import { describe, it, expect, beforeEach } from 'vitest';
import { story } from '../test-story';
import {
  isChunkLoadError,
  shouldReloadOnce,
  RELOAD_GUARD_MS,
} from './chunkReload';

describe('isChunkLoadError', () => {
  it('recognises a stale dynamic-import failure after a deploy', (ctx) => {
    story(ctx, 'Po deployu stary chunk znika (404) — błąd dynamicznego importu musi być rozpoznany jako chunk error, żeby uruchomić auto-reload.');
    // The exact Chromium message a stale tab hits when its hashed chunk 404s.
    expect(
      isChunkLoadError(
        new Error(
          'error loading dynamically imported module: https://clipnest.video/assets/SettingsLayout-00SdRP7B.js',
        ),
      ),
    ).toBe(true);
    // Other browser phrasings of the same failure.
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('does not treat a generic application error as a chunk error', (ctx) => {
    story(ctx, 'Zwykły błąd aplikacji nie może udawać chunk errora — inaczej każda awaria kończyłaby się przeładowaniem zamiast komunikatu.');
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('boom')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('shouldReloadOnce', () => {
  let store: Record<string, string>;
  const storage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };

  beforeEach(() => {
    store = {};
  });

  it('reloads on the first failure and records the attempt', (ctx) => {
    story(ctx, 'Pierwszy chunk error → przeładuj raz (świeży index.html przyniesie nowe hashe).');
    expect(shouldReloadOnce({ storage, now: 1_000_000 })).toBe(true);
  });

  it('refuses a second reload inside the guard window to avoid a loop', (ctx) => {
    story(ctx, 'Jeśli reload nie pomógł (np. serwer padł), drugi błąd w oknie strażnika NIE przeładowuje — koniec pętli, pokazujemy kartę.');
    expect(shouldReloadOnce({ storage, now: 1_000_000 })).toBe(true);
    expect(shouldReloadOnce({ storage, now: 1_000_000 + RELOAD_GUARD_MS - 1 })).toBe(false);
  });

  it('allows another reload once the guard window has elapsed', (ctx) => {
    story(ctx, 'Po upływie okna strażnika kolejny deploy znów może bezpiecznie przeładować.');
    expect(shouldReloadOnce({ storage, now: 1_000_000 })).toBe(true);
    expect(shouldReloadOnce({ storage, now: 1_000_000 + RELOAD_GUARD_MS })).toBe(true);
  });
});
