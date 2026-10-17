import { Redis, type RedisOptions } from 'ioredis';

// ---------------------------------------------------------------------------
// Redis singleton
//
// Used for:
//   - rate limiting      (rate-limiter-flexible, server/middleware/rateLimit.ts)
//   - messaging          (Redis Streams — server/services/streamsClient.ts,
//                        consumed by scanner-entry / thumbnail-worker-entry)
//
// The connection is backed by ioredis. ioredis handles reconnect + command
// queueing transparently, so callers can just `getRedis()` and issue commands.
// Tests that need isolation from the shared singleton should construct their
// own `new Redis(...)` instead of using `getRedis()`.
// ---------------------------------------------------------------------------

let _client: Redis | null = null;

export function getRedisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://redis:6379';
}

/** Redact `user:password` in URLs before logging. */
function redactUrl(url: string): string {
  return url.replace(/\/\/([^@]+)@/, '//***@');
}

/**
 * Resolve the AUTH password for the Redis connection.
 *
 * Prod Redis requires AUTH. The canonical wiring injects the password INTO
 * `REDIS_URL` (`redis://:<pw>@host:6379`) via each Deployment's `sh -c`
 * wrapper, and ioredis re-sends that URL-parsed password on every reconnect
 * automatically. The gap that produced the intermittent
 * `NOAUTH Authentication required.` Sentry issue: an entrypoint that builds
 * this singleton from the BARE ConfigMap `REDIS_URL` (no auth segment) without
 * that wrapper — e.g. a CronJob that imports a module which transitively calls
 * `getRedis()`. Such a client connects unauthenticated and the first command
 * (or the first command after a reconnect) gets NOAUTH.
 *
 * Belt-and-braces: also read `REDIS_PASSWORD` and pass it as an explicit
 * ioredis `password` option. This is additive and safe:
 *   - URL already carries a password  → ioredis keeps the URL password
 *     (explicit option does NOT override a URL-embedded one), so the normal
 *     prod path is unchanged.
 *   - URL has no password but REDIS_PASSWORD is set → the explicit option
 *     supplies it, closing the gap for any wrapper-less entrypoint.
 *   - Neither set (local dev / CI, unauthenticated Redis) → `undefined`, no AUTH.
 * Either way the resolved password lives in `options.password`, which ioredis
 * re-authenticates with on every reconnect.
 */
function resolvePassword(): string | undefined {
  return process.env.REDIS_PASSWORD || undefined;
}

/**
 * Shared singleton Redis client.
 *
 * `maxRetriesPerRequest: null` is required for blocking commands (XREADGROUP
 * BLOCK, BLPOP). Without it, ioredis rejects long-running blocking requests
 * with MaxRetriesPerRequestError once the connection drops once.
 */
export function getRedis(overrides?: RedisOptions): Redis {
  if (_client) return _client;

  const url = getRedisUrl();
  const client = new Redis(url, {
    // Explicit AUTH password as a fallback for entrypoints whose REDIS_URL
    // lacks the auth segment (see resolvePassword). A URL-embedded password
    // takes precedence in ioredis, so this never clobbers the normal path —
    // and it guarantees the password rides every reconnect's AUTH.
    password: resolvePassword(),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
    ...overrides,
  });

  const tag = redactUrl(url);
  client.on('connect', () => console.log(`Redis: connecting to ${tag}`));
  client.on('ready', () => console.log('Redis: ready'));
  client.on('error', (err: Error) => console.error('Redis error:', err.message));
  client.on('close', () => console.log('Redis: connection closed'));
  client.on('reconnecting', () => console.log('Redis: reconnecting...'));

  _client = client;
  return client;
}

/** Close the singleton. Safe to call during shutdown. */
export async function closeRedis(): Promise<void> {
  const client = _client;
  if (!client) return;
  _client = null;
  await client.quit().catch(() => client.disconnect());
}
