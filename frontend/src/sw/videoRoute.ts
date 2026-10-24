import type { RangeCache } from './rangeCache';
import { parseContentRange, parseRange, upstreamUrl, videoCacheKey } from './videoRequest';

/**
 * Most bytes one response carries, explicit ranges included (Safari asks for the whole file
 * in one range; WebKit, Chrome and Firefox all accept a short 206 and ask for the rest).
 */
export const RESPONSE_CAP = 4 * 1024 * 1024;
/** Upstream bytes are stored in pieces of this size (the last piece of a response is shorter). */
export const PIECE_BYTES = 256 * 1024;

function isPreviewUrl(url: string): boolean {
  const q = url.indexOf('?');
  return q >= 0 && url.slice(q + 1).split('&').includes('scrub=1');
}

/** `url` with the worker-only `scrub=1` flag, which marks a preview read (low priority). */
export function withScrubFlag(url: string): string {
  return isPreviewUrl(url) ? url : `${url}${url.includes('?') ? '&' : '?'}scrub=1`;
}

function memoryResponse(start: number, bytes: Uint8Array, total: number, contentType: string): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`,
      'Content-Length': String(bytes.length),
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Answers a clean-video request from the in-memory cache, fetching what is missing upstream.
 * Anything that is not a single-range clean-video request is fetched unchanged.
 *
 * A cache hit never reaches the server, so it skips the per-request checks the API makes
 * (an expired media token, ACCOUNT_LOCKED, transfer accounting). That is deliberate: the key
 * leaves the token out so a refreshed token reuses the bytes, and those bytes were fetched
 * with a valid token by this browser. They live only in memory, until the player drops the
 * recording, the cache is wiped (sign-out) or the worker stops.
 */
export async function handleVideoRequest(req: Request, cache: RangeCache, fetchImpl: typeof fetch): Promise<Response> {
  const key = videoCacheKey(req.url);
  const header = req.headers.get('Range');
  const parsed = parseRange(header);
  if (!key || (header !== null && !parsed)) return fetchImpl(req);
  const { start, end } = parsed ?? { start: 0, end: null };

  // 1. From memory, when the (capped) range is fully cached, or a cached prefix of at least
  //    one piece is: engines accept a short 206 and ask for the rest. A tiny prefix (Safari's
  //    `0-1` probe) is not answered alone — the main load request then goes upstream instead
  //    of getting a 2-byte reply; `put` drops the bytes already cached.
  const meta = cache.meta(key);
  if (meta && start < meta.total) {
    const wantEnd = Math.min(end === null ? Infinity : end + 1, start + RESPONSE_CAP, meta.total);
    const have = cache.contiguousFrom(key, start, wantEnd - start);
    const enough = have > 0 && (have === wantEnd - start || have >= PIECE_BYTES);
    const bytes = enough ? cache.read(key, start, start + have) : null;
    if (bytes) return memoryResponse(start, bytes, meta.total, meta.contentType);
  }

  // 2. Upstream, stopping at the cap, at the end of the file and before the next cached piece.
  let cappedEnd = Math.min(end ?? Infinity, start + RESPONSE_CAP - 1);
  if (meta && start < meta.total) cappedEnd = Math.min(cappedEnd, meta.total - 1);
  const next = cache.ranges(key).find((r) => r.start > start);
  if (next) cappedEnd = Math.min(cappedEnd, next.start - 1);
  const stamp = cache.stamp(key); // a drop/wipe/reset during the await invalidates this fetch
  const upstream = await fetchImpl(upstreamUrl(req.url), {
    headers: { Range: `bytes=${start}-${cappedEnd}` },
    priority: isPreviewUrl(req.url) ? 'low' : 'high',
    signal: req.signal,
    credentials: 'same-origin',
  });

  // 3. Only a well-formed 206 is cached; anything else goes back to the page as it came.
  if (upstream.status !== 206 || !upstream.body) return upstream;
  const cr = parseContentRange(upstream.headers.get('Content-Range'));
  if (!cr) return upstream;
  if (cache.stamp(key) !== stamp) return upstream;
  if (cache.setMeta(key, cr.total, upstream.headers.get('Content-Type') ?? 'video/mp4') === 'reset') return upstream;
  const gen = cache.stamp(key);

  // 4. Tee: every chunk goes to the page and is copied into the cache in PIECE_BYTES pieces.
  //    If the page cancels, the upstream read is cancelled and what arrived is kept.
  const reader = upstream.body.getReader();
  let pos = cr.start;
  let piece = new Uint8Array(PIECE_BYTES);
  let fill = 0;
  const flush = () => {
    if (fill === 0) return;
    cache.put(key, pos, fill === PIECE_BYTES ? piece : piece.slice(0, fill), gen);
    pos += fill;
    piece = new Uint8Array(PIECE_BYTES);
    fill = 0;
  };
  const keep = (chunk: Uint8Array) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(PIECE_BYTES - fill, chunk.length - off);
      piece.set(chunk.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === PIECE_BYTES) flush();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          flush();
          controller.close();
          return;
        }
        keep(value);
        controller.enqueue(value);
      } catch (err) {
        flush();
        controller.error(err);
      }
    },
    cancel(reason) {
      flush();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: 206, statusText: upstream.statusText, headers: upstream.headers });
}

/**
 * The worker's answer to a clean-video request: `handleVideoRequest`, and when that throws
 * (a bug in the cache path, an upstream fetch that rejects) the original request straight to
 * the network, as if no worker were installed. An aborted request rejects there too.
 */
export function respondVideo(req: Request, cache: RangeCache, fetchImpl: typeof fetch): Promise<Response> {
  return handleVideoRequest(req, cache, fetchImpl).catch(() => fetchImpl(req));
}

/**
 * Pulls `[start, end)` of `url` (absolute) into the cache at preview priority. Resolves
 * `true` once it is cached (or was already), `false` on an error, a non-206 or an abort.
 */
export async function prefetchIntoCache(
  url: string, start: number, end: number, cache: RangeCache, fetchImpl: typeof fetch, signal: AbortSignal,
): Promise<boolean> {
  const key = videoCacheKey(url);
  if (!key || end <= start) return false;
  const previewUrl = withScrubFlag(url);
  const stamp = cache.stamp(key);
  let pos = start;
  try {
    for (;;) {
      // Aborted, or the recording was dropped/wiped/replaced meanwhile: stop refilling it.
      if (signal.aborted || cache.stamp(key) !== stamp) return false;
      const total = cache.meta(key)?.total;
      const stop = total === undefined ? end : Math.min(end, total);
      if (pos >= stop) return true;
      const have = cache.contiguousFrom(key, pos, stop - pos);
      if (have > 0) {
        pos += have;
        continue;
      }
      const res = await handleVideoRequest(
        new Request(previewUrl, { headers: { Range: `bytes=${pos}-${stop - 1}` }, signal }), cache, fetchImpl,
      );
      const cr = parseContentRange(res.headers.get('Content-Range'));
      if (res.status !== 206 || !cr) {
        await res.body?.cancel();
        return false;
      }
      await res.arrayBuffer();
      // An upstream that answers a range ending at or before `pos` would loop forever.
      if (cr.end + 1 <= pos) return false;
      pos = cr.end + 1;
    }
  } catch {
    return false;
  }
}

/**
 * Wraps `fn(key)` so it runs at most once per `intervalMs` for each key: the first call runs
 * at once, later calls inside the window collapse into one trailing run.
 */
export function throttlePerKey(fn: (key: string) => void, intervalMs: number): (key: string) => void {
  const state = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: boolean }>();
  const open = (key: string) => {
    const timer = setTimeout(() => {
      const s = state.get(key);
      state.delete(key);
      if (s?.pending) {
        fn(key);
        open(key);
      }
    }, intervalMs);
    state.set(key, { timer, pending: false });
  };
  return (key: string) => {
    const s = state.get(key);
    if (s) {
      s.pending = true;
      return;
    }
    fn(key);
    open(key);
  };
}
