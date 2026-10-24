/**
 * createScratchDb — a fully migrated, private database for one test file.
 *
 * Copies the template that `db-template.global-setup.ts` migrated once for the
 * whole run (`CREATE DATABASE … TEMPLATE`, a file-level copy), so a file gets
 * every table, seed row and the citext extension without replaying the
 * migrations. Everything lives in the copy's `public` schema; drop() removes
 * the database.
 *
 * Usage:
 *   let scratch: ScratchDb;
 *   beforeAll(async () => { scratch = await createScratchDb({ max: 5 }); pool = scratch.pool; });
 *   afterAll(async () => { await scratch?.drop(); });
 *
 * Only call it inside a suite that already skips without a database URL.
 */
import { inject } from 'vitest';
import pg from 'pg';

export const SCRATCH_DB_PREFIX = 'vt_scratch_';
export const TEMPLATE_DB_PREFIX = 'vt_template_';

/** The URL the DB suites read, in the precedence they use. */
export function testDbBaseUrl(): string | undefined {
  return process.env.DATABASE_URL_TEST ?? process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

/** `url` pointed at another database on the same server. */
export function databaseUrl(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface ScratchDb {
  pool: pg.Pool;
  /** Connection string of the copy, e.g. for a CLI run in a child process. */
  url: string;
  drop(): Promise<void>;
}

// SQLSTATE 55006: "source database … is being accessed by other users".
// Nothing should hold the template open, but don't fail a file on a race.
const OBJECT_IN_USE = '55006';
// SQLSTATE 57P01: "terminating connection due to administrator command".
const ADMIN_SHUTDOWN = '57P01';

export async function createScratchDb(opts: { max?: number } = {}): Promise<ScratchDb> {
  const provided = inject('dbTemplate');
  if (!provided) {
    throw new Error('createScratchDb: no template database — is the database URL set and the globalSetup registered?');
  }
  const { baseUrl, template } = provided;
  const name = `${SCRATCH_DB_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== OBJECT_IN_USE || attempt >= 10) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }

  const url = databaseUrl(baseUrl, name);
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 });
  let dropped = false;
  // An idle client the server closes reaches the pool as an 'error' event, and
  // a pool without a listener turns that into an unhandled error that fails the
  // whole run although every test passed. DROP … WITH (FORCE) terminates
  // connections that are still closing (57P01, admin shutdown) — expected once
  // drop() has started; anything else is still reported.
  pool.on('error', (err) => {
    if (dropped && (err as { code?: string }).code === ADMIN_SHUTDOWN) return;
    console.error(`[scratch-db] idle client error: ${err.message}`);
  });
  return {
    pool,
    url,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
