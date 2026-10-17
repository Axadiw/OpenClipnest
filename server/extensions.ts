// server/extensions.ts
//
// The seam between the shared core and an *edition* (selfhost or cloud).
// `createApp()` (server/app.ts) builds the core Express app and lets the
// edition plug in at a handful of well-defined points. Everything an edition
// adds lives behind this interface so the core never imports edition code —
// `server/edition.ts` is the only file that differs between editions.
import type { Express, RequestHandler, Router } from 'express';
import { installEditionHooks, type EditionHooks } from './hooks.js';
import { installMetricsRecorder, type MetricsRecorder } from './utils/metrics.js';
import { installEditionGuards, type EditionGuards } from './middleware/editionGuards.js';
import { installPushTransport } from './services/push/transport.js';
import type { PushTransport } from './services/push/types.js';

/** A router (or bare handler) mounted at `path` behind optional middleware. */
export interface RouterMount {
  path: string;
  middleware?: RequestHandler[];
  router: Router | RequestHandler;
}

/**
 * A JSON document served unauthenticated under `/.well-known/` (AASA,
 * assetlinks.json). `body` is evaluated per request.
 */
export interface WellKnownDoc {
  path: string;
  body: () => unknown;
}

/**
 * What this edition supports — served verbatim by GET /api/v0/config so web
 * and native clients can hide sign-in methods and surfaces the server does
 * not have, instead of hard-coding the cloud product's feature set.
 */
export interface EditionFeatures {
  /** Self-registration (POST /api/v0/register) exists. */
  registration: boolean;
  /** WebAuthn passkeys (login + enrolment) exist. */
  passkeys: boolean;
  oauthGoogle: boolean;
  oauthApple: boolean;
  /** Mobile push notifications can be delivered. */
  push: boolean;
  /** The MCP endpoint (/mcp + OAuth 2.1 AS) is deployed. */
  mcp: boolean;
}

/** Role of the account created on an empty database (installer / first boot). */
export interface FirstAccountSpec {
  isAdmin: boolean;
  /** Plan attached by name; null ⇒ no plan (unlimited storage and transfer). */
  planName: string | null;
  /**
   * Set when the account can only come from the configuration (nobody can
   * register): what the operator has to set, e.g. "set ACCOUNT_EMAIL and
   * ACCOUNT_PASSWORD in .env". Without those settings the server refuses to
   * start on an empty database — it would otherwise come up healthy with
   * nobody able to sign in — and only warns once the account exists.
   */
  fromConfig?: string;
}

export interface ServerExtensions {
  name: 'selfhost' | 'cloud';
  features: EditionFeatures;
  firstAccount: FirstAccountSpec;
  /** Runs right after `trust proxy`, before any core middleware (metrics, tracing…). */
  beforeRoutes?: (app: Express) => void;
  /** Mounted after every core route and before `/internal`. */
  routers: RouterMount[];
  wellKnown?: WellKnownDoc[];
  /** Runs first, before the DB is touched: fail fast on bad configuration. */
  preflight?: () => void;
  /** Runs after the DB and Redis are ready and before the listener opens. */
  onStart?: () => Promise<void> | void;
  /** Side effects the core delegates to the edition (see server/hooks.ts). */
  hooks?: EditionHooks;
  /** Where the core's metric calls go (see utils/metrics.ts). Absent ⇒ dropped. */
  recorder?: MetricsRecorder;
  /** Operator/owner role gates (see middleware/editionGuards.ts). Absent ⇒ pass-through. */
  guards?: EditionGuards;
  /** How pushes reach devices (see services/push/types.ts). Absent ⇒ the Clipnest push relay. */
  pushTransport?: PushTransport;
}

/**
 * Install the edition's process-wide pieces (hooks, metrics recorder, role
 * guards, push transport). Called
 * by `createApp()` for the API and explicitly by every worker/cron entrypoint.
 */
export function installEdition(ext: ServerExtensions): void {
  installEditionHooks(ext.hooks);
  installMetricsRecorder(ext.recorder);
  installEditionGuards(ext.guards);
  installPushTransport(ext.pushTransport);
}
