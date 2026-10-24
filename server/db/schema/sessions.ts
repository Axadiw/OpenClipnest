import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// user_sessions — one row per signed-in device
//
// Every sign-in (password, passkey, backup code, OAuth, TV device code) creates
// a row, and its id travels in the `sid` claim of the access and refresh tokens
// issued for it. A refresh keeps the same id, so the row lives as long as the
// device stays signed in. Signing out on one device sets `revoked_at` on its
// row: requireAuth and /auth/refresh refuse tokens of a revoked session, and
// the other devices carry on. `users.token_generation` is still the lever that
// ends every session at once (password change, ban, "sign out everywhere").
//
// `expires_at` follows the refresh token: each refresh moves it to now + the
// refresh-token lifetime. Past it the token is invalid anyway, so the oauth
// sweep deletes the row, revoked or not. The row says nothing about the device
// on purpose — no user agent, no IP.
// ---------------------------------------------------------------------------
export const userSessions = pgTable(
  'user_sessions',
  {
    // 128 random bits, base64url — the `sid` claim.
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('idx_user_sessions_user').on(table.userId),
    expiresIdx: index('idx_user_sessions_expires').on(table.expiresAt),
  }),
);

export type UserSession = typeof userSessions.$inferSelect;
