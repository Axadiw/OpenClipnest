// server/routes/config.ts
//
// GET /api/v0/config — unauthenticated, no secrets. Tells a client what this
// server is (edition, version), which sign-in methods and surfaces it offers,
// and where cameras should upload. Native apps call it right after the user
// picks a server, before rendering the sign-in screen.
import { Router } from 'express';
import { CONFIG } from '../config.js';
import type { ServerExtensions } from '../extensions.js';
import { relayUrlFromEnv } from '../services/push/relayTransport.js';

export function createConfigRouter(ext: Pick<ServerExtensions, 'name' | 'features' | 'pushTransport'>): Router {
  return Router().get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      edition: ext.name,
      version: CONFIG.appVersion,
      features: ext.features,
      ftps: { host: CONFIG.publicFtpsHost, port: CONFIG.publicFtpsPort },
      // How devices register for push on this server: 'relay' (public key +
      // ticket, see POST /account/push-devices/relay) or 'direct' (raw token).
      push: ext.features.push ? { mode: ext.pushTransport ? 'direct' : 'relay', relayUrl: ext.pushTransport ? undefined : relayUrlFromEnv() ?? undefined } : null,
    });
  });
}
