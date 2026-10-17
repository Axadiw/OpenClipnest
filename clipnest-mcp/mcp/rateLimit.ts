import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, type RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedis } from '../../server/utils/redis.js';

export interface RateLimitOpts {
  points: number;
  durationSec: number;
  keyPrefix: string;
}

/**
 * Per-token budget for MCP calls, counted in Redis so every replica shares
 * it. `store` replaces the Redis limiter — tests pass an in-memory one.
 */
export function perTokenRateLimit(opts: RateLimitOpts, store?: RateLimiterAbstract) {
  const limiter = store ?? new RateLimiterRedis({
    storeClient: getRedis(),
    keyPrefix: opts.keyPrefix,
    points: opts.points,
    duration: opts.durationSec,
  });
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = (req as any).tokenForLimit ?? req.ip ?? 'anon';
    try {
      await limiter.consume(key);
      next();
    } catch (e: any) {
      res.set('Retry-After', String(Math.ceil((e?.msBeforeNext ?? 60_000) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
    }
  };
}
