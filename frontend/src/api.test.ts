import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, setToken, setRefreshToken, getToken } from './api';
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
