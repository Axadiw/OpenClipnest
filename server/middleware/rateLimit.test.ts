import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';
import { rateLimitKey, _createRateLimitForTesting } from './rateLimit.js';

// CI sets CLIPNEST_DISABLE_RATE_LIMIT=true globally (see ci.yml + cd.yml).
// The bypass branch in buildMiddleware short-circuits before any counting,
// so EVERY consume() returns 200 and the per-email cap tests below would
// silently pass with `[200, 200, 200, 200]` instead of asserting 429 on the
// 4th hit. Strip the flag for this file only — vitest isolates env per
// worker so unsetting it here can't leak into other suites.
const originalDisableFlag = process.env.CLIPNEST_DISABLE_RATE_LIMIT;
beforeAll(() => { delete process.env.CLIPNEST_DISABLE_RATE_LIMIT; });
afterAll(() => {
  if (originalDisableFlag !== undefined) process.env.CLIPNEST_DISABLE_RATE_LIMIT = originalDisableFlag;
});

function makeReq(ip: string | undefined, remote?: string): Request {
  return {
    ip,
    socket: { remoteAddress: remote },
  } as unknown as Request;
}

interface FakeRes extends EventEmitter {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  setHeader(k: string, v: string | number | readonly string[]): FakeRes;
  status(code: number): FakeRes;
  json(b: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const e = new EventEmitter() as FakeRes;
  e.headers = {};
  e.setHeader = function (k, v) { this.headers[k] = String(v); return this; };
  e.status = function (c) { this.statusCode = c; return this; };
  e.json = function (b) { this.body = b; return this; };
  return e;
}

function makeBodyReq(ip: string, body: Record<string, unknown>): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    body,
  } as unknown as Request;
}

describe('rateLimitKey — derives a per-bucket rate-limit key from req', () => {
  it('returns an IPv4 address verbatim', (ctx) => {
    story(
      ctx,
      'IPv4 nie ma "free pool" problemu — atakujący z konkretnego adresu współdzieli budżet z każdym, kto NAT-uje przez to samo IP. Zwracamy adres 1:1.',
    );
    expect(rateLimitKey(makeReq('203.0.113.42'))).toBe('203.0.113.42');
  });

  it('truncates a full IPv6 address to its /64 prefix', (ctx) => {
    story(
      ctx,
      'Klient IPv6 dostaje od ISP cały /64 (2^64 adresów). Bez truncacji każda nowa /128 to świeży budżet → atakujący z byle VPS-em IPv6 ma nieograniczone próby. Klucz musi być /64.',
    );
    const key = rateLimitKey(makeReq('2001:db8:1234:5678:9abc:def0:1234:5678'));
    expect(key).toBe('2001:db8:1234:5678::/64');
  });

  it('truncates a zero-compressed IPv6 to /64', (ctx) => {
    story(
      ctx,
      '`2001:db8::1` to skrót — pełna forma to `2001:db8:0:0:0:0:0:1`. Pierwsze cztery hextety: `2001:db8:0:0`. Truncacja musi rozumieć `::`.',
    );
    expect(rateLimitKey(makeReq('2001:db8::1'))).toBe('2001:db8:0:0::/64');
  });

  it('truncates loopback ::1 to /64', (ctx) => {
    story(
      ctx,
      'Loopback IPv6 `::1` = `0:0:0:0:0:0:0:1`. /64 = `0:0:0:0`. Wszystkie loopback connections lądują w tym samym buckecie, co jest pożądane.',
    );
    expect(rateLimitKey(makeReq('::1'))).toBe('0:0:0:0::/64');
  });

  it('extracts the embedded IPv4 from an IPv4-mapped IPv6 (::ffff:1.2.3.4)', (ctx) => {
    story(
      ctx,
      'Node socket pod dual-stack-ed listenerem podaje IPv4 klienta jako `::ffff:1.2.3.4`. Klucz powinien być stabilny z reprezentacją zwykłą IPv4, żeby ten sam atakujący nie miał dwóch budżetów.',
    );
    expect(rateLimitKey(makeReq('::ffff:203.0.113.42'))).toBe('203.0.113.42');
  });

  it('falls back to socket.remoteAddress when req.ip is missing', (ctx) => {
    story(
      ctx,
      'W niektórych ścieżkach (np. error middleware bez trust proxy) `req.ip` może być undefined. Socket remoteAddress jest deterministycznym fallbackiem.',
    );
    expect(rateLimitKey(makeReq(undefined, '198.51.100.7'))).toBe('198.51.100.7');
  });

  it('returns "unknown" when neither req.ip nor socket.remoteAddress is set', (ctx) => {
    story(
      ctx,
      'Skrajny edge case — request bez żadnego źródła IP. Zwracamy literal "unknown" zamiast undefined, żeby wszyscy tacy "bezimienni" trafili do wspólnego bucketa (a nie obchodzili limit bo Redis nie umie keyować po undefined).',
    );
    expect(rateLimitKey(makeReq(undefined, undefined))).toBe('unknown');
  });
});

