// server/index.ts — API process entrypoint.
//
// Builds the app for the selected edition (server/edition.ts), waits for the
// DB and Redis, then opens the listener.
import { CONFIG } from './config.js';
import { initDb } from './db/index.js';
import { getRedis } from './utils/redis.js';
import { seedFirstAccountFromEnv, seedOutcome } from './services/bootstrap.js';
import { createApp } from './app.js';
import { edition } from './edition.js';

edition.preflight?.();

const app = createApp(edition);

await initDb();
console.log('Database initialized');

// Wait for Redis to be ready before opening the listener so the first
// /healthz hit (readiness probe at +5s) can ping Redis without having to
// wait on the very first connect/AUTH/INFO round-trip. With lazy init the
// probe could blow past its 1s budget on cold start, fail 3× in a row, and
// get the process killed (exit 137). Forcing the connect-and-ready handshake
// here makes startup deterministic.
await getRedis().ping();
console.log('Redis ready');

// First-boot account: CLIPNEST_BOOTSTRAP_EMAIL/PASSWORD (any environment —
// the docker-compose install path) or DEV_SEED_* in development. No-op once
// any user exists; refuses to start when no account can exist. See
// services/bootstrap.ts.
const seeded = seedOutcome(await seedFirstAccountFromEnv(edition.firstAccount), edition.firstAccount);
if (seeded) console[seeded.level](seeded.message);
if (seeded && !seeded.start) process.exit(1);

await edition.onStart?.();

app.listen(CONFIG.port, () => {
  console.log(`Clipnest API (${edition.name}) running on port ${CONFIG.port}`);
});
