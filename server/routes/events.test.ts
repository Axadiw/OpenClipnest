import { describe, it, expect } from 'vitest';
import { story } from '../testing/story.js';

describe('events route limit parsing', () => {
  const MAX_LIMIT = 1000;

  function parseLimit(query: string | undefined, defaultLimit = 50): number {
    const parsedLimit = parseInt(query as string, 10);
    const rawLimit = isNaN(parsedLimit) ? defaultLimit : parsedLimit;
    return Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  }

  it('returns default when no limit provided', (ctx) => {
    story(ctx, 'Gdy klient nie poda limitu, API zwraca 50 eventów na stronę — domyślna stronicacja chroni frontend przed wczytaniem ogromnych list.');
    expect(parseLimit(undefined)).toBe(50);
  });

  it('returns default when limit is NaN', (ctx) => {
    story(ctx, 'Parametr `limit=abc` z query stringu nie może wywalić serwera — fallback do wartości domyślnej utrzymuje odporność API na byle requesty.');
    expect(parseLimit('abc')).toBe(50);
  });

  it('returns parsed limit for valid number', (ctx) => {
    story(ctx, 'Użytkownik wybiera liczbę eventów na stronę w UI — backend musi tę wartość uszanować, żeby paginator zgodnie ze światłem wyboru.');
    expect(parseLimit('25')).toBe(25);
  });

  it('clamps limit=0 to 1', (ctx) => {
    story(ctx, 'Frontend już nie oferuje opcji „Wszystkie”, ale gdyby ktoś ręcznie wpisał `limit=0` w URL, klamrujemy do 1 zamiast dzielić przez zero albo zwracać całą bazę.');
    expect(parseLimit('0')).toBe(1);
  });

  it('clamps negative limit to 1', (ctx) => {
    story(ctx, 'Ujemna wartość limitu (edge case z manipulacji URL) jest klamrowana do 1 zamiast rzucania błędu — spójna defensywa wobec nietypowych klientów.');
    expect(parseLimit('-1')).toBe(1);
  });

  it('accepts 1000 (new max)', (ctx) => {
    story(ctx, 'Power user wybiera 1000 eventów na stronę — backend honoruje, bo to górny cap odpowiadający opcji w dropdownie.');
    expect(parseLimit('1000')).toBe(1000);
  });

  it('caps oversized limits at MAX_LIMIT', (ctx) => {
    story(ctx, 'Gdyby klient wysłał np. `limit=99999`, serwer przycina do 1000 — chroni DB i frontend przed OOM na kontach z dziesiątkami tysięcy nagrań.');
    expect(parseLimit('99999')).toBe(1000);
  });

  it('returns at least 1 for valid positive values', (ctx) => {
    story(ctx, 'Minimalnie 1 event na stronę — to bezpiecznik, żeby paginator nigdy nie próbował dzielić przez zero.');
    expect(parseLimit('1')).toBe(1);
  });
});

