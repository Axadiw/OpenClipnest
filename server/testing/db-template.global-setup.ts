/**
 * Vitest globalSetup: migrate ONE template database per run, so DB test files
 * copy it (`createScratchDb`, a file-level `CREATE DATABASE … TEMPLATE`)
 * instead of each replaying every migration in its own scratch schema.
 *
 * Replaying the migrations costs 3-10 s per file on CI's Postgres 14, and with
 * a dozen files starting at once on one shared runner host that was the
 * slowest part of the suite and the usual reason a beforeAll hit its timeout.
 *
 * Files that test the migrations themselves (db.migrate*, schema-roundtrip)
 * still replay them into a scratch schema — that is what they are about.
 *
 * Without a database URL this does nothing; the DB suites skip on their own.
 */
import type { TestProject } from 'vitest/node';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateToSchema } from './migrate-schema.js';
import { SCRATCH_DB_PREFIX, TEMPLATE_DB_PREFIX, databaseUrl, testDbBaseUrl } from './scratch-db.js';
// The per-worker setupFile reads .env into process.env; globalSetup runs
// before any worker, so it needs the same lookup here.
import './load-env-for-tests.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbTemplate: { baseUrl: string; template: string } | null;
  }
}

/**
 * Databases are named `<prefix><unix ms>_<random>`; leftovers of a run killed
 * before its teardown are dropped once they are older than this.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function dropStaleDatabases(admin: pg.Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2`,
    [`${SCRATCH_DB_PREFIX}%`, `${TEMPLATE_DB_PREFIX}%`],
  );
  for (const { datname } of rows) {
    const createdAt = Number(datname.replace(SCRATCH_DB_PREFIX, '').replace(TEMPLATE_DB_PREFIX, '').split('_')[0]);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < STALE_AFTER_MS) continue;
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
  }
}

export default async function setup(project: TestProject) {
  const baseUrl = testDbBaseUrl();
  if (!baseUrl) {
    project.provide('dbTemplate', null);
    return;
  }

  const template = `${TEMPLATE_DB_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await dropStaleDatabases(admin);
    await admin.query(`CREATE DATABASE "${template}"`);
  } finally {
    await admin.end();
  }

  // Migrate into the template's own public schema (the "public". rewrite in
  // migrateToSchema is then a no-op). The pool must be closed before anyone
  // copies the template: Postgres refuses a template that has sessions.
  const pool = new pg.Pool({ connectionString: databaseUrl(baseUrl, template), max: 1 });
  try {
    await migrateToSchema(pool, 'public', MIGRATIONS_DIR);
  } finally {
    await pool.end();
  }

  project.provide('dbTemplate', { baseUrl, template });

  return async () => {
    const c = new pg.Client({ connectionString: baseUrl });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
}
