import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// push_devices — one row per registered APNs/FCM device token per user
//
// `device_token` is globally UNIQUE: a physical device that re-registers under
// a different account upserts the same row onto the new user_id, so a stale
// token never fans out to two users. `last_seen_at` is bumped on every
// (re-)registration so the worker can prune long-dead tokens later if needed.
// ---------------------------------------------------------------------------
export const pushDevices = pgTable(
  'push_devices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The opaque APNs/FCM device token. UNIQUE so re-registration upserts.
    deviceToken: text('device_token').notNull().unique(),
    // 'ios' for now; 'android' reserved for the future Compose client.
    platform: text('platform').notNull(),
    // APNs delivery environment the token was minted for ('production' |
    // 'sandbox'). Recorded so a future multi-env sender can route per-token;
    // the current worker uses the server-wide APNS_ENV.
    environment: text('environment').notNull().default('production'),
    // True when the registering app advertised support for APNs loc-key/loc-args
    // localized alerts. Default false so existing (older-app) tokens keep getting
    // literal title/body — the push worker only sends loc-key to capable devices.
    supportsLocKeys: boolean('supports_loc_keys').notNull().default(false),
    // Relay-delivered devices: the id the push relay knows the device by, and
    // the device's P-256 public key (payloads are encrypted for it). The
    // server never learns the raw push token of such a device — `device_token`
    // then holds the placeholder `relay:<relay_device_id>`.
    relayDeviceId: text('relay_device_id'),
    publicKey: text('public_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Fan-out reads every live token for a user.
    userIdx: index('idx_push_devices_user').on(table.userId),
  }),
);

// ---------------------------------------------------------------------------
// push_prefs — per-user push delivery preferences (one row per user)
//
// `snooze_until` is a do-not-disturb window: when set in the future, the
// worker skips every push for that user. `categories` is a JSONB map of
// notification-kind → bool; a kind absent from the map (or true) is delivered,
// an explicit `false` suppresses that kind. Default '{}' = everything on.
// ---------------------------------------------------------------------------
export const pushPrefs = pgTable('push_prefs', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  snoozeUntil: timestamp('snooze_until', { withTimezone: true }),
  categories: jsonb('categories')
    .$type<Record<string, boolean>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type PushDevice = typeof pushDevices.$inferSelect;
export type NewPushDevice = typeof pushDevices.$inferInsert;

export type PushPref = typeof pushPrefs.$inferSelect;
export type NewPushPref = typeof pushPrefs.$inferInsert;
