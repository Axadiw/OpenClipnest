import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, setToken, setRefreshToken, getToken, logout, clearToken } from './api';
import { story } from './test-story';

const RATE_LIMITED = 'clipnest:rate-limited';

function res429(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), { status: 429, headers });
}
function res401(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}

describe('api request() — 429 / Retry-After', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws ApiError(429) carrying the parsed Retry-After seconds', async (ctx) => {
    story(ctx, 'Spam CMD+R przekracza 300 żądań/min — wrapper API musi wystawić dzwoniącemu liczbę sekund z nagłówka Retry-After, nie tylko goły status, żeby dało się pokazać odliczanie.');
    (fetchSpy as unknown as { mockResolvedValueOnce: (r: Response) => void }).mockResolvedValueOnce(res429('30'));
    const err = await api.getVersion().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).retryAfter).toBe(30);
  });

  it('broadcasts clipnest:rate-limited with the retryAfter so the global notice can show a countdown', async (ctx) => {
    story(ctx, 'Każdy 429 — z dowolnego wywołania (getVersion/getEvents/...) — emituje jeden globalny event, żeby toast odliczania pojawił się raz, bez dotykania każdego call-site.');
    (fetchSpy as unknown as { mockResolvedValueOnce: (r: Response) => void }).mockResolvedValueOnce(res429('45'));
    const seen: Array<number | undefined> = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail.retryAfter);
    window.addEventListener(RATE_LIMITED, handler);
    await api.getVersion().catch(() => {});
    window.removeEventListener(RATE_LIMITED, handler);
    expect(seen).toEqual([45]);
  });

  it('still signals (retryAfter undefined) when the Retry-After header is absent', async (ctx) => {
    story(ctx, 'Gdy 429 przyjdzie bez nagłówka (np. z ingress/nginx), nie zmyślamy "0:00" — sygnał leci z retryAfter=undefined, a UI pokaże wariant bez liczby.');
    (fetchSpy as unknown as { mockResolvedValueOnce: (r: Response) => void }).mockResolvedValueOnce(res429(undefined));
    let detail: { retryAfter?: number } | undefined;
    const handler = (e: Event) => { detail = (e as CustomEvent).detail; };
    window.addEventListener(RATE_LIMITED, handler);
    const err = await api.getVersion().catch((e) => e);
    window.removeEventListener(RATE_LIMITED, handler);
    expect((err as ApiError).retryAfter).toBeUndefined();
    expect(detail).toEqual({ retryAfter: undefined });
  });

  it('a 429 on token refresh keeps the session — no clearToken, no reload', async (ctx) => {
    story(ctx, 'Przy spamie CMD+R nawet odświeżenie tokenu może dostać 429. Wylogowanie+reload w tym momencie tworzyłoby pętlę logout→reload. Zamiast tego sesja zostaje, a użytkownik widzi odliczanie.');
    setToken('access-token', true);
    setRefreshToken('refresh-token', true);
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    (fetchSpy as unknown as { mockResolvedValueOnce: (r: Response) => void; })
      .mockResolvedValueOnce(res401());      // getVersion → token expired
    (fetchSpy as unknown as { mockResolvedValueOnce: (r: Response) => void; })
      .mockResolvedValueOnce(res429('20'));  // refresh → throttled
    const err = await api.getVersion().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect(getToken()).toBe('access-token'); // session preserved
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('logout()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function ok(body: unknown = { success: true }): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('ends only this device by default, using the tokens it had when called', async (ctx) => {
    story(ctx, 'Wylogowanie w przeglądarce kończy tylko jej sesję — i działa, choć tokeny lokalne są czyszczone zaraz po wywołaniu.');
    setToken('access-1');
    setRefreshToken('refresh-1');
    fetchSpy.mockResolvedValueOnce(ok());

    const pending = logout();
    clearToken();

    expect(await pending).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v0/auth/logout');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(init.body as string)).toEqual({ scope: 'device' });
  });

  it('refreshes an expired access token once and then signs out', async (ctx) => {
    story(ctx, 'Gdy access token już wygasł, wylogowanie odświeża go zapamiętanym refresh tokenem i dopiero wtedy kończy sesję — inaczej sesja zostałaby żywa na serwerze.');
    setToken('expired');
    setRefreshToken('refresh-1');
    fetchSpy
      .mockResolvedValueOnce(res401())
      .mockResolvedValueOnce(ok({ token: 'access-2', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(ok());

    const pending = logout('all');
    clearToken();

    expect(await pending).toBe(true);
    const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(c => c[0])).toEqual(['/api/v0/auth/logout', '/api/v0/auth/refresh', '/api/v0/auth/logout']);
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ refreshToken: 'refresh-1' });
    expect((calls[2][1].headers as Record<string, string>).Authorization).toBe('Bearer access-2');
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ scope: 'all' });
  });

  it('resolves false instead of throwing when the network is down', async (ctx) => {
    story(ctx, 'Brak sieci nie może zablokować lokalnego wylogowania — funkcja nie rzuca, tylko zwraca false.');
    setToken('access-1');
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await logout()).toBe(false);
  });
});
