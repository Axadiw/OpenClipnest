// server/db.schema-roundtrip.test.ts
//
// Drift-detection: applies all committed migrations to an isolated scratch DB,
// dumps the resulting schema with pg_dump, and compares against the committed
// snapshot file.  Any schema change (new migration, manual tweak) requires an
// explicit snapshot regeneration via ./scripts/regenerate-schema-snapshot.sh.
//
// Skips when DATABASE_URL is not set (no DB in scope — handled by the global
// setupFile).
//
// pg_dump strategy: the local dev Postgres runs inside Docker (v16). The
// system pg_dump (Homebrew v14) refuses to connect to a v16 server.  We
// therefore first try `pg_dump` from PATH; if it fails with "server version
// mismatch" we fall back to `docker exec <container> pg_dump` which ships with
// the container and is always the right version.  CI provides a pg_dump binary
// matching the server, so the fallback is a local-dev convenience only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropScratchSchema, migrateToSchema } from './testing/migrate-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const SNAPSHOT_PATH = join(__dirname, 'db', 'migrations', '__snapshot__.sql');
const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

// Unique scratch schema name per test run (avoids collisions on parallel CI shards)
const SCRATCH_SCHEMA = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Lines that pg_dump emits non-deterministically and must be stripped before
// comparison.  Must match the sed filters in regenerate-schema-snapshot.sh.
const NON_DETERMINISTIC_PREFIXES = ['--', 'SET ', 'SELECT pg_catalog.', '\\restrict', '\\unrestrict'];

function filterDump(raw: string, scratchSchema: string): string {
  return raw
    // Normalise schema prefix: replace "test_xxx". with public. so the output
    // matches the snapshot format (which was generated from a scratch DATABASE
    // where all tables lived in `public`).
    .replace(new RegExp(`"${scratchSchema}"\\.`, 'g'), 'public.')
    .replace(new RegExp(`${scratchSchema}\\.`, 'g'), 'public.')
    // Strip CREATE SCHEMA line for the scratch schema (pg_dump may or may not quote it)
    .replace(new RegExp(`CREATE SCHEMA (?:"${scratchSchema}"|${scratchSchema});?`, 'g'), '')
    // Strip drizzle migration tracking table and its sequence (test artifact,
    // was in the `drizzle` schema in the old scratch-DB approach but is now
    // in the scratch schema — either way it must be excluded from the drift check)
    .replace(/CREATE TABLE (?:\w+\.)?__drizzle_migrations \([\s\S]*?\);/g, '')
    .replace(/CREATE SEQUENCE (?:\w+\.)?__drizzle_migrations_id_seq[\s\S]*?CACHE 1;/g, '')
    .replace(/ALTER SEQUENCE (?:\w+\.)?__drizzle_migrations_id_seq OWNED BY (?:\w+\.)?__drizzle_migrations\.id;/g, '')
    .replace(/ALTER TABLE ONLY (?:\w+\.)?__drizzle_migrations[\s\S]*?;/g, '')
    .split('\n')
    .filter((line) => !NON_DETERMINISTIC_PREFIXES.some((p) => line.startsWith(p)))
    .filter((line) => line.length > 0)
    .join('\n');
}

