// Frontend build version. Injected at Vite build time via the
// VITE_APP_VERSION env var — see client/vite.config.ts. Falls back to
// 'local-dev' for `npm run dev`.
export const FRONTEND_VERSION: string = __APP_VERSION__;

import type { IconKind } from './types';
import { wipeScrubCache } from './lib/scrubCache/client';

export type CameraProfileMode = 'auto' | 'reolink' | 'hikvision' | 'axis' | 'foscam' | 'custom';

export interface ProcessingFile {
  filename: string;
  uploadedAt: string;
}

export interface ProcessingStatus {
  inProgressCount: number;
  inProgressFiles: ProcessingFile[];
}

/**
 * Canonical vendor profile shipped by the server (`templates` in the
 * camera-profiles GET response). The frontend seeds these into "custom" mode
 * when the list is empty and offers them as a "reset to defaults" — the
 * regexes are never hardcoded client-side.
 */
export interface VendorProfileTemplate {
  name: string;
  regex: string;
  viewsConfig: Array<{ id: string; iconKind: IconKind }>;
}

export interface UserCameraProfile {
  id: number;
  name: string;
  regex: string;
  /**
   * Fallback view id when the regex doesn't carry a `view` named group.
   * Arbitrary string (length 1..16) — Reolink uses '00'/'01' but custom
   * profiles can pick any value that matches their regex output. Mirrors
   * `viewsConfig[0].id`.
   */
  viewDefault: string;
  /**
   * Ordered per-view editor state — each entry maps a view id to its display
   * glyph. The first entry is the primary view (default playback). Drives the
   * player toggle icons for events matched by this profile.
   */
  viewsConfig: Array<{ id: string; iconKind: IconKind }>;
  priority: number;
  enabled: boolean;
  createdAt: string;
}

const TOKEN_KEY = 'clipnest-token';
const REFRESH_TOKEN_KEY = 'clipnest-refresh-token';
const REMEMBER_KEY = 'clipnest-remember';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
}
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY) || sessionStorage.getItem(REFRESH_TOKEN_KEY);
}
export function setToken(token: string, remember = true): void {
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REMEMBER_KEY, '1');
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REMEMBER_KEY, '0');
    localStorage.removeItem(TOKEN_KEY);
  }
}
export function setRefreshToken(token: string, remember = true): void {
  if (remember) {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  } else {
    sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}
export function getRememberMe(): boolean { return localStorage.getItem(REMEMBER_KEY) !== '0'; }
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  // Signing out frees every video byte the service worker holds in memory.
  void wipeScrubCache();
}

/**
 * Window event broadcast on every HTTP 429 so one global notice can show a
 * wait-countdown without every call site handling 429 itself. `detail`
 * carries the parsed `Retry-After` seconds (undefined when the header is
 * missing/garbled — the UI then shows a generic "wait a moment" message).
 */
export const RATE_LIMITED_EVENT = 'clipnest:rate-limited';
export interface RateLimitedDetail { retryAfter?: number }

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (raw == null) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function signalRateLimit(retryAfter: number | undefined): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<RateLimitedDetail>(RATE_LIMITED_EVENT, { detail: { retryAfter } }));
}

// Single-flight refresh: concurrent 401s share one refresh call instead of
// racing the rate limiter. `refreshed` means a fresh access token was stored;
// `failed` means the session is dead (clear + reload); `rate-limited` is a
// TRANSIENT throttle — the session is still valid, so the caller must keep it
// and surface a countdown instead of logging the user out.
type RefreshResult =
  | { kind: 'refreshed' }
  | { kind: 'failed' }
  | { kind: 'rate-limited'; retryAfter?: number };

