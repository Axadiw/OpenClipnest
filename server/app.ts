// server/app.ts
//
// Builds the core Express app. Edition-specific routes and middleware come in
// through `ServerExtensions` (see server/extensions.ts); the bin entrypoint
// (server/index.ts) wires DB/Redis startup and `listen()` around this.
import express from 'express';
import helmet from 'helmet';
import { setupSentryExpressErrorHandler } from './sentry.js';
import { CONFIG } from './config.js';
import { getRedis } from './utils/redis.js';
import { requireAuth } from './middleware/auth.js';
import { requireOwner } from './middleware/editionGuards.js';
import { apiRateLimit, loginBeginRateLimit } from './middleware/rateLimit.js';
import { malformedBodyErrorHandler } from './middleware/jsonError.js';
import { installEdition, type ServerExtensions } from './extensions.js';
import authRouter from './routes/auth.js';
import eventsRouter from './routes/events.js';
import usageRouter from './routes/usage.js';
import versionRouter from './routes/version.js';
import playbackRouter from './routes/playback.js';
import internalRouter from './routes/internal.js';
import notificationsRouter from './routes/notifications.js';
import processingRouter from './routes/processing.js';
import accountRouter from './routes/account.js';
import settingsRouter from './routes/settings.js';
import oauthConsentRouter from './routes/oauthConsent.js';
import mcpClientsRouter from './routes/mcpClients.js';
import tvDeviceRouter from './routes/tv-device-auth.js';
import { createConfigRouter } from './routes/config.js';

