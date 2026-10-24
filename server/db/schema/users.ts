import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom types
// ---------------------------------------------------------------------------

/**
 * Case-insensitive text. Requires the citext extension (`CREATE EXTENSION
 * IF NOT EXISTS citext`). Declared here and re-exported so other domain files
 * import from `./users` rather than re-declaring.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Postgres BYTEA, surfaced as Buffer in Node.js.
 * Drizzle 0.45 has no built-in bytea helper; this custom type produces the
 * correct DDL and round-trips Buffer values through the pg driver.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------
export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  diskSpaceBytes: bigint('disk_space_bytes', { mode: 'number' }).notNull(),
  monthlyTransferBytes: bigint('monthly_transfer_bytes', { mode: 'number' }).notNull(),
  // Catalog metadata: listed publicly, display order, the price a customer
  // pays (tax included, minor units) and the payment provider's price key.
  isPublic: boolean('is_public').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  monthlyPriceCents: integer('monthly_price_cents'),
  currency: text('currency').notNull().default('EUR'),
  priceLookupKey: text('price_lookup_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  priceLookupKeyUnique: uniqueIndex('plans_price_lookup_key_unique')
    .on(table.priceLookupKey)
    .where(sql`${table.priceLookupKey} IS NOT NULL`),
  // Sold (price and key) or granted by hand only (neither); public => sold.
  pricePairCheck: check(
    'plans_price_pair_check',
    sql`(${table.monthlyPriceCents} IS NULL) = (${table.priceLookupKey} IS NULL)`,
  ),
  publicNeedsPriceCheck: check(
    'plans_public_needs_price_check',
    sql`NOT ${table.isPublic} OR ${table.priceLookupKey} IS NOT NULL`,
  ),
}));

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    // SERIAL PRIMARY KEY — integer auto-increment, NOT a uuid text column
    id: serial('id').primaryKey(),
    uuid: text('uuid').notNull().unique(),
    email: citext('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    isAdmin: boolean('is_admin').notNull().default(false),
    // onDelete intentionally absent — plans are never deleted in normal operation;
    // if a plan is removed, the DB will RESTRICT to prevent silently orphaning users.
    planId: integer('plan_id').references(() => plans.id),
    encryptionSalt: text('encryption_salt'),
    diskUsageBytes: bigint('disk_usage_bytes', { mode: 'number' }).notNull().default(0),
    transferUsageBytes: bigint('transfer_usage_bytes', { mode: 'number' }).notNull().default(0),
    transferResetAt: timestamp('transfer_reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Self-referential FK — intentionally kept as bare integer to avoid
    // circular reference; FK is enforced at DB level via the DDL migration.
    createdBy: integer('created_by'),
    tokenGeneration: integer('token_generation').notNull().default(0),
    // Failed-login counter and lockout tier of the web sign-in (see
    // db/queries/lockout.ts) …
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockoutCount: integer('lockout_count').notNull().default(0),
    // … and of camera FTP/FTPS logins, kept apart so a camera with a stale
    // password can never lock the owner out of the web, nor the other way round.
    ftpFailedLoginAttempts: integer('ftp_failed_login_attempts').notNull().default(0),
    ftpLockoutCount: integer('ftp_lockout_count').notNull().default(0),
    active: boolean('active').notNull().default(true),
    // Phase 11 — auto-evict oldest events when nearing storage quota
    autoDeleteOldest: boolean('auto_delete_oldest').notNull().default(false),
    // Legal F1+F2 consent timestamps (nullable: pre-feature accounts have NULL)
    acceptedTermsAt: timestamp('accepted_terms_at', { withTimezone: true }),
    newsletterConsent: boolean('newsletter_consent').notNull().default(false),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    // Phase 13 — retention window in days; NULL = disabled
    autoDeleteAfterDays: integer('auto_delete_after_days'),
    // Storage-warning email throttle
    storageWarnEmailSentAt: timestamp('storage_warn_email_sent_at', { withTimezone: true }),
    // Account-level timezone (replaces per-camera timezone). New accounts start
    // on UTC until the owner picks their zone in Settings.
    timezone: text('timezone').notNull().default('UTC'),
    // Lifetime upload counter (abuse-tracking signal; never decremented)
    uploadLifetimeBytes: bigint('upload_lifetime_bytes', { mode: 'number' }).notNull().default(0),
    // Rolling 30-day upload counter. Maintained incrementally (recordUpload
    // increments, the upload_events reaper decrements as rows age out) so the
    // admin usage panel reads a column instead of aggregating the whole
    // upload_events table on every load. Tracks the SUM(bytes) of this user's
    // rows currently in upload_events, which the reaper bounds to ~30 days.
    upload30dBytes: bigint('upload_30d_bytes', { mode: 'number' }).notNull().default(0),
    // Phase 12 — async soft-delete lifecycle
    deletionStatus: text('deletion_status').notNull().default('active'),
    deletionStartedAt: timestamp('deletion_started_at', { withTimezone: true }),
    // Passkey support
    passkeyEnabled: boolean('passkey_enabled').notNull().default(false),
    ftpsPasswordHash: text('ftps_password_hash'),
    // Camera profile mode for filename-matching strategy
    cameraProfileMode: text('camera_profile_mode', {
      enum: ['auto', 'reolink', 'hikvision', 'axis', 'foscam', 'custom'],
    })
      .notNull()
      .default('auto'),
    // Locked access: the account keeps its sign-in, list and thumbnails, but
    // playback, downloads, deletes, uploads, FTP and MCP are refused. NULL =
    // full access; the value is when the lock started.
    accessLockedAt: timestamp('access_locked_at', { withTimezone: true }),
    // Locked by an administrator. Independent of access_locked_at (which the
    // plan rules set and lift): only an administrator sets or clears this one.
    adminLockedAt: timestamp('admin_locked_at', { withTimezone: true }),
    // An administrator set this plan on purpose. While set (and plan_expires_at
    // has not passed) nothing but an administrator changes the plan.
    planOverrideAt: timestamp('plan_override_at', { withTimezone: true }),
    // Where the current plan came from (admin grant, invite code, bought) and
    // when a granted plan runs out. NULL = no end.
    planSource: text('plan_source').notNull().default('admin'),
    planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  },
  (table) => ({
    deletionStatusIdx: index('idx_users_deletion_status')
      .on(table.deletionStatus)
      .where(sql`${table.deletionStatus} <> 'active'`),
    cameraProfileModeCheck: check(
      'users_camera_profile_mode_check',
      sql`${table.cameraProfileMode} IN ('auto','reolink','hikvision','axis','foscam','custom')`,
    ),
    planSourceCheck: check(
      'users_plan_source_check',
      sql`${table.planSource} IN ('admin', 'invite', 'subscription')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// email_tokens — verification + password-reset tokens (only SHA-256 hash stored)
// ---------------------------------------------------------------------------
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    kind: text('kind', { enum: ['verify', 'reset', 'delete-account'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('idx_email_tokens_user').on(table.userId),
    cleanupIdx: index('idx_email_tokens_cleanup')
      .on(table.expiresAt)
      .where(sql`${table.usedAt} IS NULL`),
    kindCheck: check(
      'email_tokens_kind_check',
      sql`${table.kind} IN ('verify','reset','delete-account')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// passkeys — WebAuthn credentials
// ---------------------------------------------------------------------------
export const passkeys = pgTable(
  'passkeys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports'),
    deviceName: text('device_name'),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('idx_passkeys_user').on(table.userId),
  }),
);

// ---------------------------------------------------------------------------
// passkey_backup_codes
// ---------------------------------------------------------------------------
export const passkeyBackupCodes = pgTable(
  'passkey_backup_codes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUnusedIdx: index('idx_passkey_backup_codes_user')
      .on(table.userId)
      .where(sql`${table.usedAt} IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type EmailToken = typeof emailTokens.$inferSelect;
export type NewEmailToken = typeof emailTokens.$inferInsert;

export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;

export type PasskeyBackupCode = typeof passkeyBackupCodes.$inferSelect;
export type NewPasskeyBackupCode = typeof passkeyBackupCodes.$inferInsert;
