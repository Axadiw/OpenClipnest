import { Router, type Request } from 'express';
import { getConsentTxn } from '../db/queries/oauth.js';
import { CONFIG } from '../config.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:txn', async (req: Request, res) => {
  // txn_id is UUID-typed in Postgres — feeding it a non-UUID string throws
  // `22P02 invalid input syntax for type uuid` and bubbles to a 500. Treat
  // malformed input as just-another-unknown-txn so consumers see a single
  // 404 shape regardless of input format.
  const txn = String(req.params.txn);
  if (!UUID_RE.test(txn)) {
    return res.status(404).json({ error: 'txn_not_found_or_expired' });
  }
  const row = await getConsentTxn(txn);
  if (!row) return res.status(404).json({ error: 'txn_not_found_or_expired' });
  res.json({
    clientName: row.clientName,
    scopes: row.scope.split(/\s+/).filter(Boolean),
    redirectUri: row.redirectUri,
  });
});

router.post('/:txn', async (req: Request, res) => {
  const userId = (req as any).user?.userId;
  if (typeof userId !== 'number') return res.status(401).json({ error: 'unauthorized' });
  const { decision, scopes } = (req.body ?? {}) as { decision?: string; scopes?: string[] };
  if (decision !== 'approve' && decision !== 'deny') {
    return res.status(400).json({ error: 'invalid_decision' });
  }
  const body = decision === 'approve'
    ? { txn: req.params.txn, userId, decision, grantedScopes: (scopes ?? []).join(' ') }
    : { txn: req.params.txn, userId, decision };
  const mcpRes = await fetch(`${CONFIG.internalMcpUrl}/mcp/oauth/internal/consent-callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Key': CONFIG.internalApiKey },
    body: JSON.stringify(body),
  });
  if (!mcpRes.ok) return res.status(502).json({ error: 'mcp_callback_failed' });
  const data = (await mcpRes.json()) as { redirect_url: string };
  res.json({ redirectUrl: data.redirect_url });
});

export default router;
