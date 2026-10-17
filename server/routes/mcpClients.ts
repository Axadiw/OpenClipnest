import { Router, type Request } from 'express';
import { RateLimiterRedis, RateLimiterMemory, type RateLimiterAbstract } from 'rate-limiter-flexible';
import {
  createClient,
  listManagedClients,
  userHasAnyTokenForClient,
  revokeUserTokensForClient,
} from '../db/queries/oauth.js';
import { getRedis } from '../utils/redis.js';
import { isValidOauthRedirectUri } from '../utils/oauthRedirectUri.js';
import { rateLimitBypassEnabled } from '../middleware/rateLimit.js';

const router = Router();

/**
 * Per-user rate limit on POST /api/v0/account/mcp-clients.
 *
 * Mirrors the 20/hour cap on the MCP-side anonymous DCR endpoint
 * (clipnest-mcp/oauth/register.ts) so an authenticated user can't bypass it
 * by going through the broker. Keyed by userId — the auth gate above is the
 * primary defense, this is defense-in-depth against an account being abused
 * to spam-fill oauth_clients.
 *
 * CLIPNEST_DISABLE_RATE_LIMIT=true swaps to an in-memory bypass-limiter, same
 * convention as server/middleware/rateLimit.ts:45. The Redis path also
 * fails open on network errors (defense-in-depth, not primary gate) — a
 * Redis outage must not 500 the whole route.
 */
let _prereg: RateLimiterAbstract | null = null;
function getMcpClientsPreregLimiter(): RateLimiterAbstract {
  if (_prereg) return _prereg;
  const opts = {
    keyPrefix: 'api-mcp-clients-prereg',
    points: 20,
    duration: 60 * 60, // 1 hour
  };
  if (rateLimitBypassEnabled()) {
    _prereg = new RateLimiterMemory({ ...opts, points: Number.MAX_SAFE_INTEGER });
  } else {
    _prereg = new RateLimiterRedis({ ...opts, storeClient: getRedis() });
  }
  return _prereg;
}

/**
 * POST /api/v0/account/mcp-clients
 *
 * Pre-register an MCP client owned by the current user. Rarely used in
 * practice — most clients (Claude Desktop, mcp-remote, Cursor) discover
 * the server and DCR anonymously. Kept for users who want to pin a
 * client_id ahead of time or build their own MCP integration with a
 * stable identity.
 */
router.post('/', async (req: Request, res) => {
  const userId = (req as any).user?.userId;
  if (typeof userId !== 'number') return res.status(401).end();

  try { await getMcpClientsPreregLimiter().consume(String(userId)); }
  catch (rejected: unknown) {
    // rate-limiter-flexible throws a RateLimiterRes on rejection. Network
    // errors arrive as plain Error — fail open in that case (matches
    // server/middleware/rateLimit.ts:81-90). Rate limiting is defense in
    // depth, not the primary auth gate.
    if (rejected instanceof Error) {
      console.error('mcp-clients prereg rate-limit Redis error:', rejected.message);
    } else {
      const ms = (rejected as { msBeforeNext?: number } | null)?.msBeforeNext ?? 3600_000;
      res.set('Retry-After', String(Math.ceil(ms / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
  }

  const { client_name, redirect_uris } = (req.body ?? {}) as { client_name?: string; redirect_uris?: string[] };
  if (typeof client_name !== 'string' || client_name.length === 0 || client_name.length > 200) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_name required (1..200 chars)' });
  }
  if (!Array.isArray(redirect_uris)
      || redirect_uris.length === 0
      || !redirect_uris.every(isValidOauthRedirectUri)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris must be https URLs or http loopback (localhost / 127.0.0.1 / [::1])' });
  }
  const clientId = await createClient({
    clientName: client_name,
    redirectUris: redirect_uris,
    createdByUserId: userId,
  });
  res.status(201).json({ client_id: clientId });
});

/**
 * GET /api/v0/account/mcp-clients
 *
 * Lists MCP clients the current user has granted access to. Membership is
 * determined by "has at least one access or refresh token (revoked or
 * not) issued to this user for this client" — NOT by oauth_clients
 * .created_by_user_id, because most real-world DCRs are anonymous
 * (Claude Desktop and friends register before they have any user
 * credential to authenticate with). The owner relationship is recorded
 * implicitly by the user_id on tokens.
 *
 * lastUsedAt is scoped to the current user's tokens for this client, so
 * two users sharing a single DCR client_id each see their own usage.
 */
router.get('/', async (req: Request, res) => {
  const userId = (req as any).user?.userId;
  if (typeof userId !== 'number') return res.status(401).end();
  const clients = await listManagedClients(userId);
  res.json({
    clients: clients.map((x) => ({
      clientId: x.clientId,
      clientName: x.clientName,
      createdAt: x.createdAt,
      revokedAt: x.revokedAt,
      lastUsedAt: x.lastUsedAt,
    })),
  });
});

/**
 * DELETE /api/v0/account/mcp-clients/:id
 *
 * Revokes the current user's tokens for the given client. Does NOT revoke
 * the oauth_clients row itself — another user might also be using this
 * client_id (rare but possible). Idempotent: returns 204 even if all
 * tokens were already revoked, as long as the user had some relationship
 * with this client.
 *
 * 404 only when the user never had any token issued for this client.
 */
router.delete('/:id', async (req: Request, res) => {
  const userId = (req as any).user?.userId;
  if (typeof userId !== 'number') return res.status(401).end();
  const clientId = String(req.params.id);

  // 1. Auth check: did this user ever get a token for this client?
  const exists = await userHasAnyTokenForClient(clientId, userId);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  // 2. Revoke this user's tokens for this client. Leaves oauth_clients
  //    alone (and other users' tokens, if any).
  await revokeUserTokensForClient(clientId, userId);
  res.status(204).end();
});

export default router;
