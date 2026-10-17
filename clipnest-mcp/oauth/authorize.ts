import type { Express } from 'express';
import { getClient, insertTxn } from '../db/queries.js';
import { MCP_CONFIG } from '../config.js';

const EXPECTED_RESOURCE = `${MCP_CONFIG.publicMcpUrl}/mcp`;
const ALLOWED_SCOPES = new Set([
  'videos:read',
  'videos:delete',
  'account:read',
  'notifications:write',
]);

export function mountAuthorize(app: Express): void {
  app.get('/mcp/oauth/authorize', async (req, res) => {
    const {
      response_type, client_id, redirect_uri,
      code_challenge, code_challenge_method,
      state, scope, resource,
    } = req.query;

    if (response_type !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }
    if (typeof client_id !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id required' });
    }
    if (typeof redirect_uri !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
    }
    if (typeof code_challenge !== 'string' || code_challenge.length < 43 || code_challenge.length > 128) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge required (43..128 chars)' });
    }
    if (code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
    }
    if (typeof state !== 'string' || state.length === 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'state required' });
    }
    if (typeof scope !== 'string'
        || scope.split(/\s+/).filter(Boolean).length === 0
        || scope.split(/\s+/).filter(Boolean).some(s => !ALLOWED_SCOPES.has(s))) {
      return res.status(400).json({ error: 'invalid_scope' });
    }
    if (resource !== EXPECTED_RESOURCE) {
      return res.status(400).json({ error: 'invalid_target', error_description: `resource must equal ${EXPECTED_RESOURCE}` });
    }

    const client = await getClient(client_id);
    if (!client || client.revokedAt !== null) {
      return res.status(400).json({ error: 'invalid_client' });
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' });
    }

    const txnId = await insertTxn({
      clientId: client_id,
      redirectUri: redirect_uri,
      scope,
      state,
      codeChallenge: code_challenge,
      resource,
    });
    const consentUrl = `${MCP_CONFIG.publicMcpUrl}/oauth/consent?txn=${encodeURIComponent(txnId)}`;
    res.redirect(302, consentUrl);
  });
}
