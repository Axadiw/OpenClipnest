import type { Express, Request } from 'express';
import { RateLimiterRedis, RateLimiterMemory, type RateLimiterAbstract } from 'rate-limiter-flexible';
import { createClient, writeAuditLog } from '../db/queries.js';
import { getRedis } from '../../server/utils/redis.js';
import { isValidOauthRedirectUri } from '../../server/utils/oauthRedirectUri.js';
import { rateLimitBypassEnabled } from '../../server/middleware/rateLimit.js';

/**
 * RFC 7591 §3.1 — Dynamic Client Registration is open to anonymous callers.
 * Real MCP clients (Claude Desktop's `mcp-remote` bridge, Cursor's built-in
 * MCP, etc.) DCR on first connect with no prior credential — they cannot
 * authenticate before being registered. Gating DCR behind an upstream JWT
 * would mean every user has to manually pre-register every client via the
 * Settings UI, defeating the protocol's discovery story.
 *
 * Defense-in-depth instead: per-IP rate limit (20/hour). A bad actor can
 * still register a client, but cannot brute-force unique client_ids or
 * spam-fill `oauth_clients`. The per-IP sweep CronJob plus `revoked_at`
 * timestamps let an operator clean up after abuse.
 *
 * When the request comes via the API broker (Settings → MCP Clients tab),
 * an upstream middleware sets `req.userId` and the new oauth_clients row
 * is owned by that user. Without it, `created_by_user_id` stays NULL —
 * the user lifecycle CASCADE still works (NULL just means "anonymous DCR")
 * and the Settings UI lists only owned clients (NULL filter excludes
 * them, which is correct — anonymous DCR clients should only be visible
 * to their owner, who isn't recorded).
 *
 * CLIPNEST_DISABLE_RATE_LIMIT=true (CI / e2e without Redis; refused under
 * NODE_ENV=production) swaps in an in-memory pass-through limiter — the same
 * convention as the API-side twin of this cap, server/routes/mcpClients.ts.
 */
let _dcrLimiter: RateLimiterAbstract | null = null;
function getDcrLimiter(): RateLimiterAbstract {
  if (!_dcrLimiter) {
    const opts = { keyPrefix: 'mcp-dcr', points: 20, duration: 60 * 60 /* 1 hour */ };
    _dcrLimiter = rateLimitBypassEnabled()
      ? new RateLimiterMemory({ ...opts, points: Number.MAX_SAFE_INTEGER })
      : new RateLimiterRedis({ ...opts, storeClient: getRedis() });
  }
  return _dcrLimiter;
}

export function mountRegister(app: Express): void {
  app.post('/mcp/oauth/register', async (req: Request, res) => {
    try {
      await getDcrLimiter().consume(req.ip ?? 'anon');
    } catch (e: unknown) {
      const msBefore = (e as { msBeforeNext?: number } | null)?.msBeforeNext ?? 60_000;
      res.set('Retry-After', String(Math.ceil(msBefore / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }

    const { client_name, redirect_uris, token_endpoint_auth_method, software_id, software_version } = req.body ?? {};

    if (!Array.isArray(redirect_uris)
        || redirect_uris.length === 0
        || !redirect_uris.every(isValidOauthRedirectUri)) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must be https URLs or http loopback (localhost / 127.0.0.1 / [::1])' });
    }
    if (typeof client_name !== 'string' || client_name.length === 0 || client_name.length > 200) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'client_name required (1..200 chars)' });
    }
    if (token_endpoint_auth_method !== undefined && token_endpoint_auth_method !== 'none') {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method must be "none"' });
    }

    // userId is only set when the registration comes through the API broker
    // (Settings → MCP Clients button). Anonymous mcp-remote / Claude Desktop
    // flows DCR without a JWT — that's the spec.
    const upstreamUserId = (req as { userId?: unknown }).userId;
    const userId: number | null = typeof upstreamUserId === 'number' ? upstreamUserId : null;

    const clientId = await createClient({
      clientName: client_name,
      redirectUris: redirect_uris,
      softwareId: typeof software_id === 'string' ? software_id : undefined,
      softwareVersion: typeof software_version === 'string' ? software_version : undefined,
      createdByUserId: userId,
    });

    await writeAuditLog({
      userId,
      clientId,
      action: 'dcr.register',
      detailsJson: {
        client_name,
        redirect_uris,
        software_id: software_id ?? null,
        software_version: software_version ?? null,
        anonymous: userId === null,
      },
      ip: req.ip ?? null,
    });

    res.status(201).json({
      client_id: clientId,
      client_name,
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });
}
