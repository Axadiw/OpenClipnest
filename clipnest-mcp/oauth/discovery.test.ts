import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountDiscovery } from './discovery.js';

describe('.well-known discovery', () => {
  const app = express();
  mountDiscovery(app);

  it('GET /.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://clipnest.example/mcp');
    expect(res.body.authorization_servers).toEqual(['https://clipnest.example']);
    expect(res.body.bearer_methods_supported).toEqual(['header']);
    expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['videos:read', 'videos:delete']));
    expect(res.body.resource_documentation).toBe('https://clipnest.example/help/mcp');
  });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://clipnest.example');
    expect(res.body.authorization_endpoint).toBe('https://clipnest.example/mcp/oauth/authorize');
    expect(res.body.token_endpoint).toBe('https://clipnest.example/mcp/oauth/token');
    expect(res.body.registration_endpoint).toBe('https://clipnest.example/mcp/oauth/register');
    expect(res.body.revocation_endpoint).toBe('https://clipnest.example/mcp/oauth/revoke');
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(res.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.response_types_supported).toEqual(['code']);
    expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['videos:read', 'videos:delete']));
  });
});
