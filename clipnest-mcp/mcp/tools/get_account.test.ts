import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../../../server/db/index.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __mcp_dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__mcp_dirname, '..', '..', '..', 'server', 'db', 'migrations');
import { getAccountImpl } from './get_account.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_GA = `mcp_ga_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const auth = (userId: number, scope = 'account:read') => ({
  userId, clientId: 'test-client', scope, familyId: 'fam', resource: 'res',
});

describeIfDb('get_account tool', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let userUuid: string;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GA}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_GA}"`);
    parent.pathname = `/${SCRATCH_DB_GA}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    // A plan of its own: the migrations seed the stock plans (id 1 included),
    // so reusing a fixed id would read some other plan's name and limits.
    const plan = await pool.query(
      `INSERT INTO plans (name, disk_space_bytes, monthly_transfer_bytes) VALUES ('mcp-ga-plan', 1000, 2000) RETURNING id`,
    );
    userUuid = randomUUID();
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, disk_usage_bytes, transfer_usage_bytes, transfer_reset_at)
       VALUES ($1, $2, 'x', true, true, $3, 500, 1000, NOW() + INTERVAL '10 days') RETURNING id`,
      [userUuid, `ga-test-${Date.now()}@example.com`, plan.rows[0].id],
    );
    userId = u1.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GA}"`);
    await adminPool.end();
  });

  it("returns the caller's plan, disk, and transfer usage with percent", async () => {
    const r = await getAccountImpl({}, auth(userId));
    expect(r.id).toBe(userUuid);
    expect(r.plan).toBe('mcp-ga-plan');
    expect(r.disk.usageBytes).toBe(500);
    expect(r.disk.limitBytes).toBe(1000);
    expect(r.disk.percent).toBe(50);
    expect(r.transfer.usageBytes).toBe(1000);
    expect(r.transfer.limitBytes).toBe(2000);
    expect(r.transfer.percent).toBe(50);
    expect(r.transfer.resetAt).toEqual(expect.any(String));
  });

  it('does not leak internal id or admin fields', async () => {
    const r = await getAccountImpl({}, auth(userId));
    expect(r).not.toHaveProperty('internalId');
    expect(r).not.toHaveProperty('isAdmin');
    expect(r).not.toHaveProperty('passwordHash');
  });

  it('throws insufficient_scope without account:read', async () => {
    await expect(getAccountImpl({}, auth(userId, 'videos:read'))).rejects.toThrow(/insufficient_scope/);
  });
});
