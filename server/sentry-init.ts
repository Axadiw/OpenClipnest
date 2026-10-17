/**
 * Sentry initialization entry-point.
 *
 * This module exists ONLY so the four backend containers can load it via
 * `node --import ./dist/server/sentry-init.js` (or the MCP variant
 * `./dist-mcp/server/sentry-init.js`). ESM hoists all top-level imports of a
 * single module together, so importing `./sentry.js` at the top of an entry
 * file is *not* early enough for Sentry's express auto-instrumentation —
 * express's prototype must be hooked before its first import resolves, which
 * means `Sentry.init()` has to run strictly before any other import is
 * evaluated. The `--import` flag is Node's only way to guarantee that
 * ordering across an ES module graph.
 *
 * Configuration here MUST stay in lockstep with the helper exports in
 * `server/sentry.ts` (release/environment/integrations/ignoreErrors/tags).
 * The helper module no longer initializes Sentry — it only re-exports the
 * `@sentry/node` namespace and the express error-handler wrapper.
 *
 * Symptom this fix addresses: containers logged
 *   "[Sentry] express is not instrumented. Please make sure to initialize
 *    Sentry in a separate file that you `--import` when running node..."
 * on every startup because `import './sentry.js'` happened after `import
 * express from 'express'` in the hoisted graph.
 */
import * as Sentry from '@sentry/node';

// SENTRY_SERVICE is set per-deployment in k8s (deployment-api.yaml sets "api",
// deployment-event-manager.yaml sets "event-manager", etc.) so all errors in
// the single Sentry project are filterable by service tag.
const sentryService = process.env.SENTRY_SERVICE || 'backend';

// Thumbnail worker uses console.warn for intentional retry/skip chatter
// (stage escalation, head→full fallback, sidecar tombstone paths). Capturing
// those as Sentry events only produced noise issues. Other services use warn
// sparingly, so they keep the warn-level capture.
const consoleLevels: ('error' | 'warn')[] =
  sentryService === 'thumbnail-worker' ? ['error'] : ['error', 'warn'];

// Mirror server/config.ts's `sentryDsn` + `appVersion` lookups — we can't
// import CONFIG here because that module pulls in the entire app config
// graph, and `--import` runs this before anything else has a chance to
// resolve. Plain env-var reads keep this file self-contained.
const dsn = process.env.SENTRY_DSN || '';
const release = process.env.APP_VERSION || 'local-dev';

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release,
    tracesSampleRate: 0.1,
    integrations: [
      // Forward console.error / console.warn into Sentry as events. Without
      // this only unhandled exceptions and the express error handler
      // produce events — a service that catches and `console.error()`s its
      // own failures would be silent.
      Sentry.captureConsoleIntegration({ levels: consoleLevels }),
    ],
    // Transient S3 HeadObject errors are recoverable: the file-uploaded
    // route returns 502 and FTPS retries. Real permanent failures
    // (NoSuchKey, AccessDenied, NotFound, …) still flow through.
    ignoreErrors: [
      /HeadObject failed for .+: (UnknownError|TimeoutError|ETIMEDOUT|ECONNRESET|RequestTimeout|ThrottlingException)$/,
    ],
    initialScope: {
      tags: { service: sentryService },
    },
  });
}