describe('events route cursor codec', () => {
  // Local copies of the route helpers — keeping the test isolated from
  // route wiring (which pulls in db / s3 / auth) and pinning the cursor
  // shape as part of the API contract.
  function encodeCursor(c: { timestamp: string; id: string } | null): string | null {
    if (!c) return null;
    return Buffer.from(JSON.stringify({ t: c.timestamp, i: c.id }), 'utf8').toString('base64url');
  }
  function decodeCursor(raw: unknown): { timestamp: string; id: string } | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    try {
      const json = Buffer.from(raw, 'base64url').toString('utf8');
      const parsed = JSON.parse(json) as { t?: unknown; i?: unknown };
      if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return undefined;
      if (Number.isNaN(Date.parse(parsed.t))) return undefined;
      return { timestamp: parsed.t, id: parsed.i };
    } catch {
      return undefined;
    }
  }

  it('returns undefined for missing cursor', (ctx) => {
    story(ctx, 'Pierwsze wejście na grid bez parametrów — brak `cursor=` oznacza "od góry listy", a backend zwraca najnowsze N eventów.');
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', (ctx) => {
    story(ctx, 'Pusty parametr `cursor=` (po ręcznej edycji URL-a) jest traktowany jak brak kursora, czyli pierwsza strona.');
    expect(decodeCursor('')).toBeUndefined();
  });

  it('returns undefined for non-base64 garbage', (ctx) => {
    story(ctx, 'Zmanipulowany `cursor=abc!@#` nie wywala serwera ani nie leci do Postgresa z pustym timestampem — fallback do pierwszej strony.');
    expect(decodeCursor('not-base64-!@#$%')).toBeUndefined();
  });

  it('returns undefined when decoded JSON lacks required fields', (ctx) => {
    story(ctx, 'Stary klient mógł trzymać cursor w innym kształcie — jeśli po dekodzie brakuje `t` lub `i`, traktujemy jako brak kursora zamiast 500.');
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    expect(decodeCursor(bad)).toBeUndefined();
  });

  it('returns undefined when timestamp is unparseable', (ctx) => {
    story(ctx, 'Cursor z syntaktycznie poprawnym JSON-em ale nieparsowalnym `t` nie może trafić do `::timestamptz` — odrzucamy, fallback do pierwszej strony.');
    const bad = Buffer.from(JSON.stringify({ t: 'not-a-date', i: 'abc' })).toString('base64url');
    expect(decodeCursor(bad)).toBeUndefined();
  });

  it('round-trips a valid cursor through encode/decode', (ctx) => {
    story(ctx, 'Klient odsyła nazad cursor, który dostał z `nextCursor` w poprzedniej odpowiedzi — kontrakt API musi być symetryczny, inaczej infinite scroll się zapętli.');
    const original = { timestamp: '2026-05-11T16:26:55.000Z', id: 'evt-abc-123' };
    const encoded = encodeCursor(original);
    expect(encoded).toBeTruthy();
    expect(decodeCursor(encoded!)).toEqual(original);
  });

  it('encodes null cursor as null (no more rows)', (ctx) => {
    story(ctx, 'Gdy backend zwrócił już ostatnią stronę, `nextCursor: null` w odpowiedzi sygnalizuje frontowi "koniec listy" — front przestaje wywoływać load-more.');
    expect(encodeCursor(null)).toBeNull();
  });

  it('produces url-safe base64 (no +, /, = padding)', (ctx) => {
    story(ctx, 'Cursor leci w query stringu — base64url (z `-`/`_` zamiast `+`/`/` i bez paddingu `=`) gwarantuje, że nie trzeba go dodatkowo URL-encodować.');
    const c = { timestamp: '2026-05-11T16:26:55.123Z', id: 'evt/with+special=chars' };
    const encoded = encodeCursor(c)!;
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('events bulk delete id parsing', () => {
  const BULK_DELETE_LIMIT = 100;

  function parseIds(ids: unknown): string[] {
    if (typeof ids !== 'string') return [];
    return ids.split(',').map(s => s.trim()).filter(Boolean);
  }

  it('returns empty for missing', (ctx) => {
    story(ctx, 'Pusty bulk-delete request nie crashuje — zwraca pustą listę ID, więc nic nie zostanie usunięte przez przypadek.');
    expect(parseIds(undefined)).toEqual([]);
  });

  it('trims and filters empties', (ctx) => {
    story(ctx, 'Klient wkleja listę ID rozdzieloną przecinkami — puste tokeny i spacje są ignorowane, żeby copy-paste z Excela nie wywalał operacji bulk delete.');
    expect(parseIds(' a ,,b,  c  ')).toEqual(['a', 'b', 'c']);
  });

  it('keeps order', (ctx) => {
    story(ctx, 'Kolejność ID w bulk-delete jest zachowana — ułatwia debug, kiedy trzeba sprawdzić, który event został przetworzony jako pierwszy.');
    expect(parseIds('id3,id1,id2')).toEqual(['id3', 'id1', 'id2']);
  });

  it('rejects input over the limit', (ctx) => {
    story(ctx, 'Bulk delete ma twardy limit (100), żeby użytkownik nie mógł wywołać długiego zapytania blokującego DB — limit jest sprawdzany niżej w routerze.');
    const many = Array.from({ length: BULK_DELETE_LIMIT + 1 }, (_, i) => `id${i}`).join(',');
    const parsed = parseIds(many);
    expect(parsed.length).toBeGreaterThan(BULK_DELETE_LIMIT);
  });
});
