/**
 * URL and header helpers shared by the service worker and the page. Pure: no worker or DOM
 * globals, so the page can import `videoCacheKey` and the tests can run in Node.
 */

const VIDEO_PATH = /^\/api\/v0\/events\/([^/]+)\/video\/([^/]+)$/;

/**
 * The cache key of a clean-video URL: `"<eventId>/<view>/clean"`. The media token, the
 * stall-retry cache-buster and the preview flag are not part of it, so a fresh token or a
 * retry reuses the bytes already cached. `null` for every other URL.
 */
export function videoCacheKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url, 'http://local.invalid');
  } catch {
    return null;
  }
  const m = VIDEO_PATH.exec(u.pathname);
  if (!m || u.searchParams.get('fmt') !== 'clean') return null;
  return `${m[1]}/${m[2]}/clean`;
}

/** The URL to fetch upstream: the request URL without the worker-only `scrub` flag. */
export function upstreamUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const kept = query.split('&').filter((p) => p !== '' && p !== 'scrub' && !p.startsWith('scrub='));
  return url.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + (hash < 0 ? '' : url.slice(hash));
}

/**
 * A single `bytes=start-[end]` range (`end` inclusive, `null` = open-ended). Suffix ranges,
 * multiple ranges and anything malformed give `null`: the worker passes those through.
 */
export function parseRange(header: string | null): { start: number; end: number | null } | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d+)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  return { start, end };
}

/** `Content-Range: bytes start-end/total` (`end` inclusive); `null` for `*` forms or garbage. */
export function parseContentRange(h: string | null): { start: number; end: number; total: number } | null {
  if (!h) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(h);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (end < start || end >= total) return null;
  return { start, end, total };
}
