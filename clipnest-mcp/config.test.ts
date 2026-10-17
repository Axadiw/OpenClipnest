import { describe, it, expect, vi, afterEach } from 'vitest';

async function publicMcpUrlWith(env: Record<string, string | undefined>): Promise<string> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import('./config.js')).MCP_CONFIG.publicMcpUrl;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('MCP_CONFIG.publicMcpUrl', () => {
  it('prefers PUBLIC_MCP_URL, then PUBLIC_APP_URL, then the local default — without a trailing slash', async () => {
    expect(await publicMcpUrlWith({ PUBLIC_MCP_URL: 'https://mcp.example.org/', PUBLIC_APP_URL: 'https://app.example.org' }))
      .toBe('https://mcp.example.org');
    expect(await publicMcpUrlWith({ PUBLIC_MCP_URL: undefined, PUBLIC_APP_URL: 'https://app.example.org/' }))
      .toBe('https://app.example.org');
    expect(await publicMcpUrlWith({ PUBLIC_MCP_URL: undefined, PUBLIC_APP_URL: undefined }))
      .toBe('http://localhost:8080');
  });
});
