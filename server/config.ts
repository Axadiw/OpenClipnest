import { internalApiKeyFromEnv } from './utils/internalApiKey.js';

// Runtime deployment mode. 'k8s' = periodic loops run as CronJob one-shots
// (this process must NOT fire setInterval-based periodic work). Anything else
// (default: docker-compose / local) keeps the in-process schedulers on.
export const RUN_MODE = process.env.RUN_MODE || 'compose';
export const IS_K8S = RUN_MODE === 'k8s';

// Public origin of the web app. Every public-facing default (host allowlist,
// FTPS host, the cloud edition's WebAuthn RP) derives from it, so a
// self-hosted install only has to set this one variable.
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'http://localhost:8080').replace(/\/$/, '');
const PUBLIC_HOST = new URL(PUBLIC_APP_URL).hostname;

/**
 * The Postgres connection string. DATABASE_URL is either a full URL, used as
 * is, or a bare `host:port/db`, completed with POSTGRES_USER and
 * POSTGRES_PASSWORD. Those two are percent-encoded: a password is any string,
 * and a `/`, `#`, `?` or `@` in it would otherwise end the user-info part of
 * the URL early and fail the connection with "Invalid URL". A password made
 * of URL-safe characters comes out unchanged.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATABASE_URL || 'clipnest-db:5432/clipnest';
  if (raw.startsWith('postgresql://') || raw.startsWith('postgres://')) return raw;
  const user = encodeURIComponent(env.POSTGRES_USER || 'clipnest');
  const pass = encodeURIComponent(env.POSTGRES_PASSWORD || 'devpassword');
  return `postgresql://${user}:${pass}@${raw}`;
}

/** CLIPNEST_CLEAN_FRAME_ENABLED: anything but "false" — including unset — means on. */
export function cleanFrameEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLIPNEST_CLEAN_FRAME_ENABLED !== 'false';
}

