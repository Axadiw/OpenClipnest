import type { Request, Response, NextFunction } from 'express';
import {
  RateLimiterRedis,
  RateLimiterMemory,
  type IRateLimiterOptions,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';
import { getRedis } from '../utils/redis.js';

let warnedProdBypass = false;

/**
 * Whether the rate-limit bypass is active. `CLIPNEST_DISABLE_RATE_LIMIT=true`
 * exists only for CI/e2e (no Redis service container). It is REFUSED when
 * NODE_ENV=production so a stray `=true` baked into a prod image or drifting
 * into a prod ConfigMap can never silently disable brute-force / spray /
 * DCR-flood protection. Logged once (loudly) if seen under production.
 */
export function rateLimitBypassEnabled(): boolean {
  if (process.env.CLIPNEST_DISABLE_RATE_LIMIT !== 'true') return false;
  if (process.env.NODE_ENV === 'production') {
    if (!warnedProdBypass) {
      warnedProdBypass = true;
      console.error('[security] CLIPNEST_DISABLE_RATE_LIMIT=true ignored because NODE_ENV=production — rate limiting stays ON.');
    }
    return false;
  }
  return true;
}

interface RateLimitOptions {
  keyPrefix: string;
  maxRequests: number;
  windowMs: number;
  /**
   * Optional bucketing key extractor. Default = client IP (with IPv6 /64
   * truncation). When provided, returning `null` skips the limiter entirely
   * for that request — e.g. a per-email limiter on a request without an
   * email body just falls through to the next middleware. The per-IP
   * limiter further up the chain still applies.
   */
  keyExtractor?: (req: Request) => string | null;
}

/**
 * Derive a rate-limit bucket key from the request's client IP.
 *
 * IPv6 must be truncated to /64 because every residential / VPS IPv6 client
 * has a full /64 prefix routed to them (2^64 addresses). Without truncation
 * a single attacker has effectively unlimited budget — every new /128 = new
 * Redis key. IPv4-mapped IPv6 (`::ffff:a.b.c.d`, what Node hands us under a
 * dual-stack listener for an actual IPv4 client) is folded back to the bare
 * IPv4 form so the same client doesn't accidentally hold two buckets.
 */
export function rateLimitKey(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  const raw = req.ip || req.socket?.remoteAddress;
  if (!raw) return 'unknown';

  // IPv4-mapped IPv6 → underlying IPv4 (dotted form only; the hex form is so
  // rare in real traffic it's not worth the parsing surface).
  if (raw.startsWith('::ffff:') && raw.includes('.')) {
    return raw.slice('::ffff:'.length);
  }

  // Plain IPv4 — no colons.
  if (!raw.includes(':')) return raw;

  // IPv6 — expand `::` and take the first four hextets.
  const [leftRaw, rightRaw] = raw.split('::', 2) as [string, string | undefined];
  const left = leftRaw.length === 0 ? [] : leftRaw.split(':');
  const right = rightRaw === undefined ? null : rightRaw.length === 0 ? [] : rightRaw.split(':');

  let hextets: string[];
  if (right === null) {
    // No `::` — must already be 8 hextets.
    hextets = left;
  } else {
    const missing = 8 - left.length - right.length;
    hextets = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  }

  const prefix = hextets.slice(0, 4).map(h => h || '0').join(':');
  return `${prefix}::/64`;
}

// Augment Express Request with the refund hook so route handlers can return
// the rate-limit point on a successful outcome (see /auth/login). Declared
// once here; the import of this module is enough to apply the augmentation.
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Refund the rate-limit point this middleware consumed for the current
     * request. Call from route handlers on outcomes that should NOT count
     * against the budget (e.g. successful login). No-op when the rate
     * limiter is bypassed (CLIPNEST_DISABLE_RATE_LIMIT=true) or when the
     * middleware never ran for this request.
     */
    refundRateLimit?: () => Promise<void>;
  }
}

