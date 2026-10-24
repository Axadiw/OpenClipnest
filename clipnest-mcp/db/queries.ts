/**
 * OAuth 2.1 + MCP audit DB query helpers.
 *
 * Implementation migrated to Drizzle ORM in server/db/queries/oauth.ts.
 * This module re-exports everything so existing callers in clipnest-mcp/oauth/*
 * continue to work unchanged.
 */
export {
  createClient,
  getClient,
  revokeClient,
  insertTxn,
  getTxnById,
  claimTxn,
  insertAuthCode,
  claimAuthCodeAtomic,
  insertAccessToken,
  getAccessTokenByHash,
  revokeAccessToken,
  insertRefreshToken,
  rotateRefreshAtomic,
  revokeRefreshFamily,
  writeAuditLog,
  getRefreshTokenByHash,
  getRefreshTokenFamilyByHash,
} from '../../server/db/queries/oauth.js';

// The user's live global token_generation lives on the shared `users` table.
// The MCP bearer path reads it to reject grants whose credentials were rotated.
export { getTokenGeneration } from '../../server/db/queries/users.js';

// A locked account keeps its tokens but may not use them.
export { isAccessLocked } from '../../server/db/queries/access.js';

export type {
  CreateClientInput,
  OauthClientRow as OauthClient,
  InsertTxnInput,
  InsertAuthCodeInput,
  InsertAccessTokenInput,
  InsertRefreshTokenInput,
  AuditLogInput,
  RefreshTokenRow,
  RefreshTokenFamilyRow,
} from '../../server/db/queries/oauth.js';