let refreshInFlight: Promise<RefreshResult> | null = null;
async function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  const rt = getRefreshToken();
  if (!rt) return { kind: 'failed' };
  const remember = getRememberMe();
  refreshInFlight = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch('/api/v0/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res);
        signalRateLimit(retryAfter);
        return { kind: 'rate-limited', retryAfter };
      }
      if (!res.ok) return { kind: 'failed' };
      const body = await res.json() as { token?: string; refreshToken?: string };
      if (!body.token || !body.refreshToken) return { kind: 'failed' };
      setToken(body.token, remember);
      setRefreshToken(body.refreshToken, remember);
      return { kind: 'refreshed' };
    } catch {
      return { kind: 'failed' };
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: Record<string, unknown>,
    /** Seconds to wait before retrying, parsed from the `Retry-After` header
     *  on a 429. Undefined when the server didn't send a usable value. */
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const doFetch = async (): Promise<Response> => {
    const token = getToken();
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
    return fetch(url, { ...opts, headers });
  };

  let res = await doFetch();
  // 401 on the login surfaces themselves is "wrong credentials", NOT a
  // session-expiry signal — don't try to refresh, don't blow away the
  // (probably empty) token store, don't reload. Let ApiError propagate so
  // the login form can display "invalid credentials" inline.
  const isLoginAttempt =
    url === '/api/v0/auth/login' ||
    url === '/api/v0/auth/login/passkey' ||
    url === '/api/v0/auth/login/backup' ||
    url === '/api/v0/auth/login/begin';
  if (res.status === 401 && !url.endsWith('/api/v0/auth/refresh') && !isLoginAttempt) {
    const refreshed = await refreshAccessToken();
    if (refreshed.kind === 'refreshed') {
      res = await doFetch();
    } else if (refreshed.kind === 'rate-limited') {
      // Transient throttle on the refresh endpoint — the session is still
      // valid. Surface the countdown (already broadcast by refreshAccessToken)
      // and keep the tokens. Clearing + reloading here would spin a
      // logout→reload loop under CMD+R spam.
      throw new ApiError('Too many requests. Try again later.', 429, undefined, refreshed.retryAfter);
    } else {
      clearToken();
      window.location.reload();
      throw new ApiError('Unauthorized', 401);
    }
    if (res.status === 401) {
      clearToken();
      window.location.reload();
      throw new ApiError('Unauthorized', 401);
    }
  }
  if (!res.ok) {
    // Broadcast 429s globally so the rate-limit notice can show a countdown,
    // regardless of which call site fired (most don't handle 429 themselves).
    // Also parse Retry-After for 423 (account lockout) so callers can start
    // the same countdown without reading it out of the response body.
    const retryAfter = (res.status === 429 || res.status === 423) ? parseRetryAfter(res) : undefined;
    if (res.status === 429) signalRateLimit(retryAfter);
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || res.statusText, res.status, body, retryAfter);
  }
  // 204 No Content / 205 Reset Content have an empty body by spec — calling
  // res.json() would throw SyntaxError. Return undefined for callers that
  // don't need a body (DELETE endpoints, etc.).
  if (res.status === 204 || res.status === 205) return undefined as T;
  return res.json();
}

/**
 * Fire-and-forget playback beacon. The server cannot tell watching from
 * seeking (every player fetches an mp4's tail for the moov atom), so the two
 * numbers behind the activity dashboard — playbacks started and playbacks
 * finished — can only come from the player itself.
 *
 * Deliberately NOT routed through `request()`: that helper treats a 401 as
 * session expiry and calls `clearToken()` + `window.location.reload()`. A
 * metrics beacon must never be able to sign the user out or reload the page
 * out from under someone who is watching a video. Every failure is swallowed.
 *
 * `keepalive` lets a `completed` sent as the tab closes still reach the server.
 */
export function reportPlayback(kind: 'started' | 'completed'): void {
  const token = getToken();
  if (!token) return;
  try {
    void fetch('/api/v0/playback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, platform: 'web' }),
      keepalive: true,
    }).catch(() => { /* telemetry is never worth surfacing to the user */ });
  } catch {
    // fetch itself can throw synchronously (e.g. jsdom without a fetch impl)
  }
}

/**
 * Best-effort server-side sign-out. `device` ends only this browser's session
 * (the other devices stay signed in); `all` ends every session of the account.
 *
 * The tokens are read up front, so the caller may clear them right after
 * calling this. It talks to the server directly rather than through
 * `request()`: an expired access token must not trigger request()'s
 * reload-on-401, and with the local tokens already cleared request() could not
 * refresh it. Here an expired access token is refreshed once with the captured
 * refresh token, and the sign-out sent with the new one. Never throws — a dead
 * network must never block the local sign-out. Resolves true when the server
 * confirmed it.
 */
export async function logout(scope: 'device' | 'all' = 'device'): Promise<boolean> {
  const access = getToken();
  const refresh = getRefreshToken();
  const send = (token: string) => fetch('/api/v0/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  try {
    let res = access ? await send(access) : null;
    if ((!res || res.status === 401) && refresh) {
      const refreshed = await fetch('/api/v0/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (refreshed.ok) {
        const { token } = await refreshed.json() as { token: string };
        res = await send(token);
      }
    }
    return !!res?.ok;
  } catch {
    return false;
  }
}