function buildMiddleware(
  getLimiter: () => RateLimiterAbstract,
  keyPrefix: string,
  windowMs: number,
  keyExtractor: ((req: Request) => string | null) | undefined,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (rateLimitBypassEnabled()) {
      // Preserve any refund hook a prior limiter installed; otherwise
      // give handlers a safe no-op to call.
      req.refundRateLimit = req.refundRateLimit ?? (async () => { /* bypassed */ });
      next();
      return;
    }

    const key = keyExtractor ? keyExtractor(req) : rateLimitKey(req);
    if (key === null) {
      // Skip — no key, no consumption. Leaves any prior refund chain intact.
      next();
      return;
    }

    try {
      await getLimiter().consume(key, 1);
      // Chain onto whatever a prior limiter installed so a single
      // `req.refundRateLimit()` call refunds every bucket consumed for this
      // request. Without chaining, the per-email limiter on /auth/login
      // would clobber the per-IP refund and a legitimate password-manager
      // workflow (typo + correct) would still burn 1 per-IP point.
      const prevRefund = req.refundRateLimit;
      req.refundRateLimit = async () => {
        await prevRefund?.();
        try {
          await getLimiter().reward(key, 1);
        } catch (err) {
          // Reward is best-effort. A Redis blip during refund just leaves
          // the point consumed — strictly more conservative than the
          // alternative.
          console.warn(`Rate limit refund failed (${keyPrefix}):`, err instanceof Error ? err.message : String(err));
        }
      };
      next();
    } catch (rejected) {
      // rate-limiter-flexible throws a RateLimiterRes on rejection. Network
      // errors arrive as plain Error — in that case fail open: rate limiting
      // is defense-in-depth, not the primary auth gate, so a Redis outage
      // should not 500 the whole API.
      if (rejected instanceof Error) {
        console.error(`Rate limit Redis error (${keyPrefix}):`, rejected.message);
        req.refundRateLimit = req.refundRateLimit ?? (async () => { /* fail-open path */ });
        next();
        return;
      }
      const msBeforeNext = (rejected as { msBeforeNext?: number }).msBeforeNext ?? windowMs;
      const retryAfter = Math.ceil(msBeforeNext / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
  };
}

export function createRateLimit({ keyPrefix, maxRequests, windowMs, keyExtractor }: RateLimitOptions) {
  // Lazily construct the limiter on first request so module load doesn't
  // open a Redis connection — tests that import route modules without a
  // running Redis would otherwise hang on ioredis retry.
  let _limiter: RateLimiterAbstract | null = null;

  const getLimiter = (): RateLimiterAbstract => {
    if (_limiter) return _limiter;
    const opts: IRateLimiterOptions = {
      keyPrefix: `rl:${keyPrefix}`,
      points: maxRequests,
      duration: Math.ceil(windowMs / 1000),
    };
    if (rateLimitBypassEnabled()) {
      _limiter = new RateLimiterMemory({ ...opts, points: Number.MAX_SAFE_INTEGER });
    } else {
      _limiter = new RateLimiterRedis({ ...opts, storeClient: getRedis() });
    }
    return _limiter;
  };

  return buildMiddleware(getLimiter, keyPrefix, windowMs, keyExtractor);
}

/**
 * Test-only factory: returns middleware backed by an in-process
 * `RateLimiterMemory` with the real point budget (not the bypass flag's
 * unlimited variant). Lets unit tests exercise rate-limit behavior without
 * a Redis instance.
 */
export function _createRateLimitForTesting(opts: RateLimitOptions) {
  const limiter = new RateLimiterMemory({
    keyPrefix: `rl:${opts.keyPrefix}`,
    points: opts.maxRequests,
    duration: Math.ceil(opts.windowMs / 1000),
  });
  return buildMiddleware(() => limiter, opts.keyPrefix, opts.windowMs, opts.keyExtractor);
}

// Login: strict limit (brute-force protection)
export const loginRateLimit = createRateLimit({ keyPrefix: 'login', maxRequests: 10, windowMs: 15 * 60 * 1000 });

// Refresh: separate budget so login flak from the same NAT/CGNAT does NOT
// knock out a healthy session's silent token refresh. Refresh requires
// presenting a valid signed refresh-token, so it can't be brute-forced —
// the IP cap is just a backstop against accidental tight loops. 60/min
// per IP comfortably covers a busy office (10+ concurrent users each
// refreshing every ~14 min) without competing with /auth/login's budget.
export const refreshTokenRateLimit = createRateLimit({ keyPrefix: 'refresh', maxRequests: 60, windowMs: 60 * 1000 });

// General API: 300 requests per minute per IP
export const apiRateLimit = createRateLimit({ keyPrefix: 'api', maxRequests: 300, windowMs: 60 * 1000 });

// Media GETs (per-event thumbnails + video streams). A single grid page can
// request up to 1000 thumbnails in parallel, so the general 300/min bucket is
// wildly insufficient for normal browsing. Keep the per-IP cap generous — auth
// already scopes by user, and each response is bounded in size + served via
// cached S3 heads.
export const mediaRateLimit = createRateLimit({ keyPrefix: 'media', maxRequests: 3000, windowMs: 60 * 1000 });

// `/login/begin` is a passkey-state lookup, not an authentication step.
// It returns `mode: 'password'` for unknown emails AND for emails without
// passkey enrolled, so it leaks no information about which accounts have
// passkey vs which don't. The 10/15min cap was triggering false-positive
// fall-throughs to the password form when a real user just refreshed
// /login a few times — the frontend's `catch {}` on `loginBegin` couldn't
// distinguish 429 from "passkey not enrolled" and silently dropped the
// passkey UI, leaving admins thinking passkey was broken (it wasn't —
// they were rate-limited). Cap loosely on the off-chance someone tries
// to use this as a free-form passkey-prompt-spam vector.
export const loginBeginRateLimit = createRateLimit({ keyPrefix: 'login-begin', maxRequests: 60, windowMs: 60 * 1000 });

// Apple-TV device-code generation: 10/hour/IP. A TV requests one code per
// sign-in attempt (and again only after the 5-min code lapses), so this is
// generous for a real living room but blocks a script farming live codes to
// brute-force the /approve step.
export const deviceCodeGenerateRateLimit = createRateLimit({ keyPrefix: 'tv-device-code', maxRequests: 10, windowMs: 60 * 60 * 1000 });

// Apple-TV token poll, bucketed per device_code (not per IP — many TVs sit
// behind one home NAT). 30/min comfortably covers the ~5s poll interval with
// headroom for retries; an attacker can't grind a device_code they don't hold,
// and the per-device bucket means one TV's polling can't starve another's.
export const deviceCodePollRateLimit = createRateLimit({
  keyPrefix: 'tv-device-poll',
  maxRequests: 30,
  windowMs: 60 * 1000,
  keyExtractor: (req) => {
    const dc = (req.body as { device_code?: unknown } | undefined)?.device_code;
    return typeof dc === 'string' && dc.length > 0 ? dc : null;
  },
});

// --- Per-email limiters -----------------------------------------------------
//
// The per-IP limiters above are easily side-stepped by an attacker with access
// to commercial residential proxies or a botnet: each fresh IP starts a new
// budget. The per-email layer below caps abuse-per-target instead, so a
// password-spray (one password × N accounts) or a mail-bomb (3000 reset mails
// to one inbox) hits a budget the attacker cannot rotate around. They sit
// AFTER the per-IP limiters in the route chain; both consume on every request
// and the refund chain returns both on a successful outcome.

export function emailFromBody(req: Request): string | null {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof e !== 'string') return null;
  const normalized = e.trim().toLowerCase();
  return normalized.length === 0 || normalized.length > 254 ? null : normalized;
}

// Per-email login cap. 20/h covers a real user mistyping their password a few
// times, a password-manager bulk verify across stale credentials, and a QA
// run swapping between a handful of test accounts. An attacker spraying
// `password123` across 1M emails hits this on the 21st attempt per account —
// the per-account exponential lockout (recordFailedLogin, 5 → expo backoff)
// kicks in long before that, but this is the backstop for targeted spray.
export const loginEmailRateLimit = createRateLimit({
  keyPrefix: 'login-email',
  maxRequests: 20,
  windowMs: 60 * 60 * 1000,
  keyExtractor: emailFromBody,
});