function normalise(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

/**
 * Run pg_dump against the scratch schema within the test DB.
 *
 * Strategy:
 *   1. Try local pg_dump from PATH (fast, works in CI).
 *   2. If it fails with "server version mismatch", fall back to running
 *      pg_dump inside the Docker container that hosts the Postgres server.
 *      We discover the container by inspecting who is listening on the
 *      same host:port as dbUrl.
 *
 * The -n flag scopes the dump to the scratch schema so we don't capture
 * unrelated schemas (public extensions, other parallel test schemas, etc.).
 */
function pgDump(dbUrl: string, scratchSchema: string): string {
  const pgDumpArgs = ['--schema-only', '--no-owner', '--no-acl', '-n', scratchSchema, dbUrl];

  const result = spawnSync('pg_dump', pgDumpArgs, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  // Success path (CI or local with matching pg_dump version)
  if (result.status === 0) {
    return result.stdout;
  }

  const stderr = result.stderr ?? '';

  // Version mismatch: fall back to docker exec
  if (stderr.includes('server version mismatch') || result.status === 1 && stderr.includes('pg_dump version')) {
    return pgDumpViaDocker(dbUrl, scratchSchema);
  }

  // Other failures
  throw new Error(`pg_dump failed (exit ${result.status}):\n${stderr}`);
}

/**
 * Fall-back: run pg_dump inside the Docker container that owns the Postgres
 * server.  We locate the container by asking docker to list running ones and
 * picking the first whose image contains "postgres".
 *
 * The DB URL is decomposed and passed as individual -U / -d / -h / -p / -n
 * flags (no password in args; PGPASSWORD is set via env) to avoid
 * shell-injection risk even though we are using spawnSync (belt-and-suspenders).
 */
function pgDumpViaDocker(dbUrl: string, scratchSchema: string): string {
  // Find the Postgres container name
  const lsResult = spawnSync(
    'docker',
    ['ps', '--filter', 'ancestor=postgres:16-alpine', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );

  let containerName = lsResult.stdout.trim().split('\n')[0];

  // Fallback: search broader (image may be custom)
  if (!containerName) {
    const lsAll = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'], { encoding: 'utf8' });
    const row = lsAll.stdout
      .split('\n')
      .find((l) => l.toLowerCase().includes('db') && l.toLowerCase().includes('clipnest'));
    containerName = row?.split('\t')[0].trim() ?? '';
  }

  if (!containerName) {
    throw new Error(
      'pg_dump: server version mismatch and could not find a running Postgres Docker container to fall back to.\n' +
        'Install pg_dump matching your Postgres server version, or ensure the dev docker-compose stack is running.',
    );
  }

  // Decompose URL: postgresql://user:password@host:port/dbname
  const parsed = new URL(dbUrl);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const dbName = parsed.pathname.replace(/^\//, '');

  const result = spawnSync(
    'docker',
    [
      'exec',
      '--env',
      `PGPASSWORD=${password}`,
      containerName,
      'pg_dump',
      '--schema-only',
      '--no-owner',
      '--no-acl',
      '-n',
      scratchSchema,
      '-U',
      user,
      '-d',
      dbName,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error(`pg_dump (docker exec ${containerName}) failed:\n${result.stderr}`);
  }

  return result.stdout;
}

describe.skipIf(!TEST_DB_URL)('schema roundtrip', () => {
  let scratchPool: Pool;

  beforeAll(async () => {
    // options sets search_path at connection startup — no connect-event handler needed.
    scratchPool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path="${SCRATCH_SCHEMA}",public` });
    await scratchPool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);

    // Apply all committed migrations to the scratch schema via migrateToSchema
    // (which patches "public"."<table>" FK references to the scratch schema)
    await migrateToSchema(scratchPool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    if (scratchPool) {
      await scratchPool.end();
    }
    // Cleanup via a separate one-shot connection (pool's connect handler
    // would still try to SET search_path to a dropped schema otherwise).
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await dropScratchSchema(cleanup, SCRATCH_SCHEMA);
    await cleanup.end();
  });

  it('produced schema matches committed snapshot', () => {
    const rawDump = pgDump(TEST_DB_URL!, SCRATCH_SCHEMA);
    const dumped = filterDump(rawDump, SCRATCH_SCHEMA);
    const snapshot = readFileSync(SNAPSHOT_PATH, 'utf8');

    const dumpedN = normalise(dumped);
    const snapshotN = normalise(snapshot);

    if (dumpedN !== snapshotN) {
      // Generate a useful diff hint pointing at the first diverging line
      const dLines = dumpedN.split('\n');
      const sLines = snapshotN.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.min(dLines.length, sLines.length); i++) {
        if (dLines[i] !== sLines[i]) {
          firstDiff = i;
          break;
        }
      }
      const hint =
        firstDiff >= 0
          ? `\nFirst divergence at line ${firstDiff + 1}:\n  snapshot: ${sLines[firstDiff]}\n  dumped:   ${dLines[firstDiff]}`
          : `\nLength differs: snapshot=${sLines.length} lines, dumped=${dLines.length} lines`;

      throw new Error(
        `Schema drift detected — committed snapshot does not match what drizzle migrate produces.\n` +
          `If this was intentional (you edited server/db/schema/*.ts and generated a new migration),\n` +
          `regenerate the snapshot:\n` +
          `  ./scripts/regenerate-schema-snapshot.sh\n` +
          `Then commit the updated server/db/migrations/__snapshot__.sql.` +
          hint,
      );
    }

    // Explicit assertion for vitest reporter output
    expect(dumpedN).toBe(snapshotN);
  });
});
