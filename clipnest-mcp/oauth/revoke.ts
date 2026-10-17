import type { Express } from 'express';
import {
  revokeAccessToken, revokeRefreshFamily, writeAuditLog,
  getRefreshTokenFamilyByHash,
} from '../db/queries.js';
import { hashToken } from './accessToken.js';

export function mountRevoke(app: Express): void {
  app.post('/mcp/oauth/revoke', async (req, res) => {
    const { token, token_type_hint } = (req.body ?? {}) as Record<string, string>;
    if (!token) return res.status(200).end(); // RFC 7009 §2.2: always 200

    const h = hashToken(token);
    const isRefresh = token_type_hint === 'refresh_token' || token.startsWith('mcp_rt_');

    if (isRefresh) {
      const row = await getRefreshTokenFamilyByHash(h);
      if (row) {
        await revokeRefreshFamily(row.familyId);
        await writeAuditLog({
          userId: row.userId,
          clientId: row.clientId,
          action: 'token.revoke',
          detailsJson: { kind: 'family', family: row.familyId },
          ip: req.ip ?? null,
        });
      }
    } else {
      await revokeAccessToken(h);
      await writeAuditLog({
        userId: null, clientId: null,
        action: 'token.revoke',
        detailsJson: { kind: 'access' },
        ip: req.ip ?? null,
      });
    }
    res.status(200).end();
  });
}
