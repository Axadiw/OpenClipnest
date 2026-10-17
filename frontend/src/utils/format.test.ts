import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatEventDateTime, formatEventTime, formatEventDate, eventDateAsLocal, forRelativeTime, nowWallClock, wallClockDayStr, resolveView } from './format';
import { story } from '../test-story';

describe('formatBytes', () => {
  it('returns "—" for null/NaN/negative', (ctx) => {
    story(ctx, 'Bezpieczny placeholder w UI gdy backend jeszcze nie podał liczby — żaden NaN ani "−123 B" nie ucieka do widoku.');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });

  it('formats common scales without trailing zeros', (ctx) => {
    story(ctx, 'Wartości używane na pasku quoty + admin storage — czytelność > precyzja.');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations as 0:SS with zero-padded seconds', (ctx) => {
    story(ctx, 'Licznik odliczania rate-limitu (i czas trwania klipu na karcie eventu) pokazuje "0:42", nie "42 s" ani "0:42.0" — użytkownik czyta to jak stoper.');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(42)).toBe('0:42');
  });

  it('formats minute+ durations as M:SS', (ctx) => {
    story(ctx, 'Limity logowania potrafią mieć cooldown wielominutowy (10 prób / 15 min). Odliczanie 65 s pokazuje "1:05", a 600 s "10:00" — minuty bez wiodącego zera, sekundy zawsze dwucyfrowe.');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
  });
});

describe('event timestamp formatters — TZ-pinned to UTC', () => {
  // Reolink camera bakes local wall-clock into the filename. Server stores
  // it as "...Z" without applying any TZ shift, so the UI must read it the
  // same way (i.e. interpret the Z as wall-clock, not as UTC). All three
  // helpers below pin the Intl formatters to `timeZone: 'UTC'`. These tests
  // run with TZ=UTC by default, but pinning to en-US locale keeps the
  // assertions deterministic regardless of the test runner's locale.

  it('formatEventTime renders HH:MM regardless of browser TZ', (ctx) => {
    story(ctx, 'Klipnięcie z kamery o 09:25 lokalnego czasu MUSI pokazać się jako 09:25 w UI — niezależnie od strefy przeglądarki userA. To kontrakt produktowy: cyfry na karcie eventu = cyfry wypalone w MP4 OSD.');
    expect(formatEventTime('2026-04-24T09:25:00.000Z')).toMatch(/09:25/);
  });

  it('formatEventTime accepts custom Intl options + still pins UTC', (ctx) => {
    story(ctx, 'Caller może podać hour/minute/second wariant — opcje przepuszczane do toLocaleTimeString, ale `timeZone: UTC` nie do nadpisania.');
    expect(formatEventTime('2026-04-24T09:25:30.000Z', { hour: '2-digit', minute: '2-digit', second: '2-digit' })).toMatch(/09:25:30/);
  });

  it('formatEventDateTime renders the date+time using the wall-clock interpretation', (ctx) => {
    story(ctx, 'Hover/title pokazuje "2026-04-24, 09:25" — nie "2026-04-24, 11:25" (CEST shift).');
    const out = formatEventDateTime('2026-04-24T09:25:00.000Z', 'en-US');
    expect(out).toMatch(/4\/24\/2026/);
    expect(out).toMatch(/9:25/);
  });

  it('formatEventDate renders date-only, no TZ shift', (ctx) => {
    story(ctx, 'Day grouping nagłówków używa tego samego źródła co eventDateAsLocal — gwarancja, że klip 23:30 lokalnie nie wpada do "następnego dnia" w innej strefie.');
    expect(formatEventDate('2026-04-24T23:30:00.000Z', 'en-US')).toMatch(/4\/24\/2026/);
  });

  it('forRelativeTime returns actual UTC epoch for a camera in Europe/Warsaw (UTC+2)', (ctx) => {
    story(ctx, 'Fix dla DEGRADED-TZ: kamera w Warsaw nagrywa 12:45 local, scanner bakes to "12:45Z". forRelativeTime("12:45Z", "Europe/Warsaw") zwraca epoch 10:45 UTC, więc formatDistanceToNow daje poprawny wynik zamiast "za 2 godziny".');
    // 2026-05-02T12:45:00Z stored wall-clock. Warsaw is UTC+2 in summer.
    // Actual UTC = 10:45. forRelativeTime must return a Date at 10:45 UTC.
    const result = forRelativeTime('2026-05-02T12:45:00.000Z', 'Europe/Warsaw');
    expect(result.getUTCHours()).toBe(10);
    expect(result.getUTCMinutes()).toBe(45);
  });

  it('forRelativeTime returns the original Date unchanged for UTC timezone', (ctx) => {
    story(ctx, 'Kamera w UTC nie powinna przesuwać czasu — brak korekty.');
    const iso = '2026-05-02T12:45:00.000Z';
    const result = forRelativeTime(iso, 'UTC');
    expect(result.getTime()).toBe(new Date(iso).getTime());
  });

  it('eventDateAsLocal builds a Date whose local components mirror the UTC stamp', (ctx) => {
    story(ctx, 'Helper pozwala date-fns formatDistanceToNow / isToday porównywać do `new Date()` w lokalnej strefie zachowując wall-clock z filename. Inaczej "Today" by pęknął na granicy północy w innym TZ.');
    const d = eventDateAsLocal('2026-04-24T23:30:00.000Z');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April (0-indexed)
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(30);
  });
});

