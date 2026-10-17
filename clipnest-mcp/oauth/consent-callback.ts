import type { Express, Request } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { claimTxn, getTxnById, insertAuthCode, writeAuditLog } from '../db/queries.js';
import { mintOpaqueToken, hashToken } from './accessToken.js';

const AUTH_CODE_TTL_SECONDS = 60;

export function mountConsentCallback(app: Express, internalApiKey: string): void {
  app.post('/mcp/oauth/internal/consent-callback', async (req: Request, res) => {
    // Constant-time comparison of the shared internal API key. The length
    // pre-check short-circuits when sizes differ (also avoids the
    // `timingSafeEqual` RangeError on mismatched buffer lengths) and the
    // `!internalApiKey` guard refuses to compare against an unset env var
    // (per clipnest-mcp/config.ts the default is ''). Matches the
    // server/routes/internal.ts middleware pattern.
    const provided = String(req.headers['x-internal-api-key'] ?? '');
    if (!internalApiKey
        || provided.length !== internalApiKey.length
        || !timingSafeEqual(Buffer.from(provided), Buffer.from(internalApiKey))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (req.headers['x-forwarded-host']) {
      return res.status(403).json({ error: 'internal_only' });
    }

    const { txn, userId, decision, grantedScopes } = (req.body ?? {}) as {
      txn?: string; userId?: number; decision?: string; grantedScopes?: string;
    };
    if (typeof txn !== 'string' || typeof userId !== 'number') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (decision !== 'approve' && decision !== 'deny') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'decision must be approve|deny' });
    }

    const txnRow = await getTxnById(txn);
    if (!txnRow) return res.status(404).json({ error: 'txn_not_found_or_expired' });

    if (decision === 'deny') {
      const url = new URL(txnRow.redirectUri);
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('state', txnRow.state);
      await writeAuditLog({
        userId, clientId: txnRow.clientId,
        action: 'authorize.deny', detailsJson: { txn }, ip: req.ip ?? null,
      });
      return res.json({ redirect_url: url.toString() });
    }

    if (typeof grantedScopes !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'grantedScopes required on approve' });
    }

    const requestedScopes = txnRow.scope.split(/\s+/).filter(Boolean);
    const grantedTokens = new Set(grantedScopes.split(/\s+/).filter(Boolean));
    const grantedNarrowed = requestedScopes.filter((s: string) => grantedTokens.has(s)).join(' ');
    if (grantedNarrowed.length === 0) {
      return res.status(400).json({ error: 'invalid_scope' });
    }

    const claimed = await claimTxn(txn, userId, grantedNarrowed);
    if (!claimed) return res.status(404).json({ error: 'txn_consumed_or_expired' });

    const code = mintOpaqueToken('mcp_ac_');
    const familyId = randomUUID();
    await insertAuthCode({
      codeHash: hashToken(code),
      clientId: claimed.clientId,
      userId,
      redirectUri: claimed.redirectUri,
      scope: grantedNarrowed,
      codeChallenge: claimed.codeChallenge,
      resource: claimed.resource,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
      familyId,
    });

    const url = new URL(claimed.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', claimed.state);
    await writeAuditLog({
      userId, clientId: claimed.clientId,
      action: 'authorize.approve',
      detailsJson: { txn, family: familyId, scope: grantedNarrowed },
      ip: req.ip ?? null,
    });
    res.json({ redirect_url: url.toString() });
  });
}
