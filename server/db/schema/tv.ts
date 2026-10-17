import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// tv_device_codes — OAuth 2.0 "device authorization grant" for the Apple TV app
//
// The TV calls POST /tv/device/code, gets a short `user_code` (shown on screen)
// + a long opaque `device_code` (the TV's polling secret). The user signs in on
// the web app's /tv page and enters the `user_code`, which flips the row
// to `approved` and stamps `user_id`. The TV polls POST /tv/device/token with
// the `device_code`; once approved it mints a normal access+refresh pair and
// the row is marked `used` (single-use). Codes live 5 minutes (`expires_at`).
// `user_id` is nullable because the row exists before anyone approves it.
// ---------------------------------------------------------------------------
export const tvDeviceCodes = pgTable(
  'tv_device_codes',
  {
    id: serial('id').primaryKey(),
    // Canonical (un-dashed, upper-case) human-entered code, e.g. 'K7QF3M9P'.
    userCode: text('user_code').notNull().unique(),
    // Long opaque secret the TV polls with.
    deviceCode: text('device_code').notNull().unique(),
    // Set when the user approves the code; null while still pending.
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // 'pending' | 'approved' | 'denied' | 'used'
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Stable per-device identifier the TV sends (identifierForVendor). When the
    // TV asks for a NEW code, any earlier still-pending rows for the same device
    // are invalidated, so a superseded code can no longer be approved. Nullable:
    // older app versions (and the row's pre-binding history) may not carry one.
    deviceId: text('device_id'),
  },
  (table) => ({
    // The TV polls by device_code; the unique constraint already indexes it,
    // but an explicit index on expires_at speeds the cleanup sweep.
    expiresIdx: index('idx_tv_device_codes_expires').on(table.expiresAt),
  }),
);

export type TvDeviceCode = typeof tvDeviceCodes.$inferSelect;
export type NewTvDeviceCode = typeof tvDeviceCodes.$inferInsert;
