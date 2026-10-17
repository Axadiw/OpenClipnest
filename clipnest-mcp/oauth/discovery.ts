import type { Express } from 'express';
import { MCP_CONFIG } from '../config.js';

export function mountDiscovery(app: Express): void {
  const base = MCP_CONFIG.publicMcpUrl;
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['videos:read', 'videos:delete', 'account:read', 'notifications:write'],
      resource_documentation: `${base}/help/mcp`,
    });
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/mcp/oauth/authorize`,
      token_endpoint: `${base}/mcp/oauth/token`,
      registration_endpoint: `${base}/mcp/oauth/register`,
      revocation_endpoint: `${base}/mcp/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['videos:read', 'videos:delete', 'account:read', 'notifications:write'],
    });
  });
}
