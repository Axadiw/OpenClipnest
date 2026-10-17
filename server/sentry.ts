/**
 * Sentry helpers — express error handler wrapper + `Sentry` re-export.
 *
 * NOTE: `Sentry.init({...})` no longer lives here. It moved to
 * `server/sentry-init.ts` (loaded via `node --import ./dist/server/sentry-init.js`
 * — see Dockerfile.* and k8s/deployment-*.yaml) so the express
 * auto-instrumentation can hook the express prototype before the entry file
 * imports express. See the docstring in sentry-init.ts.
 *
 * Importing this module is now a side-effect-free helper import: it does NOT
 * initialise Sentry. The `--import` flag on the node invocation is the only
 * thing that initialises Sentry; in-process `import './sentry.js'` calls
 * only buy you the helper exports below.
 */
import * as Sentry from '@sentry/node';
import { setupExpressErrorHandler } from '@sentry/node';
import { CONFIG } from './config.js';
import type { Application } from 'express';

export function setupSentryExpressErrorHandler(app: Application): void {
  if (CONFIG.sentryDsn) setupExpressErrorHandler(app);
}

export { Sentry };
