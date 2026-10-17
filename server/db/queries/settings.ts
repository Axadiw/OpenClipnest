// server/db/queries/settings.ts
//
// The `settings` key/value table (JWT secret cache) and DB-level infra queries.
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../index.js';
import { settings } from '../schema/index.js';
import { CONFIG } from '../../config.js';

export async function getSetting(key: string): Promise<string | undefined> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

// JWT secret: cached in memory after first DB load. initJwtSecret() is called
// from initDb() (server/db/index.ts).
let _cachedJwtSecret: string | null = null;

export async function initJwtSecret(): Promise<void> {
  if (CONFIG.jwtSecret) {
    _cachedJwtSecret = CONFIG.jwtSecret;
    return;
  }
  let secret = await getSetting('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('base64url');
    await setSetting('jwt_secret', secret);
  }
  _cachedJwtSecret = secret;
}

/** Synchronous getter — safe after initDb() has been awaited at startup */
export function getJwtSecret(): string {
  if (!_cachedJwtSecret) throw new Error('DB not initialized: call initDb() first');
  return _cachedJwtSecret;
}

/** Override the JWT secret cache for tests. */
export function __setJwtSecretForTest(secret: string): void {
  _cachedJwtSecret = secret;
}
