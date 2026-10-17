/**
 * Vitest setup: load .env for tests so the local docker-compose stack is
 * auto-discovered.
 *
 * The DB-touching tests (db.advisory-lock, db.migrate, db.file-metadata,
 * db.null-event-file-columns, db.processing-status, db.recompute-*) skip when
 * `process.env.DATABASE_URL` is unset. CI sets it via secrets; locally we
 * derive it from the `.env` file that `docker compose` already consumes for
 * `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`.
 *
 * Precedence (highest first):
 *   1. existing `process.env.DATABASE_URL` (CI, explicit override) — kept as-is
 *   2. `DATABASE_URL` line in `.env`
 *   3. constructed `postgresql://USER:PASS@127.0.0.1:5432/DB` from `.env`
 *      POSTGRES_* vars
 *
 * Note on (3): `docker-compose.dev.yml` HARDCODES `POSTGRES_PASSWORD:
 * devpassword` for the dev database, overriding `.env` — so on a machine whose
 * `.env` carries a different (e.g. production) `POSTGRES_PASSWORD`, (3)
 * constructs a URL that fails auth. Set an explicit `DATABASE_URL` in `.env`
 * for the local stack; (2) then wins and (3) never runs.
 *
 * Missing `.env` is non-fatal — tests that need a DB will skip the same way
 * they did before this file existed. Designed to be a setupFile (runs once
 * per worker), not a globalSetup (which would only run once per process).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// ONLY infra-connection keys are taken from `.env`. This used to backfill
// every key in the file, which quietly handed the suite the developer's whole
// local config — and CI has no `.env` at all, so any test asserting a
// production default passed there and failed on every dev machine. Concretely:
// `.env` carries the local stack's `PUBLIC_APP_URL`, which once made
// tv-device-auth's `verification_uri` assertion (then pinned to the production
// default) fail locally and only locally. Anything a test needs beyond "how do
// I reach the local stack" must be set by the test itself, so it reads the
// same on both.
const ENV_KEYS_FOR_TESTS = [
  'DATABASE_URL', 'REDIS_URL',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST', 'POSTGRES_PORT',
];

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const parsed = parseDotenv(readFileSync(envPath, 'utf8'));
  for (const key of ENV_KEYS_FOR_TESTS) {
    if (process.env[key] === undefined && parsed[key] !== undefined) {
      process.env[key] = parsed[key];
    }
  }
}

// Redis: `getRedis()` defaults to the compose hostname `redis://redis:6379`,
// which does not resolve from the host. ioredis is configured with
// `maxRetriesPerRequest: null`, so a command against an unresolvable host does
// not fail — it hangs until vitest's hook timeout fires (mcpClients' beforeAll,
// 60 s). docker-compose.dev.yml publishes redis on 127.0.0.1:6379, so point
// host-run tests there. CI has no Redis service and instead sets
// CLIPNEST_DISABLE_RATE_LIMIT=true, which makes those call sites skip entirely.
if (!process.env.REDIS_URL && process.env.CLIPNEST_DISABLE_RATE_LIMIT !== 'true') {
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
}

// Construct DATABASE_URL if not already set and we have the parts.
if (!process.env.DATABASE_URL) {
  const user = process.env.POSTGRES_USER ?? 'clipnest';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB ?? 'clipnest';
  const host = process.env.POSTGRES_HOST ?? '127.0.0.1';
  const port = process.env.POSTGRES_PORT ?? '5432';
  if (pass) {
    process.env.DATABASE_URL =
      `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
}
