import '../server/sentry.js';
import express from 'express';
import helmet from 'helmet';
import { MCP_CONFIG } from './config.js';
import { mountHealth } from './health.js';
import { mountRegister } from './oauth/register.js';
import { mountAuthorize } from './oauth/authorize.js';
import { mountConsentCallback } from './oauth/consent-callback.js';
import { mountToken } from './oauth/token.js';
import { mountRevoke } from './oauth/revoke.js';
import { mountDiscovery } from './oauth/discovery.js';
import { mountMcpTransport } from './mcp/transport.js';
import { initDb, pingDb } from '../server/db/index.js';
import { getRedis } from '../server/utils/redis.js';
import { setupSentryExpressErrorHandler } from '../server/sentry.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '100kb' }));

mountHealth(app, {
  pingDb: async () => {
    await pingDb();
  },
  pingRedis: async () => {
    await getRedis().ping();
  },
});

mountDiscovery(app);
mountRegister(app);
mountAuthorize(app);
mountConsentCallback(app, MCP_CONFIG.internalApiKey);
mountToken(app);
mountRevoke(app);
mountMcpTransport(app);

// Sentry error handler must come after all routes.
setupSentryExpressErrorHandler(app);

(async () => {
  // RUN_MIGRATE_AT_STARTUP is intentionally left unset (defaults to false) so
  // the MCP container does NOT run DDL migrations — that is the dedicated
  // clipnest-migrate k8s Job's responsibility.
  await initDb();
  console.log('Database initialized');

  const server = app.listen(MCP_CONFIG.port, () => {
    console.log(`clipnest-mcp listening on :${MCP_CONFIG.port}/healthz`);
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
})();