describe('nowWallClock — real instant projected onto the wall-clock axis', () => {
  it('shifts a real UTC instant forward by the account zone summer offset', (ctx) => {
    story(ctx, 'Zielona linia "teraz" na timeline stoi na tej samej osi co słupki eventów (wall-clock kamery zapieczętowany jako UTC). Surowy Date.now() lądował o offset strefy w lewo od najświeższych nagrań — dla Europe/Warsaw latem o 2 h. nowWallClock przesuwa instant na zegar konta, więc linia trafia tam, gdzie użytkownik ją widzi na nagraniu.');
    const real = Date.parse('2026-07-31T10:00:00.000Z');
    expect(new Date(nowWallClock(real, 'Europe/Warsaw')).toISOString()).toBe('2026-07-31T12:00:00.000Z');
  });

  it('uses the winter offset for the same zone (DST-aware, not a fixed constant)', (ctx) => {
    story(ctx, 'Offset musi być liczony dla KONKRETNEGO instantu, nie zaszyty na stałe — inaczej linia "teraz" rozjeżdża się o godzinę po każdej zmianie czasu i błąd wraca dwa razy w roku.');
    const real = Date.parse('2026-01-15T10:00:00.000Z');
    expect(new Date(nowWallClock(real, 'Europe/Warsaw')).toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('shifts backwards for zones west of UTC', (ctx) => {
    story(ctx, 'Konta w strefach z ujemnym offsetem (np. America/New_York) muszą dostać przesunięcie w drugą stronę — inaczej poprawka naprawia tylko Europę.');
    const real = Date.parse('2026-07-31T10:00:00.000Z');
    expect(new Date(nowWallClock(real, 'America/New_York')).toISOString()).toBe('2026-07-31T06:00:00.000Z');
  });

  it('is the exact inverse of forRelativeTime', (ctx) => {
    story(ctx, 'Obie funkcje opisują tę samą zależność między osią wall-clock a prawdziwym UTC. Gdyby się rozjechały, "5 minut temu" i pozycja linii pokazywałyby dwie różne prawdy o tym samym momencie.');
    const real = Date.parse('2026-07-31T10:00:00.000Z');
    const wall = nowWallClock(real, 'Europe/Warsaw');
    expect(forRelativeTime(new Date(wall).toISOString(), 'Europe/Warsaw').getTime()).toBe(real);
  });

  it('returns the instant untouched for UTC and for an unknown zone id', (ctx) => {
    story(ctx, 'Konto w UTC nie ma czego przesuwać, a nieznany identyfikator strefy (stary wpis w bazie, literówka) nie może wywalić timeline — degradujemy do zachowania sprzed poprawki zamiast rzucać wyjątkiem w renderze.');
    const real = Date.parse('2026-07-31T10:00:00.000Z');
    expect(nowWallClock(real, 'UTC')).toBe(real);
    expect(nowWallClock(real, 'Not/AZone')).toBe(real);
  });
});

describe('wallClockDayStr — "today" on the account clock', () => {
  it('rolls over to the next date when the account zone is already past midnight', (ctx) => {
    story(ctx, 'Timeline otwiera się domyślnie na "dziś". O 22:30 UTC w Warszawie jest już 00:30 następnego dnia, więc kamera stempluje klipy nową datą — widok musi wystartować na tym samym dniu co nagrania, nie na dniu przeglądarki.');
    expect(wallClockDayStr(Date.parse('2026-07-31T22:30:00.000Z'), 'Europe/Warsaw')).toBe('2026-08-01');
  });

  it('stays on the previous date for zones west of UTC', (ctx) => {
    story(ctx, 'Lustrzany przypadek: o 02:00 UTC w Nowym Jorku jest wciąż 22:00 poprzedniego dnia. Ten sam helper musi cofać dzień, inaczej użytkownicy w Amerykach dostają pusty timeline "z przyszłości".');
    expect(wallClockDayStr(Date.parse('2026-08-01T02:00:00.000Z'), 'America/New_York')).toBe('2026-07-31');
  });
});

describe('resolveView — deep-link fallback', () => {
  it('honors the URL-requested view when the event has it', (ctx) => {
    story(ctx, 'Happy path: notyfikacja deep-linkuje `view=00`, event ma view 00 → bez zmian.');
    const views = [{ id: '00' }, { id: '01' }];
    expect(resolveView('00', { views })).toBe('00');
    expect(resolveView('01', { views })).toBe('01');
  });

  it('falls back to the primary view when the requested view is missing', (ctx) => {
    story(ctx, 'View-01-only Reolink upload — event nie ma view 00. Notyfikacja deep-linkuje `view=00`. Bez fallbacku player próbował załadować nieistniejący view → 404. Test pilnuje, że resolver wraca do pierwszego (primary) view z views[].');
    expect(resolveView('00', { views: [{ id: '01' }] })).toBe('01');
    expect(resolveView('01', { views: [{ id: '00' }] })).toBe('00');
  });

  it('returns null when the event has no view files (zombie state)', (ctx) => {
    story(ctx, 'Edge: pusta views[] (zombie ledwo nie usunięty przez reconcilera). Caller dostaje null i renderuje empty state, zamiast crashować na undefined-view.');
    expect(resolveView('00', { views: [] })).toBeNull();
    expect(resolveView('01', { views: [] })).toBeNull();
  });

  it('passes through arbitrary profile-defined view ids', (ctx) => {
    story(ctx, 'N-view vendors mogą używać własnych identyfikatorów (np. "A", "main"). Resolver po prostu sprawdza match w event.views[].id, niezależnie od konkretnego stringa.');
    expect(resolveView('A', { views: [{ id: 'A' }, { id: 'B' }] })).toBe('A');
    expect(resolveView('X', { views: [{ id: 'A' }, { id: 'B' }] })).toBe('A');
  });
});
