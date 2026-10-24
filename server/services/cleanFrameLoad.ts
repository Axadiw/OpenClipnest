/**
 * Loading of the `.clean_frame` sidecar for the `?fmt=clean` serve path: the object-store
 * fetch with its retry, the permanent-miss vs transient-error distinction the route depends
 * on, and the in-process cache in front of both (see cleanFrameSidecarCache.ts).
 */
import { CONFIG } from '../config.js';
import { getObject } from './s3.js';
import { unpackCleanFrameSidecar, type CleanFrameSidecarData } from './mp4/cleanFrameSidecar.js';
import { cleanFrameSidecarCache } from './cleanFrameSidecarCache.js';

/** Discriminates a permanent NoSuchKey/404 from a transient S3 error. */
export function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const msg = err instanceof Error ? err.message : String(err);
  return Boolean(
    (e.name && /NoSuchKey|NotFound/i.test(e.name)) ||
    (e.Code && /NoSuchKey|NotFound/i.test(e.Code)) ||
    e.$metadata?.httpStatusCode === 404 ||
    /specified key does not exist|NoSuchKey|status code: 404/i.test(msg),
  );
}

/**
 * Fetch + unpack the `.clean_frame` sidecar for a file, with a short retry on
 * TRANSIENT S3 errors (the sidecars bucket is hot and sporadically 503s). The
 * blob is small (~KB) and read fully into memory before unpacking, so retrying
 * the whole fetch is safe.
 *
 * Why the retry matters (CLEAN-FRAME-SIZE-MISMATCH-502): the web player always
 * requests `?fmt=clean`. When this fetch intermittently fails, the GET handler
 * used to silently fall through to the non-clean path, which advertises the
 * ORIGINAL size instead of the (smaller) clean servedSize. The total then flips
 * between requests, the browser seeks past the clean EOF, and the tail range
 * 416s/resets → nginx 502 ("can't play the last ~2 s"). Reliable loading keeps
 * a sidecar'd file on ONE consistent size.
 *
 * Throws with `isS3NotFound(err) === true` for a genuine miss (caller may fall
 * through to the non-clean path — a sidecar-less file is consistently served at
 * the original size on every request); throws the last transient error after
 * the retries are exhausted (caller returns a retryable 503, never a
 * different-size body).
 */
async function fetchCleanFrameSidecar(s3Key: string, userSalt: string): Promise<CleanFrameSidecarData> {
  const cfKey = `${s3Key}.clean_frame`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { body } = await getObject(CONFIG.s3SidecarsBucket, cfKey, userSalt);
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk as Buffer);
      return unpackCleanFrameSidecar(Buffer.concat(chunks));
    } catch (err) {
      if (isS3NotFound(err)) throw err; // permanent — don't retry
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const cacheKey = (bucket: string, s3Key: string): string => `${bucket}/${s3Key}`;

const envInt = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The longest a cache miss waits for the original to be warmed, in ms. 0 turns the warm-up off. */
const WARM_CAP_MS = envInt('CLEAN_FRAME_WARM_CAP_MS', 1500);

/**
 * Touch the original recording with a 16-byte read, alongside the sidecar fetch.
 *
 * Why: on a remote object store the first read of an object that has not been read lately is
 * slow (0.3-0.5 s, p90 about 1 s) and the next read of the same object is fast (50-80 ms). A
 * tiny read pays that first-read cost for the object as a whole: a 256 KiB read right after
 * one took about 70 ms instead of about 490 ms. The route needs the sidecar first (it says
 * which byte runs to gather) and only then reads the data, so without this the two cold reads
 * run one after the other. Starting the touch together with the sidecar fetch makes them
 * overlap. On cold clips the time to the first data byte went from 855-1036 ms to 699-733 ms
 * (p50) and from 1.8-1.9 s to 1.2-1.5 s (p90).
 *
 * It only runs on a cache miss (a hit means the clip was played a moment ago, so it is warm),
 * costs one extra tiny GET per miss, and never rejects: a warm-up must not fail a request.
 */
async function touchOriginal(bucket: string, s3Key: string, userSalt: string): Promise<void> {
  try {
    const { body } = await getObject(bucket, s3Key, userSalt, 'bytes=0-15');
    // Drain it so the connection goes back to the pool.
    for await (const chunk of body as AsyncIterable<Buffer>) void chunk;
  } catch {
    // Best effort.
  }
}

/** Wait for `p`, but never longer than `ms`. */
async function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
  clearTimeout(timer);
}

/**
 * The sidecar for a recording, from the cache when it is there. Same contract as the fetch
 * above (a permanent miss and a transient failure both throw, and neither is cached).
 *
 * On a miss the original is warmed in parallel (see touchOriginal) and the result is returned
 * once both are done, or once the warm-up has had WARM_CAP_MS. A failed sidecar fetch does not
 * wait for the warm-up.
 *
 * A recording that has no sidecar is reported to the metrics as `absent` (see the cache), not as
 * a miss: it is the permanent-miss case above, which the cache never stores.
 */
export function loadCleanFrameSidecar(bucket: string, s3Key: string, userSalt: string): Promise<CleanFrameSidecarData> {
  return cleanFrameSidecarCache.get(cacheKey(bucket, s3Key), async () => {
    // Started first and not awaited yet, so it overlaps the sidecar fetch. It never rejects.
    const warm = WARM_CAP_MS > 0 ? touchOriginal(bucket, s3Key, userSalt) : undefined;
    const sidecar = await fetchCleanFrameSidecar(s3Key, userSalt);
    if (warm) await settleWithin(warm, WARM_CAP_MS);
    return sidecar;
  }, isS3NotFound);
}