describe('createRateLimit with keyExtractor — per-email (or other) bucketing', () => {
  it('counts requests with the same email as one bucket even from different IPs', async (ctx) => {
    story(
      ctx,
      'Cel: zatrzymać password-spray z botnetu. Atakujący ma 1000 IP × ten sam email × `password123` — bez per-email limitu każdy IP startuje świeży budżet. Z per-email limitem 3/window, 4. próba na ten sam email z jakiegokolwiek IP dostaje 429.',
    );
    const mw = _createRateLimitForTesting({
      keyPrefix: 'test-login-email',
      maxRequests: 3,
      windowMs: 60_000,
      keyExtractor: (req) => {
        const e = (req.body as { email?: unknown })?.email;
        return typeof e === 'string' && e.length > 0 ? e : null;
      },
    });

    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = makeRes();
      const next = vi.fn();
      await mw(makeBodyReq(`192.0.2.${i + 1}`, { email: 'victim@example.com' }), res as unknown as Response, next as unknown as NextFunction);
      results.push(next.mock.calls.length === 1 ? 200 : (res.statusCode ?? 0));
    }
    expect(results).toEqual([200, 200, 200, 429]);
  });

  it('does NOT share the bucket between different emails from the same IP', async (ctx) => {
    story(
      ctx,
      'Per-email bucketing musi izolować konta. Atakujący z jednego IP próbujący różne loginy nie powinien wyczerpać limitu po pierwszych N kontach — to byłby DoS na legalnego użytkownika dzielącego NAT/CGNAT (per-IP limiter już to łapie i to jest jego rola; ten nie powinien tego dublować).',
    );
    const mw = _createRateLimitForTesting({
      keyPrefix: 'test-login-email-isolated',
      maxRequests: 2,
      windowMs: 60_000,
      keyExtractor: (req) => {
        const e = (req.body as { email?: unknown })?.email;
        return typeof e === 'string' && e.length > 0 ? e : null;
      },
    });

    const stats = { ok: 0, blocked: 0 };
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const next = vi.fn();
      await mw(makeBodyReq('192.0.2.1', { email: `user-${i}@example.com` }), res as unknown as Response, next as unknown as NextFunction);
      if (next.mock.calls.length === 1) stats.ok++;
      else if (res.statusCode === 429) stats.blocked++;
    }
    expect(stats).toEqual({ ok: 5, blocked: 0 });
  });

  it('skips the limiter (no consumption) when keyExtractor returns null', async (ctx) => {
    story(
      ctx,
      'Gdy request nie ma email-a (np. malformed body), per-email limiter musi po prostu przepuścić — per-IP limiter wciąż go obejmie. W przeciwnym razie atakujący wysyłałby puste body żeby ominąć licznik (kluczowany po "null" = wszystkie wspólny bucket = bardzo szybko 429 dla każdego, kto wysłał coś bez email).',
    );
    const mw = _createRateLimitForTesting({
      keyPrefix: 'test-skip-null',
      maxRequests: 2,
      windowMs: 60_000,
      keyExtractor: () => null,
    });

    let okCount = 0;
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const next = vi.fn();
      await mw(makeBodyReq('192.0.2.1', {}), res as unknown as Response, next as unknown as NextFunction);
      if (next.mock.calls.length === 1) okCount++;
    }
    expect(okCount).toBe(10);
  });

  it('chains refundRateLimit so multiple limiters can return their points on success', async (ctx) => {
    story(
      ctx,
      'Login używa zarówno per-IP, jak i per-email limitera. Po pomyślnym logowaniu OBA muszą zwrócić swój punkt — w przeciwnym razie legalny użytkownik z password-managerem (1 typo + 1 correct) burns budżet 2× szybciej niż cap sugeruje. Drugie middleware musi chainować swój refund na poprzednie, nie nadpisywać.',
    );
    const ipMw = _createRateLimitForTesting({
      keyPrefix: 'test-chain-ip',
      maxRequests: 2,
      windowMs: 60_000,
    });
    const emailMw = _createRateLimitForTesting({
      keyPrefix: 'test-chain-email',
      maxRequests: 2,
      windowMs: 60_000,
      keyExtractor: (req) => (req.body as { email?: string }).email ?? null,
    });

    const req = makeBodyReq('192.0.2.99', { email: 'alice@example.com' });
    const res = makeRes();

    await ipMw(req, res as unknown as Response, (() => {}) as NextFunction);
    await emailMw(req, res as unknown as Response, (() => {}) as NextFunction);

    // Both buckets should now have 1/2 consumed. Call refund — both should be restored.
    await req.refundRateLimit?.();

    // Now we should be able to consume the FULL cap on both buckets again.
    let okCount = 0;
    for (let i = 0; i < 2; i++) {
      const r = makeRes();
      const next = vi.fn();
      await ipMw(makeBodyReq('192.0.2.99', { email: 'alice@example.com' }), r as unknown as Response, next as unknown as NextFunction);
      await emailMw(makeBodyReq('192.0.2.99', { email: 'alice@example.com' }), r as unknown as Response, next as unknown as NextFunction);
      if (next.mock.calls.length >= 1) okCount++;
    }
    expect(okCount).toBe(2); // 2 more attempts pass — only possible if refund chained correctly.
  });
});