export const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Application version — injected at Docker build time via APP_VERSION env var.
  // Falls back to 'local-dev' for local runs (e.g. `npm start` without docker).
  appVersion: process.env.APP_VERSION || 'local-dev',
  recordingsPath: process.env.RECORDINGS_PATH || '/recordings',
  dataPath: process.env.DATA_PATH || '/app/data',
  databaseUrl: databaseUrlFromEnv(),
  jwtSecret: process.env.JWT_SECRET || '',
  // Access token: short-lived. Refresh flow keeps the session alive silently.
  accessTokenExpirySeconds: 900, // 15 min
  // Refresh token: long-lived. User stays signed in across restarts for 30 days.
  // tokenGeneration still invalidates both on password change / ban.
  refreshTokenExpirySeconds: 30 * 24 * 3600, // 30 days
  mediaTokenExpirySeconds: 900, // 15 min — short-lived tokens for media URLs
  // 2-minute window for MCP-issued media tokens. Shorter than the SPA
  // `mediaTokenExpirySeconds: 900` because MCP OAuth grant revocation does
  // not synchronously invalidate JWT-based media tokens. A 2-min window caps
  // the post-revocation exposure to a tolerable level until the proper
  // OAuth-family-bound media-token validation is implemented.
  mcpMediaTokenExpirySeconds: 120,
  scanIntervalMs: 60_000,
  bcryptRounds: 12,
  itemsPerPage: 50,

  // S3-compatible object storage (MinIO, AWS S3, any path-style endpoint)
  s3Endpoint: process.env.CLIPNEST_S3_ENDPOINT || '',
  s3AccessKey: process.env.CLIPNEST_S3_ACCESS_KEY || '',
  s3SecretKey: process.env.CLIPNEST_S3_SECRET_KEY || '',
  s3RecordingsBucket: process.env.CLIPNEST_S3_RECORDINGS_BUCKET || 'recordings',
  s3ThumbnailsBucket: process.env.CLIPNEST_S3_THUMBNAILS_BUCKET || 'thumbnails',
  // fmp4 patch sidecars (~5 KB each). Generated once by the thumbnail worker
  // and read on every playback start. Held in a separate bucket for two
  // reasons: (1) FTPS server has no credentials here so users can't see /
  // download internal artifacts via FTPS LIST; (2) sidecar bytes are server
  // overhead — they're never counted toward the user's storage quota,
  // analogous to the thumbnails bucket. Mirror the recordings key shape so
  // lifecycle is trivial (same `<userUuid>/<relPath>.fmp4patch` path).
  s3SidecarsBucket: process.env.CLIPNEST_S3_SIDECARS_BUCKET || 'sidecars',

  // Encryption master key — combined with per-user salt via HKDF to derive SSE-C keys
  encryptionMasterKey: process.env.CLIPNEST_ENCRYPTION_MASTER_KEY || '',

  // Internal API key for FTPS↔API and MCP↔API communication
  internalApiKey: internalApiKeyFromEnv(),

  // Internal MCP container base URL (Docker network / k8s service name)
  internalMcpUrl: process.env.INTERNAL_MCP_URL ?? 'http://clipnest-mcp:3100',

  // Public origin of the web app — embedded in links, used to derive the
  // public host list, FTPS host and (in the cloud edition) the WebAuthn RP.
  publicAppUrl: PUBLIC_APP_URL,

  // Comma-separated list of public hostnames used to block /internal/* from
  // public access. Exact domain match or parent-domain suffix match is applied.
  // Defaults to the web app's host.
  publicHosts: process.env.PUBLIC_HOSTS?.split(',').map(h => h.trim()).filter(Boolean)
    ?? [PUBLIC_HOST],

  // Where cameras reach the FTPS server (shown to the user in Settings and
  // reported by GET /api/v0/config). Defaults to the web app's host.
  publicFtpsHost: process.env.PUBLIC_FTPS_HOST || PUBLIC_HOST,
  publicFtpsPort: parseInt(process.env.PUBLIC_FTPS_PORT || '21', 10),

  // APNs (Apple Push Notification service) — token-based (JWT/ES256) auth.
  // APNS_KEY_P8 holds the PEM contents of the .p8 signing key (NOT a path);
  // multiline values come through k8s secrets fine. When APNS_KEY_P8 is unset
  // the push worker logs + no-ops so local/dev runs without Apple creds don't
  // crash. APNS_TOPIC is the iOS app's bundle id. APNS_ENV selects
  // api.push.apple.com (production) vs api.sandbox.push.apple.com.
  apnsKeyId: process.env.APNS_KEY_ID || '',
  apnsTeamId: process.env.APNS_TEAM_ID || '',
  apnsKeyP8: process.env.APNS_KEY_P8 || '',
  apnsTopic: process.env.APNS_TOPIC || '',
  apnsEnv: (process.env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production') as 'production' | 'sandbox',

  // FCM (Android push). The full service-account JSON for the Firebase project
  // whose google-services.json ships in the Android app. Empty ⇒ the FCM
  // sender is a no-op and Android devices are skipped (like APNs unconfigured).
  fcmServiceAccountJson: process.env.CLIPNEST_FCM_SERVICE_ACCOUNT_JSON || '',

  // Storage reconciler: gate for the Step-2b auto-purge of truly-unowned
  // orphan S3 objects older than ORPHAN_AUTO_PURGE_DAYS. DEFAULT = ENABLED
  // when unset — production already auto-purges and we must preserve that
  // behavior. Only the explicit strings 'false' / '0' disable it; anything
  // else (including unset) leaves it on. When disabled the reconciler still
  // DETECTS and upserts orphans (so admins keep visibility) but never deletes.
  orphanAutoPurgeEnabled: (() => {
    const raw = process.env.CLIPNEST_ORPHAN_AUTO_PURGE;
    if (raw === 'false' || raw === '0') return false;
    return true;
  })(),

  // Serve the clean faststart MP4 rebuilt from the `.clean_frame` sidecar to
  // requests that ask for `?fmt=clean` (the clients do: it is what gives native
  // players backward frame-stepping). On unless CLIPNEST_CLEAN_FRAME_ENABLED is
  // "false". Off — or a recording without a clean-frame sidecar — falls back to
  // the fmp4patch stream, so the flag is a kill switch, not a feature gate.
  cleanFrameEnabled: cleanFrameEnabledFromEnv(),
};