export function createApp(ext: ServerExtensions): express.Express {
  installEdition(ext);
  const app = express();

  // Trust exactly 1 proxy hop (the reverse proxy in front of the API). Trusting
  // more would let a client spoof X-Forwarded-For via a direct API hostname to
  // bypass per-IP limits and corrupt audit-log IPs. With an SPA-path second
  // hop the rate-limit key resolves to the proxy's address — acceptable
  // because the per-user lockout (recordFailedLogin exponential backoff) is
  // the real auth gate and the shared login bucket is still tight enough.
  app.set('trust proxy', 1);

  // Edition hook — mounted first so it observes every request (including
  // rate-limited 429s and unmatched 404s). The cloud edition installs its
  // HTTP RED metrics middleware here.
  ext.beforeRoutes?.(app);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'same-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }));

  // Optional CORS for direct API access on a separate hostname.
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins?.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '7200');
        if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      }
      next();
    });
  }

  app.use(express.json({ limit: '100kb' }));
  // Rate limit is mounted at /api/ (not /api/v0/) so it automatically covers
  // future /api/v1/* routes and rejects probes to bogus /api/* paths.
  //
  // Media GETs (thumbnail + video stream) have their own higher-ceiling bucket
  // applied at the route level — skip the general bucket for those so a
  // 1000-event grid page doesn't bust 300/min just by rendering.
  const MEDIA_GET_PATH = /\/events\/[^/]+\/(thumbnail$|video\/)/;
  app.use('/api/', (req, res, next) => {
    if (req.method === 'GET' && MEDIA_GET_PATH.test(req.path)) return next();
    return apiRateLimit(req, res, next);
  });

  // Edition/capability discovery for clients — public, no secrets.
  app.use('/api/v0/config', createConfigRouter(ext));
  app.use('/api/v0/auth', authRouter);
  app.use('/api/v0/oauth/consent', requireAuth, oauthConsentRouter);
  // Apple-TV device-code grant. Each endpoint applies its own rate-limit/auth
  // internally (/code + /token are public + rate-limited; /approve is authed).
  app.use('/api/v0/tv/device', tvDeviceRouter);
  app.use('/api/v0/version', requireAuth, versionRouter);
  // Playback beacon. requireAuth only — a cloud admin can watch recordings
  // from the admin surfaces too, so the owner gate would drop real playbacks.
  app.use('/api/v0/playback', requireAuth, playbackRouter);
  // `/api/v0/users/me/*` is a core mount; the cloud edition mounts the admin
  // `/api/v0/users` router AFTER it (edition routers come after core routes).
  // Express matches mount prefixes in order, and that router runs its operator
  // gate unconditionally, so any non-admin hitting `/users/me/...` would 403
  // at the broader mount if it were tried first. The smoke spec caught this
  // (one stray 403 on `/users/me/processing-status` after login).
  //
  // `requireOwner` is the edition's content-owner gate: Clipnest Cloud keeps
  // its operator account out of the recording surfaces; self-hosted passes.
  app.use('/api/v0/users/me', requireAuth, requireOwner, processingRouter);
  // Self-service account operations (request deletion, etc.). Separate
  // router from the admin-only /users to keep the auth boundary visible and
  // prevent a future requireAdmin refactor from accidentally locking users out
  // of their own account-management endpoints.
  app.use('/api/v0/account', requireAuth, accountRouter);
  app.use('/api/v0/account/mcp-clients', requireAuth, mcpClientsRouter);
  app.use('/api/v0/events', requireAuth, requireOwner, eventsRouter);
  // Liveness/readiness probe. Pings Redis + DB AND checks the S3 socket
  // pool wedge counter (see utils/socketPoolWedge.ts). Returns 503 when any
  // dependency is unreachable so the orchestrator stops routing traffic and
  // restarts the process. The socket-pool branch is what unblocks the "API
  // silently wedged, every /video request 503s for hours" failure mode (the
  // wedge detector wired in here turns it into a 503).
  // Also exposed under /api/v0/healthz so a post-deploy smoke check can hit
  // it both directly on the API hostname and via the SPA same-origin edge.
  const healthzHandler: express.RequestHandler = async (_req, res) => {
    try {
      const { pingDb } = await import('./db/index.js');
      const { socketPoolHealthCheck } = await import('./utils/socketPoolWedge.js');
      await Promise.all([getRedis().ping(), pingDb()]);
      const wedge = socketPoolHealthCheck();
      if (!wedge.ok) {
        res.status(503).json({ status: 'unhealthy', service: 'api', reason: wedge.reason });
        return;
      }
      res.status(200).json({ status: 'ok', service: 'api' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: 'unhealthy', service: 'api', error: msg });
    }
  };
  app.get('/healthz', healthzHandler);
  app.get('/api/v0/healthz', healthzHandler);

  // Unauthenticated JSON documents under /.well-known/ (app-site association
  // files for native clients). Served without redirect and with a 1h cache —
  // Apple's and Google's fetchers reject 3xx and require application/json.
  for (const doc of ext.wellKnown ?? []) {
    app.get(doc.path, (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(200).json(doc.body());
    });
  }

  app.use('/api/v0/usage', requireAuth, usageRouter);
  app.use('/api/v0/notifications', requireAuth, requireOwner, notificationsRouter);
  app.use('/api/v0/settings', requireAuth, requireOwner, settingsRouter);

  // Edition routes — mounted after every core route so a core mount always
  // wins on a shared prefix (see the /users/me note above).
  for (const mount of ext.routers) {
    app.use(mount.path, ...(mount.middleware ?? []), mount.router);
  }

  // Step one of the native apps' two-step sign-in ("password or passkey?").
  // An edition with passkeys answers it in its own router above; without
  // them every account signs in with a password. Registered after the
  // edition routes so it is only a fallback — the apps speak one protocol to
  // every server.
  app.post('/api/v0/auth/login/begin', loginBeginRateLimit, (_req, res) => {
    res.json({ mode: 'password', oauthProviders: [] });
  });

  // Internal API for FTPS↔API communication (only accessible within the
  // private network). Defense in depth: reject any request that carries a
  // public-facing hostname in X-Forwarded-Host. The FTPS container talks to
  // the API over the private network and never sets this header, so
  // legitimate internal calls pass. Public hosts are env-driven (PUBLIC_HOSTS,
  // comma-separated) with a secure exact/suffix match — never a substring match.
  app.use('/internal', (req, res, next) => {
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').toLowerCase();
    if (forwardedHost && CONFIG.publicHosts.some(h => forwardedHost === h || forwardedHost.endsWith('.' + h))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    next();
  }, internalRouter);

  // Malformed JSON body / oversized body → quiet 4xx, NOT a Sentry issue.
  // MUST come before setupSentryExpressErrorHandler so the consumed error never
  // reaches the Sentry handler. See server/middleware/jsonError.ts.
  app.use(malformedBodyErrorHandler);

  // Sentry error handler — must come after all routes so it captures
  // unhandled Express errors before the default 500 handler responds.
  // No-op when SENTRY_DSN is unset.
  setupSentryExpressErrorHandler(app);

  return app;
}
