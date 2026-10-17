import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { story } from '../test-story';

const getAccountTimezone = vi.fn();
vi.mock('../api', () => ({ api: { getAccountTimezone: () => getAccountTimezone() } }));

import { useAccountTimezone, clearAccountTimezone, ACCOUNT_TZ_KEY } from './useAccountTimezone';

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('useAccountTimezone', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAccountTimezone();
    getAccountTimezone.mockReset();
  });

  it('falls back to the device zone before the account zone has loaded', (ctx) => {
    story(ctx, 'Timeline rysuje linię "teraz" w pierwszej klatce, zanim odpowiedź z /settings/timezone wróci. Strefa urządzenia to ten sam default co na iOS i Androidzie — dla ogromnej większości kont identyczna z kontową, więc pierwsza klatka jest już poprawna zamiast wylądować w UTC.');
    getAccountTimezone.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAccountTimezone());
    expect(result.current).toBe(deviceTz);
  });

  it('switches to the account zone once the fetch resolves and caches it', async (ctx) => {
    story(ctx, 'Konto może mieć strefę inną niż przeglądarka (kamera w Polsce, użytkownik na wyjeździe). Po odpowiedzi serwera hook przechodzi na strefę konta i zapisuje ją lokalnie, żeby kolejne wejście na timeline startowało od razu z właściwą.');
    getAccountTimezone.mockResolvedValue({ timezone: 'Europe/Warsaw' });
    const { result } = renderHook(() => useAccountTimezone());
    await waitFor(() => expect(result.current).toBe('Europe/Warsaw'));
    expect(localStorage.getItem(ACCOUNT_TZ_KEY)).toBe('Europe/Warsaw');
  });

  it('seeds synchronously from the cached zone on a later mount', async (ctx) => {
    story(ctx, 'Bez tego linia "teraz" skakałaby przy każdym wejściu na timeline: render w strefie urządzenia, a chwilę później przeskok o offset. Cache sprawia, że skok zdarza się raz w życiu sesji, nie za każdym razem.');
    localStorage.setItem(ACCOUNT_TZ_KEY, 'America/New_York');
    getAccountTimezone.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAccountTimezone());
    expect(result.current).toBe('America/New_York');
  });

  it('fetches once even when several components mount the hook', async (ctx) => {
    story(ctx, 'Strefa konta zmienia się raz na ruski rok, a hook może wisieć w kilku miejscach naraz. Współdzielony in-flight promise trzyma to na jednym żądaniu zamiast mnożyć je przez liczbę konsumentów.');
    getAccountTimezone.mockResolvedValue({ timezone: 'Europe/Warsaw' });
    const a = renderHook(() => useAccountTimezone());
    const b = renderHook(() => useAccountTimezone());
    await waitFor(() => expect(a.result.current).toBe('Europe/Warsaw'));
    await waitFor(() => expect(b.result.current).toBe('Europe/Warsaw'));
    expect(getAccountTimezone).toHaveBeenCalledTimes(1);
  });

  it('keeps the device zone when the request fails', async (ctx) => {
    story(ctx, 'Padnięte /settings/timezone (offline, 401 w trakcie odświeżania tokenu) nie może wywalić timeline ani wrzucić go w UTC — degradujemy do strefy urządzenia, czyli do zachowania sensownego dla większości kont.');
    getAccountTimezone.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAccountTimezone());
    await waitFor(() => expect(getAccountTimezone).toHaveBeenCalled());
    expect(result.current).toBe(deviceTz);
    expect(localStorage.getItem(ACCOUNT_TZ_KEY)).toBeNull();
  });

  it('ignores a zone id the browser cannot resolve', async (ctx) => {
    story(ctx, 'W bazie może siedzieć strefa, której ten silnik Intl nie zna (stary wpis, egzotyczne IANA id). Przyjęcie jej po cichu dałoby NaN w pozycji linii; odrzucamy ją i zostajemy przy strefie urządzenia.');
    getAccountTimezone.mockResolvedValue({ timezone: 'Not/AZone' });
    const { result } = renderHook(() => useAccountTimezone());
    await waitFor(() => expect(getAccountTimezone).toHaveBeenCalled());
    expect(result.current).toBe(deviceTz);
    expect(localStorage.getItem(ACCOUNT_TZ_KEY)).toBeNull();
  });

  it('clearAccountTimezone drops the cache so the next account starts clean', (ctx) => {
    story(ctx, 'Strefa jest własnością konta, a localStorage należy do urządzenia. Bez czyszczenia przy wylogowaniu kolejny użytkownik na tym samym laptopie dostałby cudzą strefę na pierwszej klatce timeline.');
    localStorage.setItem(ACCOUNT_TZ_KEY, 'Europe/Warsaw');
    clearAccountTimezone();
    expect(localStorage.getItem(ACCOUNT_TZ_KEY)).toBeNull();
  });
});
