export const MCP_CONFIG = {
  port: Number(process.env.MCP_PORT ?? 3100),
  // Public origin the MCP endpoints are reachable at. Same origin as the web
  // app by default (the reverse proxy routes /mcp and /.well-known/oauth-* here).
  publicMcpUrl: (process.env.PUBLIC_MCP_URL ?? process.env.PUBLIC_APP_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  internalApiKey: process.env.CLIPNEST_INTERNAL_API_KEY ?? '',
} as const;
