import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea, users } from './users.js';

// ---------------------------------------------------------------------------
// oauth_clients — registered OAuth 2.1 clients (MCP clients register here)
// ---------------------------------------------------------------------------
export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: uuid('client_id').primaryKey(),
    clientName: text('client_name').notNull(),
    redirectUris: text('redirect_uris').array().notNull(),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('idx_oauth_clients_user').on(table.createdByUserId),
  }),
);

// ---------------------------------------------------------------------------
// oauth_authorization_txns — in-flight PKCE authorization transactions
// ---------------------------------------------------------------------------
export const oauthAuthorizationTxns = pgTable(
  'oauth_authorization_txns',
  {
    txnId: uuid('txn_id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull(),
    state: text('state').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
    resource: text('resource').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeChallengeMethodCheck: check(
      'oauth_authorization_txns_code_challenge_method_check',
      sql`${table.codeChallengeMethod} = 'S256'`,
    ),
    createdAtIdx: index('idx_oauth_txns_created').on(table.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// oauth_authorization_codes — short-lived PKCE exchange codes (SHA-256 hash)
// ---------------------------------------------------------------------------
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    codeHash: bytea('code_hash').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    resource: text('resource').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    familyId: uuid('family_id').notNull(),
  },
  (table) => ({
    expiresIdx: index('idx_oauth_codes_expires').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// oauth_access_tokens — bearer tokens (SHA-256 hash stored, not raw token)
// ---------------------------------------------------------------------------
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    familyId: uuid('family_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // users.token_generation captured at grant issuance. On each authenticated
    // request the bearer path rejects when the user's current generation exceeds
    // this — a password change / passkey removal / logout revokes the grant.
    tokenGeneration: integer('token_generation').notNull().default(0),
  },
  (table) => ({
    userIdx: index('idx_oauth_access_tokens_user').on(table.userId),
    familyIdx: index('idx_oauth_access_tokens_family').on(table.familyId),
    expiresIdx: index('idx_oauth_access_tokens_expires').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// oauth_refresh_tokens — refresh tokens with rotation tracking (SHA-256 hash)
// ---------------------------------------------------------------------------
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    familyId: uuid('family_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // NULL = not yet rotated; non-NULL = the token_hash of the successor token
    rotatedTo: bytea('rotated_to'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Frozen at grant issuance and carried forward unchanged across rotations,
    // so a bump on users.token_generation revokes the whole grant family.
    tokenGeneration: integer('token_generation').notNull().default(0),
  },
  (table) => ({
    familyIdx: index('idx_oauth_refresh_tokens_family').on(table.familyId),
    expiresIdx: index('idx_oauth_refresh_tokens_expires').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type OauthClient = typeof oauthClients.$inferSelect;
export type NewOauthClient = typeof oauthClients.$inferInsert;

export type OauthAuthorizationTxn = typeof oauthAuthorizationTxns.$inferSelect;
export type NewOauthAuthorizationTxn = typeof oauthAuthorizationTxns.$inferInsert;

export type OauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type NewOauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;

export type OauthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type NewOauthAccessToken = typeof oauthAccessTokens.$inferInsert;

export type OauthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type NewOauthRefreshToken = typeof oauthRefreshTokens.$inferInsert;
