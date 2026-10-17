import { integer, pgTable, serial, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { citext } from './users.js';
import { users } from './users.js';

// ---------------------------------------------------------------------------
// user_identities — OAuth provider bindings (Google / Apple sign-in)
// One row per (provider, subject) pair; a user may have multiple providers.
// ---------------------------------------------------------------------------
export const userIdentities = pgTable(
  'user_identities',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),   // 'google' | 'apple'
    subject: text('subject').notNull(),     // provider 'sub' claim
    email: citext('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => ({
    providerSubjectUniq: uniqueIndex('user_identities_provider_subject_key').on(t.provider, t.subject),
    userIdx: index('idx_user_identities_user').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;
