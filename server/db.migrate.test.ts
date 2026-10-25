// server/db.migrate.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { plans } from './db/schema/users.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { story } from './testing/story.js';
import { dropScratchSchema, resetScratchSchema, migrateToSchema, runMigrationFileInSchema } from './testing/migrate-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

const SCRATCH_SCHEMA = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!TEST_DB_URL)('drizzle migrate', () => {
  let pool: Pool;

  beforeAll(async () => {
    // options sets search_path at connection startup — no connect-event handler needed.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path="${SCRATCH_SCHEMA}",public` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    // Cleanup via a separate one-shot connection (pool's connect handler
    // would still try to SET search_path to a dropped schema otherwise).
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await dropScratchSchema(cleanup, SCRATCH_SCHEMA);
    await cleanup.end();
  });

  beforeEach(async () => {
    // Wipe scratch schema for fresh state per test
    await resetScratchSchema(pool, SCRATCH_SCHEMA);
  });

  // 30s timeout: migrateToSchema applies all migration .sql files with
  // schema-name string-replacement; on CI's Postgres 14 each run takes
  // ~3-5s and vitest's default 5s timeout is too tight, especially when
  // several test files run migrate in parallel and contend for the pool.
  it('creates all 39 tables (24 v10 baseline + push + identities + tv_device_codes + ip_login_attempts + invite_codes + payment tables + payment_reconcile_runs + user_sessions + content deletion tables + purchase_statements) from baseline migration on empty DB', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename != '__drizzle_migrations' ORDER BY tablename`,
      [SCRATCH_SCHEMA],
    );
    const tables = rows.map((r) => r.tablename);

    // v10 adds event_view_files (24); 0004_add_push_tables adds
    // push_devices + push_prefs (26 total); 0007_identities_framerate adds
    // user_identities (27 total); 0011_add_tv_device_codes adds
    // tv_device_codes (28 total); 0014_add_ip_login_throttle adds
    // ip_login_attempts (29 total); 0016_add_invite_codes adds
    // invite_codes (30 total); 0021_payment_subscriptions adds
    // payment_customers, subscriptions, payment_events (33 total);
    // 0022_admin_lock_plan_override adds payment_reconcile_runs (34 total);
    // 0023_user_sessions adds user_sessions (35 total)
    // 0025_content_deletion adds content_deletions, content_deletion_runs, account_notices (38 total)
    // 0026_purchase_statements adds purchase_statements (39 total)
    expect(tables).toHaveLength(39);
    expect(tables).toEqual(expect.arrayContaining([
      'plans', 'users', 'email_tokens', 'passkeys', 'passkey_backup_codes',
      'events', 'event_view_files', 'file_metadata', 'user_scan_state', 'user_camera_profiles',
      'oauth_clients', 'oauth_authorization_txns', 'oauth_authorization_codes',
      'oauth_access_tokens', 'oauth_refresh_tokens',
      'upload_events', 'storage_reconciliation_runs', 'storage_disk_corrections',
      'storage_orphan_objects',
      'notifications', 'user_bans', 'user_appeals', 'mcp_audit_log', 'settings',
      'push_devices', 'push_prefs', 'user_identities', 'tv_device_codes',
      'ip_login_attempts', 'invite_codes',
      'payment_customers', 'subscriptions', 'payment_events', 'payment_reconcile_runs',
      'user_sessions', 'content_deletions', 'content_deletion_runs', 'account_notices',
      'purchase_statements',
    ]));
  });

  it('is idempotent on second run', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    // Count should equal the number of migration files in the journal.
    // Updated 2->3 when migration 0002_rename_lens_to_view was added;
    // 3->4 when migration 0003_add_upload_30d_bytes was added;
    // 4->5 when migration 0004_add_push_tables was added;
    // 5->6 when migration 0005_add_push_supports_loc_keys was added;
    // 6->7 when migration 0006_add_events_created_at was added;
    // 7->8 when migration 0007_identities_framerate was added;
    // 8->9 when migration 0008_add_processing_state was added;
    // 9->10 when migration 0009_drop_legacy_playback_patch was added;
    // 10->11 when migration 0010_unrecognized_retry_index was added;
    // 11->12 when migration 0011_add_tv_device_codes was added;
    // 12->13 when migration 0012_add_tv_device_id was added;
    // 13->14 when migration 0013_oauth_token_generation was added;
    // 14->15 when migration 0014_add_ip_login_throttle was added;
    // 15->16 when migration 0015_add_file_metadata_truncated was added;
    // 16->17 when migration 0016_add_invite_codes was added;
    // 17->18 when migration 0017_add_push_device_relay was added;
    // 18->19 when migration 0018_split_login_lockout_channels was added;
    // 19->20 when migration 0019_add_account_access_lock was added.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${SCRATCH_SCHEMA}".__drizzle_migrations`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(27); // 26->27 when 0026_purchase_statements was added
  });

  it('preserves CITEXT and JSONB column types', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows: emailCol } = await pool.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='email'`,
      [SCRATCH_SCHEMA],
    );
    expect(emailCol[0]?.udt_name).toBe('citext');

    const { rows: jsonbCol } = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='mcp_audit_log' AND column_name='details_json'`,
      [SCRATCH_SCHEMA],
    );
    expect(jsonbCol[0]?.data_type).toBe('jsonb');
  });

  const CATALOG_SQL = `SELECT name, disk_space_bytes::text AS disk, monthly_transfer_bytes::text AS transfer,
            monthly_price_cents AS price, currency, sort_order, is_public, price_lookup_key
       FROM plans ORDER BY sort_order, id`;
  const EXPECTED_CATALOG = [
    { name: 'Basic', disk: '5368709120', transfer: '10737418240', price: 999, currency: 'EUR', sort_order: 10, is_public: true, price_lookup_key: 'basic_monthly' },
    { name: 'Plus', disk: '21474836480', transfer: '42949672960', price: 1999, currency: 'EUR', sort_order: 20, is_public: true, price_lookup_key: 'plus_monthly' },
    { name: 'Max', disk: '107374182400', transfer: '214748364800', price: 4999, currency: 'EUR', sort_order: 30, is_public: true, price_lookup_key: 'max_monthly' },
    { name: 'Ultra', disk: '1099511627776', transfer: '2199023255552', price: 19999, currency: 'EUR', sort_order: 40, is_public: true, price_lookup_key: 'ultra_monthly' },
    { name: 'Tiny', disk: '131072', transfer: '262144', price: null, currency: 'EUR', sort_order: 1000, is_public: false, price_lookup_key: null },
  ];

  it('seeds the plan catalog: Basic/Plus/Max/Ultra public with prices, Tiny hidden', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Po migracji baza zna cztery publiczne plany z cenami w EUR i ukryty plan testowy Tiny — strona cennika czyta je stąd.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    const { rows } = await pool.query(CATALOG_SQL);
    expect(rows).toEqual(EXPECTED_CATALOG);
  });

  it('moves users with the plan: Pro becomes Plus and the old Max becomes Ultra (same plan id)', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Użytkownik planu Pro po migracji ma plan Plus, a użytkownik starego Max ma Ultra — ten sam wiersz, nowe nazwy i limity.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    const ids = await pool.query(`SELECT name, id FROM plans`);
    const byName = Object.fromEntries(ids.rows.map((r: { name: string; id: number }) => [r.name, r.id]));
    // Baseline seeds plans in the order Basic, Pro, Max, Tiny, so ids 2 and 3 were Pro and Max.
    expect(byName.Plus).toBe(2);
    expect(byName.Ultra).toBe(3);
    expect(byName.Max).toBeGreaterThan(4);
  });

  it('re-running the catalog migration leaves the catalog unchanged', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Ponowne uruchomienie migracji nie zmienia katalogu.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    const before = await pool.query('SELECT id, name FROM plans ORDER BY id');
    await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0020_plan_catalog');
    const { rows } = await pool.query(CATALOG_SQL);
    expect(rows).toEqual(EXPECTED_CATALOG);
    const after = await pool.query('SELECT id, name FROM plans ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });

  it('folds a hand-made pre-catalog Plus into Ultra and gives the name Plus to the old Pro', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Ręcznie dodany plan Plus (500 GB) znika, a jego użytkownik przechodzi na Ultra, gdzie jego nagrania się mieszczą; nazwa Plus trafia do dawnego Pro.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    // Rewind to the production state before the catalog: Pro exists, plus a hand-made Plus.
    await pool.query(`UPDATE plans SET name='Pro' WHERE name='Plus'`);
    const legacy = (await pool.query<{ id: number }>(
      `INSERT INTO plans (name, disk_space_bytes, monthly_transfer_bytes) VALUES ('Plus', 536870912000, 1099511627776) RETURNING id`,
    )).rows[0].id;
    const user = (await pool.query<{ id: number }>(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ('00000000-0000-4000-8000-0000000000aa', 'legacy-plus@example.test', 'x', true, true, $1) RETURNING id`,
      [legacy],
    )).rows[0].id;
    const invite = (await pool.query<{ id: number }>(
      `INSERT INTO invite_codes (code, plan_id) VALUES ('LEGACY-PLUS-CODE', $1) RETURNING id`,
      [legacy],
    )).rows[0].id;
    const ultra = (await pool.query<{ id: number }>(`SELECT id FROM plans WHERE name='Ultra'`)).rows[0].id;
    try {
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0020_plan_catalog');
      expect((await pool.query(`SELECT plan_id FROM users WHERE id=$1`, [user])).rows[0].plan_id).toBe(ultra);
      expect((await pool.query(`SELECT plan_id FROM invite_codes WHERE id=$1`, [invite])).rows[0].plan_id).toBe(ultra);
      expect((await pool.query(`SELECT 1 FROM plans WHERE id=$1`, [legacy])).rowCount).toBe(0);
      const plus = (await pool.query(`SELECT disk_space_bytes::text AS disk, monthly_transfer_bytes::text AS transfer FROM plans WHERE name='Plus'`)).rows;
      expect(plus).toEqual([{ disk: '21474836480', transfer: '42949672960' }]);
      expect((await pool.query(CATALOG_SQL)).rows).toEqual(EXPECTED_CATALOG);
    } finally {
      await pool.query(`DELETE FROM invite_codes WHERE id=$1`, [invite]);
      await pool.query(`DELETE FROM users WHERE id=$1`, [user]);
    }
  });

  it('a duplicate price_lookup_key surfaces as a wrapped 23505 on the constraint (what the plans route unwraps)', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Dwa plany z tym samym kluczem ceny: baza odrzuca drugi, a błąd drizzle niesie kod 23505 i nazwę ograniczenia w polu cause - po tym router rozpoznaje 409.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    const d = drizzle(pool);
    const ins = (name: string) => d.insert(plans).values({ name, diskSpaceBytes: 1, monthlyTransferBytes: 1, monthlyPriceCents: 1, priceLookupKey: 'dup_key_test' });
    await ins('Dup A');
    const err = await ins('Dup B').then(() => null, (e) => e) as { cause?: { code?: string; constraint?: string } } | null;
    expect(err).not.toBeNull();
    expect(err!.cause?.code).toBe('23505');
    expect(err!.cause?.constraint).toBe('plans_price_lookup_key_unique');
  });

  it('refuses a price without a price key and a public plan that is not for sale', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Baza nie pozwala zrobić planu z ceną bez klucza ceny ani publicznego planu, którego nie da się kupić.');
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    const fails = async (sql: string) => pool.query(sql).then(() => null, (e: { code?: string; constraint?: string }) => e);
    const pair = await fails(`UPDATE plans SET price_lookup_key = NULL WHERE name = 'Basic'`);
    expect(pair?.code).toBe('23514');
    expect(pair?.constraint).toBe('plans_price_pair_check');
    const pub = await fails(`UPDATE plans SET is_public = true WHERE name = 'Tiny'`);
    expect(pub?.code).toBe('23514');
    expect(pub?.constraint).toBe('plans_public_needs_price_check');
    expect((await pool.query(CATALOG_SQL)).rows).toEqual(EXPECTED_CATALOG);
  });

  describe('0021_payment_subscriptions', () => {
    const insertUser = async (uuid: string): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`,
        [uuid, `${uuid}@example.test`],
      );
      return rows[0].id;
    };
    const cols = async (table: string) => {
      const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name`,
        [SCRATCH_SCHEMA, table],
      );
      return Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'YES' ? '?' : ''}`]));
    };

    it('creates the payment tables with the agreed columns', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji istnieją tabele klientów płatności, subskrypcji i zdarzeń płatności z uzgodnionymi kolumnami.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const tz = 'timestamp with time zone';
      expect(await cols('payment_customers')).toEqual({
        user_id: 'integer', provider_customer_id: 'text', created_at: tz,
      });
      expect(await cols('subscriptions')).toEqual({
        id: 'integer', user_id: 'integer', provider_subscription_id: 'text', status: 'text',
        price_lookup_key: 'text?', current_period_end: `${tz}?`, cancel_at: `${tz}?`,
        canceled_at: `${tz}?`, waiver_accepted_at: `${tz}?`, created_at: tz, updated_at: tz,
        scheduled_change_at: `${tz}?`, scheduled_price_lookup_key: 'text?',
      });
      expect(await cols('payment_events')).toEqual({
        event_id: 'text', type: 'text', received_at: tz, processed_at: `${tz}?`, error: 'text?',
      });
      const users = await cols('users');
      expect(users.plan_source).toBe('text');
      expect(users.plan_expires_at).toBe(`${tz}?`);
    });

    it('plan_source defaults to admin and the CHECK refuses other values', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Nowe konto ma źródło planu "admin", a baza odrzuca nieznane źródło planu.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const id = await insertUser('plan-source-default');
      const { rows } = await pool.query(`SELECT plan_source, plan_expires_at FROM users WHERE id=$1`, [id]);
      expect(rows[0]).toEqual({ plan_source: 'admin', plan_expires_at: null });
      for (const ok of ['invite', 'subscription']) {
        await pool.query(`UPDATE users SET plan_source=$2 WHERE id=$1`, [id, ok]);
      }
      const err = await pool
        .query(`UPDATE users SET plan_source='other' WHERE id=$1`, [id])
        .then(() => null, (e: { code?: string; constraint?: string }) => e);
      expect(err?.code).toBe('23514');
      expect(err?.constraint).toBe('users_plan_source_check');
    });

    it('marks users who redeemed an invite code as plan_source invite, others stay admin, and a re-run is stable', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji konto, które użyło kodu zaproszenia, ma źródło planu "invite", pozostałe "admin"; ponowne uruchomienie nic nie psuje.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const invited = await insertUser('invited-user');
      const plain = await insertUser('plain-user');
      const bought = await insertUser('bought-user');
      const { rows: p } = await pool.query<{ id: number }>(`SELECT id FROM plans ORDER BY id LIMIT 1`);
      await pool.query(
        `INSERT INTO invite_codes (code, plan_id, used_at, used_by) VALUES ('ABCD1234', $1, now(), $2)`,
        [p[0].id, invited],
      );
      await pool.query(`UPDATE users SET plan_source='subscription' WHERE id=$1`, [bought]);
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0021_payment_subscriptions');
      const { rows } = await pool.query(`SELECT id, plan_source FROM users WHERE id = ANY($1) ORDER BY id`, [[invited, plain, bought]]);
      expect(rows).toEqual([
        { id: invited, plan_source: 'invite' },
        { id: plain, plan_source: 'admin' },
        { id: bought, plan_source: 'subscription' },
      ]);
    });

    it('deleting a user removes their customer and subscriptions (CASCADE)', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Usunięcie konta kasuje jego klienta płatności i subskrypcje.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const id = await insertUser('cascade-user');
      await pool.query(`INSERT INTO payment_customers (user_id, provider_customer_id) VALUES ($1, 'cus_test_1')`, [id]);
      await pool.query(
        `INSERT INTO subscriptions (user_id, provider_subscription_id, status) VALUES ($1, 'sub_test_1', 'active')`,
        [id],
      );
      await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
      expect((await pool.query(`SELECT 1 FROM payment_customers`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM subscriptions`)).rowCount).toBe(0);
    });
  });

  describe('0022_admin_lock_plan_override', () => {
    const insertUser = async (uuid: string, extra = ''): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`,
        [uuid, `${uuid}@example.test`],
      );
      if (extra) await pool.query(`UPDATE users SET ${extra} WHERE id=$1`, [rows[0].id]);
      return rows[0].id;
    };

    it('adds the admin lock, the plan override, the scheduled change and the run ledger', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji konto ma osobną blokadę administratora i znacznik override planu, subskrypcja — zaplanowaną zmianę, a baza — tabelę przebiegów rekoncyliacji z licznikiem odwołanych obniżeń.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const col = async (table: string, name: string) => (await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
        [SCRATCH_SCHEMA, table, name],
      )).rows[0];
      const tz = { data_type: 'timestamp with time zone', is_nullable: 'YES' };
      expect(await col('users', 'admin_locked_at')).toEqual(tz);
      expect(await col('users', 'plan_override_at')).toEqual(tz);
      expect(await col('subscriptions', 'scheduled_change_at')).toEqual(tz);
      expect(await col('subscriptions', 'scheduled_price_lookup_key')).toEqual({ data_type: 'text', is_nullable: 'YES' });
      const { rows } = await pool.query(
        `INSERT INTO payment_reconcile_runs DEFAULT VALUES
         RETURNING checked, drifted, failed, overrides_expired, downgrades_cancelled, truncated, finished_at`,
      );
      expect(rows[0]).toEqual({ checked: 0, drifted: 0, failed: 0, overrides_expired: 0, downgrades_cancelled: 0, truncated: false, finished_at: null });
    });

    it('copies admin locks into admin_locked_at and leaves access_locked_at in place for old pods', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Dzisiejsze blokady admina trafiają też do nowej kolumny, a stara zostaje — stare pody w trakcie wdrożenia dalej widzą konto jako zablokowane; konto z subskrypcji bez żywej subskrypcji, a także konto z przyznanym planem, któremu minęła data, ma tylko blokadę „bez planu” — zapłata ją zdejmie.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const at = `'2026-10-10T10:00:00Z'`;
      const unpaid = await insertUser('carry-unpaid', `plan_source='subscription', access_locked_at=${at}`);
      const ended = await insertUser('carry-ended', `plan_source='subscription', access_locked_at=${at}`);
      const paying = await insertUser('carry-paying', `plan_source='subscription', access_locked_at=${at}`);
      const legacy = await insertUser('carry-legacy', `plan_source='admin', access_locked_at=${at}`);
      const invited = await insertUser('carry-invite', `plan_source='invite', access_locked_at=${at}`);
      const free = await insertUser('carry-free', `plan_source='admin'`);
      // A grant whose date has passed with nothing live is a plan-rule lock (decideEntitlement's `ended`), not an admin lock.
      const lapsedAdmin = await insertUser('carry-lapsed-admin', `plan_source='admin', plan_expires_at=now() - interval '1 day', access_locked_at=${at}`);
      const lapsedInvite = await insertUser('carry-lapsed-invite', `plan_source='invite', plan_expires_at=now() - interval '1 day', access_locked_at=${at}`);
      const lapsedPaying = await insertUser('carry-lapsed-paying', `plan_source='admin', plan_expires_at=now() - interval '1 day', access_locked_at=${at}`);
      const grantRunning = await insertUser('carry-grant-running', `plan_source='admin', plan_expires_at=now() + interval '30 days', access_locked_at=${at}`);
      await pool.query(
        `INSERT INTO subscriptions (user_id, provider_subscription_id, status) VALUES ($1,'sub_e','canceled'), ($2,'sub_p','active'), ($3,'sub_lp','past_due')`,
        [ended, paying, lapsedPaying],
      );
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0022_admin_lock_plan_override');
      const { rows } = await pool.query(
        `SELECT id, access_locked_at IS NOT NULL AS plan_lock, admin_locked_at IS NOT NULL AS admin_lock,
                (admin_locked_at IS NULL OR admin_locked_at = ${at}::timestamptz) AS kept_time
           FROM users WHERE id = ANY($1) ORDER BY id`,
        [[unpaid, ended, paying, legacy, invited, free, lapsedAdmin, lapsedInvite, lapsedPaying, grantRunning]],
      );
      expect(rows).toEqual([
        { id: unpaid, plan_lock: true, admin_lock: false, kept_time: true },
        { id: ended, plan_lock: true, admin_lock: false, kept_time: true },
        { id: paying, plan_lock: true, admin_lock: true, kept_time: true },
        { id: legacy, plan_lock: true, admin_lock: true, kept_time: true },
        { id: invited, plan_lock: true, admin_lock: true, kept_time: true },
        { id: free, plan_lock: false, admin_lock: false, kept_time: true },
        { id: lapsedAdmin, plan_lock: true, admin_lock: false, kept_time: true },
        { id: lapsedInvite, plan_lock: true, admin_lock: false, kept_time: true },
        { id: lapsedPaying, plan_lock: true, admin_lock: true, kept_time: true },
        { id: grantRunning, plan_lock: true, admin_lock: true, kept_time: true },
      ]);
      // A second run on the copied data changes nothing.
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0022_admin_lock_plan_override');
      const again = await pool.query(`SELECT count(*)::int AS n FROM users WHERE admin_locked_at IS NOT NULL`);
      expect(again.rows[0].n).toBe(5);
    });

    it('existing admin-sourced plans do not become overrides', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Migracja nie zamienia dotychczasowych planów „od admina” ani „z zaproszenia” w override — obecni użytkownicy będą płacić po okresie darmowym (decyzja D1).');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      // Accounts exist BEFORE the migration file runs, so the assertion is about what 0022 does to them.
      const { rows: p } = await pool.query<{ id: number }>(`SELECT id FROM plans WHERE price_lookup_key='plus_monthly'`);
      await insertUser('legacy-admin-plan', `plan_source='admin', plan_id=${p[0].id}`);
      await insertUser('legacy-invite-plan', `plan_source='invite', plan_id=${p[0].id}`);
      await insertUser('legacy-admin-locked', `plan_source='admin', access_locked_at=now()`);
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0022_admin_lock_plan_override');
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM users WHERE uuid LIKE 'legacy-%' AND plan_override_at IS NOT NULL`,
      );
      expect(rows[0].n).toBe(0);
    });
  });

  // The invite-code store itself is Cloud code: server/cloud/db.billing.test.ts.
  describe('0024_invite_expiry', () => {
    const insertCode = async (code: string, extra = ''): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO invite_codes (code, plan_id) VALUES ($1, (SELECT id FROM plans WHERE name='Basic')) RETURNING id`, [code]);
      if (extra) await pool.query(`UPDATE invite_codes SET ${extra} WHERE id=$1`, [rows[0].id]);
      return rows[0].id;
    };

    it('adds a redemption deadline and a plan length to invite codes; existing codes keep no limit', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji kod zaproszenia ma termin użycia i długość planu w dniach; stare kody mają oba pola puste, czyli bez limitu. Długość planu musi być dodatnia, a przebieg rekoncyliacji liczy wygasłe przyznane plany.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const col = async (table: string, name: string) => (await pool.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
        [SCRATCH_SCHEMA, table, name],
      )).rows[0];
      expect(await col('invite_codes', 'expires_at')).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null });
      expect(await col('invite_codes', 'plan_duration_days')).toEqual({ data_type: 'integer', is_nullable: 'YES', column_default: null });
      expect(await col('payment_reconcile_runs', 'grants_expired')).toEqual({ data_type: 'integer', is_nullable: 'NO', column_default: '0' });
      const id = await insertCode('OLDCODE1');
      expect((await pool.query(`SELECT expires_at, plan_duration_days FROM invite_codes WHERE id=$1`, [id])).rows[0])
        .toEqual({ expires_at: null, plan_duration_days: null });
      for (const bad of [0, -1]) {
        await expect(pool.query(`UPDATE invite_codes SET plan_duration_days=$1 WHERE id=$2`, [bad, id]))
          .rejects.toMatchObject({ code: '23514', constraint: 'invite_codes_plan_duration_days_check' });
      }
    });
  });

  describe('0025_content_deletion', () => {
    const insertUser = async (uuid: string): Promise<number> =>
      (await pool.query<{ id: number }>(`INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`, [uuid, `${uuid}@example.test`])).rows[0].id;

    it('adds the deletion schedule, the run ledger and the notice ledger', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji baza ma harmonogram usunięcia nagrań per konto, tabelę przebiegów joba i rejestr wysłanych ostrzeżeń; usunięcie konta sprząta jego wiersze.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const id = await insertUser('cd-tables');
      await pool.query(
        `INSERT INTO content_deletions (user_id, lock_started_at, delete_after) VALUES ($1, '2026-10-01T10:00:00Z', '2026-10-09T00:00:00Z')`, [id]);
      const { rows: d } = await pool.query(
        `SELECT held_at, started_at, finished_at, objects_removed, rows_removed FROM content_deletions WHERE user_id=$1`, [id]);
      expect(d[0]).toEqual({ held_at: null, started_at: null, finished_at: null, objects_removed: 0, rows_removed: 0 });
      const { rows: r } = await pool.query(
        `INSERT INTO content_deletion_runs (mode) VALUES ('dry-run')
         RETURNING candidates, first_notices, final_notices, due, deleted, resumed, held, skipped, failed, deferred, truncated, finished_at`);
      expect(r[0]).toEqual({ candidates: 0, first_notices: 0, final_notices: 0, due: 0, deleted: 0, resumed: 0, held: 0, skipped: 0, failed: 0, deferred: 0, truncated: false, finished_at: null });
      await pool.query(`INSERT INTO account_notices (user_id, kind, ref_at) VALUES ($1, 'content_deletion_first', '2026-10-01T10:00:00Z')`, [id]);
      // Same key again: the notice ledger keeps one row per (account, kind, reference).
      await expect(pool.query(`INSERT INTO account_notices (user_id, kind, ref_at) VALUES ($1, 'content_deletion_first', '2026-10-01T10:00:00Z')`, [id]))
        .rejects.toMatchObject({ code: '23505' });
      await expect(pool.query(`INSERT INTO account_notices (user_id, kind, ref_at) VALUES ($1, 'something_else', now())`, [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'account_notices_kind_check' });
      await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
      const left = await pool.query(`SELECT (SELECT count(*) FROM content_deletions)::int AS d, (SELECT count(*) FROM account_notices)::int AS n`);
      expect(left.rows[0]).toEqual({ d: 0, n: 0 });
    });

    it('an administrator who holds a deletion can be removed without losing the hold', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Wstrzymanie usunięcia zostaje, nawet gdy konto admina, który je założył, zostanie usunięte — zostaje tylko bez autora.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const user = await insertUser('cd-held');
      const admin = await insertUser('cd-admin');
      await pool.query(
        `INSERT INTO content_deletions (user_id, lock_started_at, delete_after, held_at, held_by) VALUES ($1, now(), now() + interval '8 days', now(), $2)`, [user, admin]);
      await pool.query(`DELETE FROM users WHERE id=$1`, [admin]);
      const { rows } = await pool.query(`SELECT held_at IS NOT NULL AS held, held_by FROM content_deletions WHERE user_id=$1`, [user]);
      expect(rows[0]).toEqual({ held: true, held_by: null });
    });
  });

  describe('0026_purchase_statements', () => {
    const insertUser = async (uuid: string): Promise<number> =>
      (await pool.query<{ id: number }>(`INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`, [uuid, `${uuid}@example.test`])).rows[0].id;
    const stmt = (id: number, over: Record<string, unknown> = {}) => ({
      kind: 'purchase', version: 'purchase-b-short-2026-10', language: 'pl', text: 'Żądam…', terms: 'regulamin-2026-10-19',
      plan: 'Plus', key: 'plus_monthly', from: null, rid: null, ...over, id,
    });
    const insertStatement = (s: ReturnType<typeof stmt>) => pool.query(
      `INSERT INTO purchase_statements (user_id, kind, version, language, statement_text, terms_version, plan_name, price_lookup_key, from_price_lookup_key, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, accepted_at, confirmation_sent_at`,
      [s.id, s.kind, s.version, s.language, s.text, s.terms, s.plan, s.key, s.from, s.rid]);

    it('records a purchase statement with its version, language, text and terms version', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Po migracji baza zapisuje oświadczenie przy zakupie z wersją, językiem, dosłowną treścią i wersją Regulaminu; czas zapisuje baza, potwierdzenie e-mailem jest puste do wysłania.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const id = await insertUser('ps-basic');
      const { rows } = await insertStatement(stmt(id));
      expect(rows[0].accepted_at).toBeInstanceOf(Date);
      expect(rows[0].confirmation_sent_at).toBeNull();
      await expect(insertStatement(stmt(id, { kind: 'renewal' }))).rejects.toMatchObject({ code: '23514', constraint: 'purchase_statements_kind_check' });
      await expect(insertStatement(stmt(id, { language: 'de' }))).rejects.toMatchObject({ code: '23514', constraint: 'purchase_statements_language_check' });
    });

    it('keeps one upgrade statement per request id, any number without one', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Ponowione żądanie zmiany Planu z tym samym identyfikatorem nie tworzy drugiego oświadczenia; zakupy bez identyfikatora mogą mieć wiele wierszy.');
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const id = await insertUser('ps-rid');
      const rid = '0f8fad5b-d9cb-469f-a165-70867728950e';
      await insertStatement(stmt(id, { kind: 'upgrade', rid, from: 'basic_monthly' }));
      await expect(insertStatement(stmt(id, { kind: 'upgrade', rid, from: 'basic_monthly' }))).rejects.toMatchObject({ code: '23505' });
      await insertStatement(stmt(id));
      await insertStatement(stmt(id));
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM purchase_statements WHERE user_id=$1`, [id]);
      expect(rows[0].n).toBe(3);
    });

    it('adds the new deletion and notice columns; existing holds become administrator holds', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Harmonogram usunięcia ma nowe kolumny, a wstrzymanie założone przed migracją staje się wstrzymaniem admina z terminem 90 dni i datą z powiadomienia równą dacie usunięcia.');
      // As in the 0022 tests: migrate, write the pre-0026 state (new columns NULL), run the file again (idempotent).
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const held = await insertUser('cd-held-before');
      await pool.query(`INSERT INTO content_deletions (user_id, lock_started_at, delete_after, held_at) VALUES ($1, '2026-10-01T10:00:00Z', '2026-10-09T00:00:00Z', '2026-10-02T08:00:00Z')`, [held]);
      await runMigrationFileInSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR, '0026_purchase_statements');
      const { rows: d } = await pool.query(
        `SELECT hold_reason, hold_expires_at, first_stated_at, notice_ref_at FROM content_deletions WHERE user_id=$1`, [held]);
      expect(d[0]).toEqual({
        hold_reason: 'admin', hold_expires_at: new Date('2026-12-31T08:00:00Z'),
        first_stated_at: new Date('2026-10-09T00:00:00Z'), notice_ref_at: null,
      });
      const { rows: n } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='account_notices' AND column_name='provider_message_id'`, [SCRATCH_SCHEMA]);
      expect(n).toHaveLength(1);
      const { rows: r } = await pool.query(`INSERT INTO content_deletion_runs (mode) VALUES ('on') RETURNING renotices, holds_released`);
      expect(r[0]).toEqual({ renotices: 0, holds_released: 0 });
      await expect(pool.query(`UPDATE content_deletions SET hold_reason='later' WHERE user_id=$1`, [held]))
        .rejects.toMatchObject({ code: '23514', constraint: 'content_deletions_hold_reason_check' });
    });
  });

  describe('account locks', () => {
    const setup = async () => {
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const { __setPoolForTest } = await import('./db/index.js');
      __setPoolForTest(pool);
      return import('./db/queries/access.js');
    };
    const insertUser = async (uuid: string): Promise<number> =>
      (await pool.query<{ id: number }>(`INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`, [uuid, `${uuid}@example.test`])).rows[0].id;

    it('either lock locks the account and each one is lifted only by its own setter', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Konto jest zablokowane, gdy ma blokadę administratora albo blokadę bez planu; zdjęcie jednej nie zdejmuje drugiej.');
      const a = await setup();
      const id = await insertUser('two-locks');
      expect(await a.getAccessLockState(id)).toEqual({ locked: false, adminLocked: false, planLocked: false });
      await a.setAdminLocked(id, true);
      expect(await a.isAccessLocked(id)).toBe(true);
      await a.setAccessLocked(id, true);
      await a.setAccessLocked(id, false);           // e.g. a payment
      expect(await a.getAccessLockState(id)).toEqual({ locked: true, adminLocked: true, planLocked: false });
      await a.setAccessLocked(id, true);
      await a.setAdminLocked(id, false);            // the administrator
      expect(await a.getAccessLockState(id)).toEqual({ locked: true, adminLocked: false, planLocked: true });
      await a.setAccessLocked(id, false);
      expect(await a.isAccessLocked(id)).toBe(false);
      expect(await a.getAccessLockState(999_999)).toEqual({ locked: false, adminLocked: false, planLocked: false });
    });

    it('locking again keeps the original lock time', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Ponowne zablokowanie przez administratora nie przesuwa daty blokady.');
      const a = await setup();
      const id = await insertUser('admin-lock-time');
      await pool.query(`UPDATE users SET admin_locked_at='2026-10-01T00:00:00Z' WHERE id=$1`, [id]);
      await a.setAdminLocked(id, true);
      const { rows } = await pool.query(`SELECT admin_locked_at = '2026-10-01T00:00:00Z'::timestamptz AS same FROM users WHERE id=$1`, [id]);
      expect(rows[0].same).toBe(true);
    });

    it('the admin user list tells the two locks apart', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Lista użytkowników w panelu pokazuje, która blokada jest założona, i czy plan jest override’em administratora.');
      const a = await setup();
      const id = await insertUser('list-locks');
      await a.setAdminLocked(id, true);
      await pool.query(`UPDATE users SET plan_override_at='2026-10-19T10:00:00Z' WHERE id=$1`, [id]);
      const { getAllUsers } = await import('./db/queries/users.js');
      const row = (await getAllUsers()).find((u) => u.id === 'list-locks')!;
      expect(row).toMatchObject({ accessLocked: true, adminLocked: true, planLocked: false, planOverrideAt: '2026-10-19T10:00:00.000Z' });
    });
  });

  describe('content wipe', () => {
    const setup = async () => {
      await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
      const { __setPoolForTest } = await import('./db/index.js');
      __setPoolForTest(pool);
      return import('./services/contentWipe.js');
    };
    const insertUser = async (uuid: string): Promise<number> =>
      (await pool.query<{ id: number }>(`INSERT INTO users (uuid, email, disk_usage_bytes) VALUES ($1, $2, 999) RETURNING id`, [uuid, `${uuid}@example.test`])).rows[0].id;
    const addFile = (owner: number, key: string, size: number, at: string) => pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, uploaded_at) VALUES ($1,'recordings',$2,$2,$3,$4)`,
      [owner, key, size, at]);
    const addEvent = (owner: number, id: string, at: string | null) => pool.query(
      `INSERT INTO events (id, camera, timestamp, date, owner_id, created_at) VALUES ($1,'cam','20261001000000','2026-10-01',$2,$3)`, [id, owner, at]);
    const addView = (eventId: string, view: string, relPath: string) => pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1,$2,$3)`, [eventId, view, relPath]);
    const CUTOFF = new Date('2026-10-20T06:10:00Z');

    it('removes rows from before the cutoff, keeps newer ones and recomputes the usage', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Usunięcie nagrań kasuje pliki sprzed punktu bez powrotu i zdarzenia bez żadnego zachowanego pliku, a plik wgrany po opłaceniu zostaje razem ze swoim zdarzeniem i zajętością, która odpowiada temu, co zostało. Cudze konto jest nietknięte.');
      const w = await setup();
      const id = await insertUser('wipe-me');
      const other = await insertUser('wipe-other');
      await addFile(id, 'wipe-me/old.mp4', 100, '2026-10-01T00:00:00Z');
      await addFile(id, 'wipe-me/new.mp4', 40, '2026-10-20T07:00:00Z');
      await addFile(other, 'wipe-other/a.mp4', 7, '2026-10-01T00:00:00Z');
      await addEvent(id, 'ev-old', '2026-10-01T00:00:00Z'); await addView('ev-old', '00', 'old.mp4');
      await addEvent(id, 'ev-legacy', null);
      await addEvent(id, 'ev-new', '2026-10-20T07:00:00Z'); await addView('ev-new', '00', 'new.mp4');
      await addEvent(id, 'ev-processing', '2026-10-20T07:05:00Z'); // no view yet: kept
      const seen: Array<{ bucket: string; prefix: string; modifiedBefore: Date }> = [];
      const r = await w.wipeRecordingsBefore({ id, uuid: 'wipe-me' }, CUTOFF, {
        deleteObjects: async (bucket, prefix, opts) => { seen.push({ bucket, prefix, modifiedBefore: opts.modifiedBefore }); return { deleted: 2, complete: true }; },
      });
      expect(r).toEqual({ objectsRemoved: 6, rowsRemoved: 3, complete: true });
      expect(seen).toHaveLength(3);
      expect(seen.every((s) => s.prefix === 'wipe-me/')).toBe(true);
      // Objects are compared with a 10-minute margin before the cutoff (object store vs database clock).
      expect(seen[0].modifiedBefore).toEqual(new Date(CUTOFF.getTime() - w.OBJECT_CLOCK_MARGIN_MS));
      const left = await pool.query(`SELECT s3_key FROM file_metadata WHERE owner_id=$1`, [id]);
      expect(left.rows).toEqual([{ s3_key: 'wipe-me/new.mp4' }]);
      const ev = await pool.query(`SELECT id FROM events WHERE owner_id=$1 ORDER BY id`, [id]);
      expect(ev.rows).toEqual([{ id: 'ev-new' }, { id: 'ev-processing' }]);
      const u = await pool.query(`SELECT disk_usage_bytes FROM users WHERE id=$1`, [id]);
      expect(Number(u.rows[0].disk_usage_bytes)).toBe(40);
      expect((await pool.query(`SELECT count(*)::int n FROM file_metadata WHERE owner_id=$1`, [other])).rows[0].n).toBe(1);
    });

    it('an event re-created after the cutoff for old files goes; an old event that got a new file stays', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Wiersz zdarzenia zapisany po punkcie bez powrotu, ale wskazujący tylko stare (usuwane) pliki, nie zostaje „duchem” z miniaturą do skasowanego obiektu; stare zdarzenie, do którego po zapłacie dołączył nowy widok, zostaje.');
      const w = await setup();
      const id = await insertUser('wipe-ghost');
      await addFile(id, 'wipe-ghost/old.mp4', 10, '2026-10-01T00:00:00Z');
      await addFile(id, 'wipe-ghost/zoom-new.mp4', 5, '2026-10-20T07:00:00Z');
      await addEvent(id, 'ev-ghost', '2026-10-20T08:00:00Z'); await addView('ev-ghost', '00', 'old.mp4');
      await addEvent(id, 'ev-merged', '2026-10-01T00:00:00Z');
      await addView('ev-merged', '00', 'old.mp4'); await addView('ev-merged', '01', 'zoom-new.mp4');
      await w.wipeRecordingsBefore({ id, uuid: 'wipe-ghost' }, CUTOFF, { deleteObjects: async () => ({ deleted: 0, complete: true }) });
      const ev = await pool.query(`SELECT id FROM events WHERE owner_id=$1`, [id]);
      expect(ev.rows).toEqual([{ id: 'ev-merged' }]);
    });

    it('an interrupted object delete reports itself unfinished and a second call finishes it', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Gdy budżet czasu kończy się w trakcie kasowania obiektów, wynik mówi „niedokończone”; drugie wywołanie z tą samą chwilą odcięcia kończy pracę bez błędów.');
      const w = await setup();
      const id = await insertUser('wipe-twice');
      await addFile(id, 'wipe-twice/a.mp4', 10, '2026-10-01T00:00:00Z');
      const first = await w.wipeRecordingsBefore({ id, uuid: 'wipe-twice' }, CUTOFF, {
        deleteObjects: async () => ({ deleted: 1, complete: false }),
      });
      expect(first.complete).toBe(false);
      const second = await w.wipeRecordingsBefore({ id, uuid: 'wipe-twice' }, CUTOFF, {
        deleteObjects: async () => ({ deleted: 0, complete: true }),
      });
      expect(second).toEqual({ objectsRemoved: 0, rowsRemoved: 0, complete: true });
    });

    const holdQuotaLock = async (userId: number): Promise<{ held: boolean; release: () => Promise<void> }> => {
      const { userLockKey, LOCK_NS_QUOTA } = await import('./db/index.js');
      const other = new Pool({ connectionString: TEST_DB_URL, max: 1 });
      const client = await other.connect();
      const key = userLockKey(LOCK_NS_QUOTA, userId).toString();
      const held = !!(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS l', [key])).rows[0].l;
      return {
        held,
        release: async () => {
          if (held) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
          client.release();
          await other.end();
        },
      };
    };
    const tryQuotaLockFromOutside = async (userId: number): Promise<boolean> => {
      const h = await holdQuotaLock(userId);
      await h.release();
      return h.held;
    };
    const counts = async (owner: number) => (await pool.query<{ f: number; e: number; v: number; d: string }>(
      `SELECT (SELECT count(*)::int FROM file_metadata WHERE owner_id=$1) f,
              (SELECT count(*)::int FROM events WHERE owner_id=$1) e,
              (SELECT count(*)::int FROM event_view_files v JOIN events e ON e.id=v.event_id WHERE e.owner_id=$1) v,
              (SELECT disk_usage_bytes::text FROM users WHERE id=$1) d`, [owner])).rows[0];

    it('another account is untouched, and its file with the same relative path keeps nothing alive here', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Usunięcie dotyczy wyłącznie jednego konta: zdarzenia, pliki i zajętość innego konta zostają bez zmian, a jego plik o tej samej ścieżce względnej nie ratuje zdarzenia usuwanego konta.');
      const w = await setup();
      const id = await insertUser('wipe-own');
      const other = await insertUser('wipe-oth');
      await addFile(id, 'wipe-own/same.mp4', 10, '2026-10-01T00:00:00Z');
      await addEvent(id, 'ev-own', '2026-10-01T00:00:00Z'); await addView('ev-own', '00', 'same.mp4');
      await addFile(other, 'wipe-oth/same.mp4', 7, '2026-10-20T07:00:00Z');
      await addFile(other, 'wipe-oth/old.mp4', 3, '2026-10-01T00:00:00Z');
      await addEvent(other, 'ev-oth', '2026-10-01T00:00:00Z'); await addView('ev-oth', '00', 'old.mp4');
      const before = await counts(other);
      await w.wipeRecordingsBefore({ id, uuid: 'wipe-own' }, CUTOFF, { deleteObjects: async () => ({ deleted: 0, complete: true }) });
      expect((await pool.query(`SELECT id FROM events WHERE owner_id=$1`, [id])).rows).toEqual([]);
      expect(await counts(other)).toEqual(before);
      expect(before).toEqual({ f: 2, e: 1, v: 1, d: '999' });
    });

    it('a surviving merged event loses the view of the deleted file and its old thumbnail', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Stare zdarzenie, do którego po zapłacie dołączył nowy widok, zostaje bez widoku wskazującego usunięty plik i bez miniatury sprzed punktu bez powrotu (jej obiekt jest kasowany) — miniatura powstaje na nowo z zachowanego widoku, tak jak przy evictFile.');
      const w = await setup();
      const id = await insertUser('wipe-merge');
      await addFile(id, 'wipe-merge/old.mp4', 10, '2026-10-01T00:00:00Z');
      await addFile(id, 'wipe-merge/zoom-new.mp4', 5, '2026-10-20T07:00:00Z');
      await addEvent(id, 'ev-merged', '2026-10-01T00:00:00Z');
      await addView('ev-merged', '00', 'old.mp4'); await addView('ev-merged', '01', 'zoom-new.mp4');
      await pool.query(`UPDATE events SET thumbnail='__generated__/ev-merged.jpg', thumbnail_attempts=1, playback_ready=true WHERE id='ev-merged'`);
      await addEvent(id, 'ev-tomb', '2026-10-01T00:00:00Z');
      await addView('ev-tomb', '00', 'old.mp4'); await addView('ev-tomb', '01', 'zoom-new.mp4');
      await pool.query(`UPDATE events SET thumbnail='__unplayable__', thumbnail_attempts=5 WHERE id='ev-tomb'`);
      await w.wipeRecordingsBefore({ id, uuid: 'wipe-merge' }, CUTOFF, { deleteObjects: async () => ({ deleted: 0, complete: true }) });
      const views = await pool.query(`SELECT event_id, view_id FROM event_view_files ORDER BY event_id`);
      expect(views.rows).toEqual([{ event_id: 'ev-merged', view_id: '01' }, { event_id: 'ev-tomb', view_id: '01' }]);
      const ev = await pool.query(`SELECT id, thumbnail, thumbnail_attempts, playback_ready FROM events ORDER BY id`);
      expect(ev.rows).toEqual([
        { id: 'ev-merged', thumbnail: null, thumbnail_attempts: 0, playback_ready: false },
        { id: 'ev-tomb', thumbnail: '__unplayable__', thumbnail_attempts: 5, playback_ready: false },
      ]);
    });

    it('stops at the first unfinished bucket and does not touch the others', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Gdy kasowanie w pierwszym buckecie się nie skończy (budżet czasu), pozostałe buckety nie są ruszane w tym przebiegu — następny zaczyna od nowa z tą samą chwilą odcięcia.');
      const w = await setup();
      const id = await insertUser('wipe-stop');
      const buckets: string[] = [];
      const r = await w.wipeRecordingsBefore({ id, uuid: 'wipe-stop' }, CUTOFF, {
        deleteObjects: async (bucket) => { buckets.push(bucket); return { deleted: 3, complete: false }; },
      });
      expect(r).toEqual({ objectsRemoved: 3, rowsRemoved: 0, complete: false });
      expect(buckets).toHaveLength(1);
    });

    it('an object delete that throws propagates after the rows are gone, and a later call finishes', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Błąd magazynu w trakcie kasowania obiektów przerywa wywołanie wyjątkiem (nie „zakończone”); wiersze są już usunięte, a następne wywołanie z tą samą chwilą odcięcia dokańcza obiekty.');
      const w = await setup();
      const id = await insertUser('wipe-throw');
      await addFile(id, 'wipe-throw/a.mp4', 10, '2026-10-01T00:00:00Z');
      let calls = 0;
      const thrown = await w.wipeRecordingsBefore({ id, uuid: 'wipe-throw' }, CUTOFF, {
        deleteObjects: async () => { if (++calls === 2) throw new Error('s3 down'); return { deleted: 1, complete: true }; },
      }).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('s3 down');
      // What the call removed before the throw travels with the error.
      expect(w.wipeProgressOf(thrown)).toEqual({ objectsRemoved: 1, rowsRemoved: 1 });
      expect(w.wipeProgressOf(new Error('other'))).toBeNull();
      expect(calls).toBe(2);
      expect(await counts(id)).toEqual({ f: 0, e: 0, v: 0, d: '0' });
      const again = await w.wipeRecordingsBefore({ id, uuid: 'wipe-throw' }, CUTOFF, { deleteObjects: async () => ({ deleted: 1, complete: true }) });
      expect(again).toEqual({ objectsRemoved: 3, rowsRemoved: 0, complete: true });
      // The lock is released after a throw.
      expect(await tryQuotaLockFromOutside(id)).toBe(true);
    });

    it('does nothing while another process holds the account lock, and holds it through the object phase', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Usuwanie trzyma tę samą blokadę konta co reconciler magazynu, przez całą pracę na bazie i w S3 — reconciler nie odtworzy w międzyczasie wierszy z obiektów, których usuwanie jeszcze nie dosięgło. Gdy blokadę trzyma ktoś inny, nic nie jest usuwane, a wynik mówi „niedokończone”.');
      const w = await setup();
      const id = await insertUser('wipe-lock');
      await addFile(id, 'wipe-lock/a.mp4', 10, '2026-10-01T00:00:00Z');
      const h = await holdQuotaLock(id);
      expect(h.held).toBe(true);
      const called: string[] = [];
      try {
        const busy = await w.wipeRecordingsBefore({ id, uuid: 'wipe-lock' }, CUTOFF, {
          deleteObjects: async (b) => { called.push(b); return { deleted: 0, complete: true }; },
        });
        expect(busy).toEqual({ objectsRemoved: 0, rowsRemoved: 0, complete: false });
      } finally {
        await h.release();
      }
      expect(called).toEqual([]);
      expect(await counts(id)).toEqual({ f: 1, e: 0, v: 0, d: '999' });
      const heldDuringObjects: boolean[] = [];
      const r = await w.wipeRecordingsBefore({ id, uuid: 'wipe-lock' }, CUTOFF, {
        deleteObjects: async () => { heldDuringObjects.push(!(await tryQuotaLockFromOutside(id))); return { deleted: 0, complete: true }; },
      });
      expect(r.complete).toBe(true);
      expect(heldDuringObjects).toEqual([true, true, true]);
      expect(await tryQuotaLockFromOutside(id)).toBe(true);
    });

    it('refuses a uuid that is not the account\'s, or not one path segment, before deleting anything', { timeout: 60_000 }, async (ctx) => {
      story(ctx, 'Identyfikator konta podany przez wywołującego jest sprawdzany z wierszem konta i kształtem prefiksu przed pierwszym DELETE — pomyłka nie skasuje zdarzeń tego konta ani nagrań innego.');
      const w = await setup();
      const { UnsafePrefixError } = await import('./services/s3.js');
      const id = await insertUser('wipe-real');
      await insertUser('wipe-victim');
      const empty = await insertUser('');
      const slash = await insertUser('a/b');
      for (const [owner, uuid, err] of [
        [id, 'wipe-victim', /does not belong/],
        [id, 'wipe-rea', /does not belong/],
        [empty, '', UnsafePrefixError],
        [slash, 'a/b', UnsafePrefixError],
      ] as const) {
        await addFile(owner, `${uuid || 'x'}/old.mp4`, 10, '2026-10-01T00:00:00Z');
        await addEvent(owner, `ev-${owner}-${uuid}`, '2026-10-01T00:00:00Z');
        await addView(`ev-${owner}-${uuid}`, '00', 'old.mp4');
        const before = await counts(owner);
        const called: string[] = [];
        const p = w.wipeRecordingsBefore({ id: owner, uuid }, CUTOFF, {
          deleteObjects: async (_b, prefix) => { called.push(prefix); return { deleted: 0, complete: true }; },
        });
        if (err instanceof RegExp) await expect(p, uuid).rejects.toThrow(err);
        else await expect(p, uuid).rejects.toBeInstanceOf(err);
        expect(called, uuid).toEqual([]);
        expect(await counts(owner), uuid).toEqual(before);
      }
    });
  });
});
