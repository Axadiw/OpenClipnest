import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { plans, users } from './users.js';

// ---------------------------------------------------------------------------
// invite_codes — preview-phase invitations that bypass the admin activation gate
//
// An admin generates a batch of codes for a given plan. Whoever redeems one
// during registration gets that plan and skips the manual approval queue —
// but NOT the email verification step: `POST /auth/login` gates on
// `users.active` alone, so a code that activated the account outright would
// let the holder sign in without ever opening the verification mail. The code
// therefore only marks the account as invited; `GET /auth/verify-email` is
// what flips `active` for it. (OAuth signup is the exception — the provider
// already asserted the address, so those accounts activate immediately.)
//
// Codes never expire. `revoked_at` is the admin's manual off-switch and is
// only allowed while the code is still unused, which keeps the `used_by` link
// to a redeemer permanent once it exists.
// ---------------------------------------------------------------------------
export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: serial('id').primaryKey(),
    // Canonical form: upper-case, no separators (e.g. '7QK4M9PT'). Input is
    // normalized before lookup, so users may type '7qk4-m9pt'.
    code: text('code').notNull().unique(),
    // Plan granted on redemption. No onDelete — a plan with codes pointing at
    // it must not vanish silently; the DB RESTRICTs instead.
    planId: integer('plan_id')
      .notNull()
      .references(() => plans.id),
    // Free-form batch label, e.g. 'friends' or 'r/reolink'.
    note: text('note'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL = still available. Stamped by the atomic claim during registration.
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    // The email-verification path asks "did this user come in via an invite?".
    usedByIdx: index('idx_invite_codes_used_by')
      .on(table.usedBy)
      .where(sql`${table.usedBy} IS NOT NULL`),
    // The admin panel's default view is "codes still handed out but unspent".
    availableIdx: index('idx_invite_codes_available')
      .on(table.planId)
      .where(sql`${table.usedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  }),
);

export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;