export interface OAuthResult {
  token?: string;
  refreshToken?: string;
  user?: { id: string; email: string; emailVerified?: boolean; isAdmin: boolean; active: boolean };
  needsConsent?: boolean;
  signupTicket?: string;
  email?: string | null;
  pendingActivation?: boolean;
}

export interface ServerConfig {
  edition: 'selfhost' | 'cloud';
  version: string;
  features: { registration: boolean; passkeys: boolean; oauthGoogle: boolean; oauthApple: boolean; push: boolean; mcp: boolean; paidPlans?: boolean };
  ftps: { host: string; port: number };
  push: { mode: 'relay' | 'direct'; relayUrl?: string } | null;
}

export const api = {
  getVersion: () => request<{ version: string }>('/api/v0/version'),
  /** Public edition/capability description of the server (no auth). */
  getConfig: () => request<ServerConfig>('/api/v0/config'),
  login: (email: string, password: string) =>
    request<{ token: string; refreshToken: string; user: { id: string; email: string; emailVerified?: boolean; isAdmin: boolean; active: boolean } }>('/api/v0/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),
  getEvents: (params: {
    camera?: string[];
    mode?: 'daily' | 'range';
    dateFrom?: string;
    dateTo?: string;
    timeFrom?: string;
    timeTo?: string;
    rangeFrom?: string;
    rangeTo?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params.camera) params.camera.forEach(c => sp.append('camera', c));
    // Only persist mode=range; mode=daily is the server default and omitting
    // the param keeps URLs clean for the common case.
    if (params.mode === 'range') sp.set('mode', 'range');
    if (params.dateFrom) sp.set('dateFrom', params.dateFrom);
    if (params.dateTo) sp.set('dateTo', params.dateTo);
    if (params.timeFrom) sp.set('timeFrom', params.timeFrom);
    if (params.timeTo) sp.set('timeTo', params.timeTo);
    if (params.rangeFrom) sp.set('from', params.rangeFrom);
    if (params.rangeTo) sp.set('to', params.rangeTo);
    if (params.cursor) sp.set('cursor', params.cursor);
    if (params.limit != null) sp.set('limit', String(params.limit));
    return request<{ events: import('./types').CameraEvent[]; total: number; nextCursor: string | null }>(`/api/v0/events?${sp}`);
  },
  getEvent: (id: string) =>
    request<{ event: import('./types').CameraEvent }>(`/api/v0/events/${encodeURIComponent(id)}/detail`),
  getCameras: () => request<{ cameras: string[] }>('/api/v0/events/cameras'),
  /** Per-day event-count rollup for the Timeline calendar picker. */
  getEventCalendar: (from: string, to: string) =>
    request<{ days: { date: string; count: number; cameraCount: number }[] }>(
      `/api/v0/events/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  deleteEvent: (id: string) =>
    request<{ ok: true }>(`/api/v0/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  bulkDeleteEvents: (ids: string[]) =>
    request<{ deleted: number; notFound: string[]; requested: number }>(
      `/api/v0/events?ids=${encodeURIComponent(ids.join(','))}&confirm=true`,
      { method: 'DELETE' },
    ),
  getCamerasDetailed: () => request<{ cameras: Array<{ camera: string; firstEventAt: string; lastEventAt: string; eventCount: number }> }>('/api/v0/events/cameras/detailed'),
  getAccountTimezone: () => request<{ timezone: string }>('/api/v0/settings/timezone'),
  setAccountTimezone: (timezone: string) =>
    request<{ ok: true }>('/api/v0/settings/timezone', { method: 'PUT', body: JSON.stringify({ timezone }) }),

  // Media token: short-lived, scoped to a single event. Response also
  // carries the file sizes the player needs for its buffer indicator
  // ("X MB / Y MB"), so the player no longer has to fire a separate
  // Range:bytes=0-0 probe against the video endpoint. `viewSizes` is keyed
  // by view id (e.g. '00', '01' for Reolink) — getVideoUrl looks up the
  // matching entry.
  getMediaToken: (eventId: string) =>
    request<{
      token: string;
      viewSizes?: Record<string, number>;
    }>(`/api/v0/events/${eventId}/media-token`, { method: 'POST' }),

  // Async video URL using a short-lived media token (never leaks session
  // token). Returns the clean faststart MP4 endpoint — the same
  // `?fmt=clean` direct path iOS uses. The server reconstructs a clean
  // faststart MP4 on the fly from the `.clean_frame` sidecar when
  // `CONFIG.cleanFrameEnabled` (true in prod) + `?fmt=clean`, and falls
  // through to the fmp4-patch / raw-passthrough path on sidecar-miss.
  // Reolink clips are short, so a plain progressive `<video src>` is fine
  // — no HLS/segmentation needed.
  // `viewId` is the profile-defined string id (Reolink: '00'/'01').
  getVideoUrl: async (
    eventId: string,
    viewId: string,
  ): Promise<{ videoUrl: string; totalBytes: number | null }> => {
    const t = await api.getMediaToken(eventId);
    const tok = encodeURIComponent(t.token);
    const viewSeg = encodeURIComponent(viewId);
    const videoUrl = `/api/v0/events/${eventId}/video/${viewSeg}?media_token=${tok}&fmt=clean`;
    const totalBytes = t.viewSizes?.[viewId] ?? null;
    return { videoUrl, totalBytes };
  },

  // Per-frame presentation times (seconds) for the real VFR grid, used by the
  // player's frame-step buttons. Returns [] when the grid isn't available yet
  // (endpoint/sidecar absent) so the player falls back to fps-based stepping.
  getFrameGrid: async (eventId: string, viewId: string): Promise<number[]> => {
    try {
      const data = await request<{ grid: number[] }>(
        `/api/v0/events/${eventId}/video/${encodeURIComponent(viewId)}/frames`,
      );
      return Array.isArray(data?.grid) ? data.grid : [];
    } catch {
      return [];
    }
  },

  // Fetch thumbnail as blob URL using Authorization header (no token in URL)
  fetchThumbnailBlob: async (eventId: string): Promise<string> => {
    const doFetch = async () => {
      const token = getToken();
      return fetch(`/api/v0/events/${eventId}/thumbnail`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
    };
    let res = await doFetch();
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) res = await doFetch();
      if (res.status === 401) {
        clearToken();
        window.location.reload();
        throw new Error('Unauthorized');
      }
    }
    if (!res.ok) throw new Error('Failed to load thumbnail');
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  // Download video via media token. Hits the dedicated `/original` endpoint,
  // which streams the camera's uploaded file byte-for-byte (no clean-faststart
  // reconstruction, no fmp4 sidecar stitch, no moov/sidx patching) with
  // `Content-Disposition: attachment`. So "Download" always yields the pristine
  // original recording, never the processed playback stream.
  downloadVideo: async (eventId: string, viewId: string, filename: string): Promise<void> => {
    const t = await api.getMediaToken(eventId);
    const tok = encodeURIComponent(t.token);
    const viewSeg = encodeURIComponent(viewId);
    const directUrl = `/api/v0/events/${eventId}/video/${viewSeg}/original?media_token=${tok}`;
    const a = document.createElement('a');
    a.href = directUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  // Usage / Quota
  getUsage: () => request<{
    disk: { usageBytes: number; limitBytes: number; percent: number };
    transfer: { usageBytes: number; limitBytes: number; percent: number; resetAt: string | null };
    /** Absent on older servers. */
    accessLocked?: boolean;
  }>('/api/v0/usage'),
  // Per-camera disk-usage breakdown for the Storage tab visualization.
  // Sum of `bytes` may be slightly less than `getUsage().disk.usageBytes`
  // — orphan file_metadata rows not yet linked to an event are excluded
  // by design. Sorted by bytes DESC server-side.
  getUsageByCamera: () => request<{
    cameras: Array<{
      cameraName: string;
      bytes: number;
      durationSeconds: number;
      eventCount: number;
    }>;
  }>('/api/v0/usage/by-camera'),
  getAutoDelete: () => request<{ enabled: boolean }>('/api/v0/usage/auto-delete'),
  setAutoDelete: (enabled: boolean) =>
    request<{ enabled: boolean }>('/api/v0/usage/auto-delete', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  getAutoDeleteAfterDays: () =>
    request<{ days: number | null }>('/api/v0/usage/auto-delete-after-days'),
  setAutoDeleteAfterDays: (days: number | null) =>
    request<{ days: number | null }>('/api/v0/usage/auto-delete-after-days', {
      method: 'PUT',
      body: JSON.stringify({ days }),
    }),
  listNotifications: (opts: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', opts.before);
    const qs = params.toString();
    return request<{ notifications: import('./types').Notification[] }>(
      `/api/v0/notifications${qs ? '?' + qs : ''}`,
    );
  },
  getUnreadNotificationCount: () =>
    request<{ count: number }>('/api/v0/notifications/unread-count'),
  markNotificationRead: (id: string) =>
    request<{ success: boolean }>(`/api/v0/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () =>
    request<{ success: boolean; updated: number }>('/api/v0/notifications/read-all', { method: 'POST' }),
  deleteNotification: (id: string) =>
    request<{ success: boolean }>(`/api/v0/notifications/${id}`, { method: 'DELETE' }),
  deleteReadNotifications: () =>
    request<{ success: boolean; deleted: number }>('/api/v0/notifications', { method: 'DELETE' }),

  // Camera profiles
  getCameraProfiles: () =>
    request<{ mode: CameraProfileMode; customProfiles: UserCameraProfile[]; templates: VendorProfileTemplate[] }>('/api/v0/settings/camera-profiles'),
  setCameraProfileMode: (mode: CameraProfileMode) =>
    request<{ mode: CameraProfileMode }>('/api/v0/settings/camera-profiles/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),
  createCustomProfile: (data: { name: string; regex: string; viewsConfig?: Array<{ id: string; iconKind: IconKind }>; priority?: number }) =>
    request<UserCameraProfile>('/api/v0/settings/camera-profiles/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateCustomProfile: (id: number, data: Partial<{ name: string; regex: string; viewsConfig: Array<{ id: string; iconKind: IconKind }>; priority: number; enabled: boolean }>) =>
    request<UserCameraProfile>(`/api/v0/settings/camera-profiles/custom/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteCustomProfile: (id: number) =>
    request<void>(`/api/v0/settings/camera-profiles/custom/${id}`, { method: 'DELETE' }),
  // Atomic reset-to-defaults: server transactionally deletes all custom
  // profiles and seeds the vendor templates (no cap interaction, no empty
  // window). Returns the seeded set.
  resetCameraProfiles: () =>
    request<{ customProfiles: UserCameraProfile[] }>('/api/v0/settings/camera-profiles/reset', { method: 'POST' }),
  testCameraProfileRegex: (regex: string, filename: string) =>
    request<{ result: { camera: string; view: string; tsRaw: string; ext: string } | null; reason?: string }>(
      '/api/v0/settings/camera-profiles/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regex, filename }) },
    ),

  // Processing status: in-flight scanner work. Polled every 15s by the
  // indicator badge. Permanent failures retired 2026-05-13 (tombstoned
  // events are hidden from the grid; no user-facing surface).
  fetchProcessingStatus: () =>
    request<ProcessingStatus>('/api/v0/users/me/processing-status'),

  // MCP client management (Settings → MCP Clients tab)
  listMcpClients: () =>
    request<{ clients: Array<{ clientId: string; clientName: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> }>(
      '/api/v0/account/mcp-clients',
    ),
  revokeMcpClient: (id: string) =>
    request<void>(`/api/v0/account/mcp-clients/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // MCP OAuth consent flow. Server router (server/routes/oauthConsent.ts)
  // uses a `:txn` path parameter, NOT a query string — earlier code shipped
  // the wrong shape and every consent fetch returned 404 ("This authorization
  // session has expired" on the SPA).
  getOauthConsent: (txn: string) =>
    request<{ clientName: string; scopes: string[]; redirectUri: string }>(
      `/api/v0/oauth/consent/${encodeURIComponent(txn)}`,
    ),
  postOauthConsent: (txn: string, body: { decision: 'approve' | 'deny'; scopes?: string[] }) =>
    request<{ redirectUrl: string }>(`/api/v0/oauth/consent/${encodeURIComponent(txn)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Apple-TV device-code grant: a signed-in user approves the code shown on
  // their TV. `userCode` is the canonical (un-dashed, upper-case) form. On a
  // bad/lapsed code the server replies 400 with `error: 'invalid_code' |
  // 'invalid_or_expired'`, which surfaces as ApiError.message.
  tvApprove: (userCode: string) =>
    request<{ ok: true }>('/api/v0/tv/device/approve', {
      method: 'POST',
      body: JSON.stringify({ user_code: userCode }),
    }),
};
