import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import type { Readable } from 'stream';
import { CONFIG } from '../config.js';
import { deriveUserKey, ssecHeaders } from './encryption.js';
import { recordConnectOutcome, CONNECT_TIMEOUT_MARKER } from '../utils/socketPoolWedge.js';
import { getRedis } from '../utils/redis.js';
import { invalidateMdatByBucketKey } from '../utils/mdatCache.js';
import {
  setS3AgentStatsProvider,
  observeS3Ttfb,
  recordS3ConnectTimeout,
  type S3Op,
} from '../utils/metrics.js';

let client: S3Client | null = null;
// Hoisted to module scope so the metrics layer can read live keep-alive socket
// counts off the agents (the 19→209 degradation curve). Set once in getS3Client.
let httpAgentRef: HttpAgent | null = null;
let httpsAgentRef: HttpsAgent | null = null;

/**
 * Snapshot of both agents' keep-alive pools for `clipnest_s3_agent_sockets`.
 * `sockets`/`freeSockets` are keyed by `host:port:` — collapse each key to its
 * hostname so the label stays a bounded single value per endpoint.
 */
export function getS3AgentStats(): Array<{ host: string; state: 'active' | 'free' | 'queued'; count: number }> {
  const out: Array<{ host: string; state: 'active' | 'free' | 'queued'; count: number }> = [];
  const host = (() => {
    try { return new URL(CONFIG.s3Endpoint).hostname || 'unknown'; }
    catch { return 'unknown'; }
  })();
  const tally = (pool: Record<string, unknown[]> | undefined): number =>
    Object.values(pool ?? {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
  for (const agent of [httpAgentRef, httpsAgentRef]) {
    if (!agent) continue;
    out.push({ host, state: 'active', count: tally((agent as unknown as { sockets?: Record<string, unknown[]> }).sockets) });
    out.push({ host, state: 'free', count: tally((agent as unknown as { freeSockets?: Record<string, unknown[]> }).freeSockets) });
    out.push({ host, state: 'queued', count: tally((agent as unknown as { requests?: Record<string, unknown[]> }).requests) });
  }
  return out;
}

/** Bucket an SDK command name to a bounded op family for metric labels. */
function s3OpFamily(commandName: string | undefined): S3Op {
  const n = (commandName ?? '').toLowerCase();
  if (n.startsWith('getobject')) return 'get';
  if (n.startsWith('headobject')) return 'head';
  if (n.startsWith('list')) return 'list';
  if (n.startsWith('putobject')) return 'put';
  if (n.startsWith('delete')) return 'delete';
  return 'other';
}

/**
 * Get or create the S3 client singleton.
 * Uses path-style access (required by MinIO).
 *
 * Explicit timeouts: without them a stalled TCP connection to remote object
 * storage can wedge a caller forever (e.g. thumbnail worker hanging on
 * headObject/getObject with no ffmpeg ever spawned). socketTimeout is
 * per-idle-read, so it's fine for large streamed downloads.
 */
export function getS3Client(): S3Client {
  if (!client) {
    // Socket pool. Default keepAlive is on in the SDK's NodeHttpHandler, but
    // maxSockets defaults to 50 per host — way below the delete-notify
    // consumer's 150 parallel workers across replicas. 500 was the long-term
    // baseline (added for the worker pool); an attempt to bump this
    // to 2000 OOM'd the pod under the wedge-stress reproducer because Node
    // pipeline buffers per backpressured stream + native socket-state buffers
    // scaled linearly with active sockets. The wedge fix lives elsewhere
    // (utils/s3Stream.ts slow-consumer kill); the pool sizing's job is to
    // serve the steady-state worker fan-out comfortably without making the
    // backpressure-buffer leak unbounded under burst load.
    const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 500 });
    const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 500 });
    httpAgentRef = httpAgent;
    httpsAgentRef = httpsAgent;
    setS3AgentStatsProvider(getS3AgentStats);
    client = new S3Client({
      endpoint: CONFIG.s3Endpoint,
      region: 'us-east-1', // MinIO ignores this but SDK requires it
      credentials: {
        accessKeyId: CONFIG.s3AccessKey,
        secretAccessKey: CONFIG.s3SecretKey,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        // connectionTimeout covers TCP connect + TLS handshake AND queueing
        // against the keep-alive agent's socket pool. With 3 worker pods x
        // concurrency=5 plus the startup duration-backfill loop, a tight 5s
        // cap was tripping on queued-but-not-yet-dialed requests. 15s leaves
        // margin without reintroducing the indefinite-hang failure mode.
        connectionTimeout: 15_000,
        // socketTimeout fires when a socket sees no data flow for this long.
        // Was 30 s — combined with slow consumers (a phone reading at 5 KB/s)
        // that meant each pinned socket could occupy a pool slot for tens of
        // seconds with no visible progress. 10 s is still comfortably above
        // the object store's typical inter-chunk latency on a healthy stream (sub-second)
        // but cycles wedged/idle sockets back to the agent ~3× faster, which
        // matters under the per-host `maxSockets: 500` cap during a wedge.
        // Lowered together with the per-pod /video concurrency cap in
        // middleware/concurrencyLimit.ts and the window-based wedge detector
        // in utils/socketPoolWedge.ts — see
        // tools/api-stress/scenarios/wedge-stress.js for the repro.
        socketTimeout: 10_000,
      }),
    });
    // Wedge-detector middleware. Every command sent through this client feeds
    // its success/failure into `recordConnectOutcome`, so the API + worker
    // /healthz can flip to 503 after the 10-strike streak even when the call
    // path is a fresh route the maintainer forgot to instrument manually
    // (/media-token's twin headObject calls could hang on a wedged pool while
    // a manual hook only watched the /video/:view getSidecar branch — the pod
    // stayed "healthy" the whole time).
    // Step "deserialize" runs at the bottom of the stack — after the actual
    // HTTP roundtrip, before the SDK wraps the response — which is the
    // earliest place we can see both success AND every flavour of transport
    // failure (connect timeout, socket error, 5xx response). Reset on
    // success, classify on error via the marker in socketPoolWedge.ts.
    client.middlewareStack.add(
      (next, context) => async (args) => {
        // `deserialize` sits below the HTTP round-trip, so timing next() here
        // measures send→response latency (the S3 TTFB the metrics track). The
        // op family is bucketed to a bounded label (see s3OpFamily).
        const op = s3OpFamily(context.commandName);
        const started = Date.now();
        try {
          const result = await next(args);
          recordConnectOutcome();
          observeS3Ttfb(op, (Date.now() - started) / 1000);
          return result;
        } catch (err) {
          recordConnectOutcome(err);
          observeS3Ttfb(op, (Date.now() - started) / 1000);
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(CONNECT_TIMEOUT_MARKER)) recordS3ConnectTimeout();
          throw err;
        }
      },
      { step: 'deserialize', name: 'wedgeDetector', priority: 'low' },
    );
  }
  return client;
}

/**
 * Override the S3 client (for testing).
 */
export function setS3Client(c: S3Client): void {
  client = c;
}

// ---------------------------------------------------------------------------
// Encrypted operations (require userSalt for SSE-C key derivation)
// ---------------------------------------------------------------------------

/**
 * Upload an object with SSE-C encryption.
 */
export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | Readable,
  userSalt: string,
  contentLength?: number,
): Promise<void> {
  const s3 = getS3Client();
  const userKey = deriveUserKey(CONFIG.encryptionMasterKey, userSalt);
  const ssec = ssecHeaders(userKey);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ...(contentLength !== undefined && { ContentLength: contentLength }),
    SSECustomerAlgorithm: ssec.SSECustomerAlgorithm,
    SSECustomerKey: ssec.SSECustomerKey,
    SSECustomerKeyMD5: ssec.SSECustomerKeyMD5,
  }));
}

/**
 * Download an object with SSE-C decryption.
 * Supports optional byte range for video streaming (HTTP 206).
 */
export async function getObject(
  bucket: string,
  key: string,
  userSalt: string,
  range?: string,
): Promise<{ body: Readable; contentLength?: number; contentRange?: string }> {
  const s3 = getS3Client();
  const userKey = deriveUserKey(CONFIG.encryptionMasterKey, userSalt);
  const ssec = ssecHeaders(userKey);

  const resp = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(range && { Range: range }),
    SSECustomerAlgorithm: ssec.SSECustomerAlgorithm,
    SSECustomerKey: ssec.SSECustomerKey,
    SSECustomerKeyMD5: ssec.SSECustomerKeyMD5,
  }));

  return {
    body: resp.Body as Readable,
    contentLength: resp.ContentLength,
    contentRange: resp.ContentRange,
  };
}

/**
 * Get object metadata (size, last-modified, etc.) with SSE-C.
 *
 * `lastModified` comes from S3's `Last-Modified` header — set server-side at
 * the moment of PUT and authoritative for FIFO eviction ordering. Throws if
 * S3 omitted it (which would mean the object is in a malformed state we can't
 * safely tag with `NOW()`).
 */
export async function headObject(
  bucket: string,
  key: string,
  userSalt: string,
): Promise<{ contentLength: number; lastModified: Date }> {
  const s3 = getS3Client();
  const userKey = deriveUserKey(CONFIG.encryptionMasterKey, userSalt);
  const ssec = ssecHeaders(userKey);

  const resp = await s3.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
    SSECustomerAlgorithm: ssec.SSECustomerAlgorithm,
    SSECustomerKey: ssec.SSECustomerKey,
    SSECustomerKeyMD5: ssec.SSECustomerKeyMD5,
  }));

  if (!resp.LastModified) {
    throw new Error(`HeadObject returned no LastModified for ${bucket}/${key}`);
  }

  return { contentLength: resp.ContentLength ?? 0, lastModified: resp.LastModified };
}

// ---------------------------------------------------------------------------
// Redis-cached HEAD for hot-path callers (v0.10.272, 2026-05-19)
// ---------------------------------------------------------------------------
//
// Each /video/:view request fans out to 3-5 S3 sub-calls (HEAD + sidecar +
// main getObject + optional 3-zone stitcher). The headObject sub-call is
// pure metadata (contentLength + lastModified) and the values are stable for
// the file's lifetime — videos are never mutated after upload, only deleted
// and replaced (which yields a new file_metadata id and a new s3 key). That
// makes it the most cacheable of the fan-out sub-calls.
//
// With this cache active a hot event served to 100 concurrent users does
// ONE S3 HEAD (first request) then 99 Redis GETs (sub-ms each). The
// sidecars LRU in services/sidecarCache.ts already covers the second-
// largest sub-call, so warm fan-out per /video request drops from 3-5
// to effectively 1 (the streaming getObject) + 1 brief Redis read.
// Math: 100 VU × 1 socket = 100 in flight, against pool=500 = comfy.
// Without this cache, 100 VU × 3-5 = 300-500 socket-asks = the wedge.
//
// Security note: cache key is (bucket, key) WITHOUT userSalt. This is
// safe because:
//   1. ContentLength and LastModified are S3 object metadata — they do
//      NOT vary with the SSE-C key (they describe the encrypted bytes
//      on disk, which are encryption-independent in size + mtime).
//   2. The route layer enforces ownership BEFORE calling cachedHeadObject
//      (events.ts pulls the user-scoped path via resolveS3Path), so a
//      user can never request a (bucket, key) they don't own.
//
// Failure semantics:
//   - Redis blip on GET → fall through to S3 (no error surfaced).
//   - Redis blip on SET → silently skip caching (no error surfaced).
//   - S3 error → propagated as before. The cache is best-effort.
const HEAD_OBJECT_CACHE_TTL_S = parseInt(
  process.env.HEAD_OBJECT_CACHE_TTL_S || '3600',
  10,
);

interface CachedHeadValue {
  contentLength: number;
  lastModifiedIso: string;
}

export async function cachedHeadObject(
  bucket: string,
  key: string,
  userSalt: string,
): Promise<{ contentLength: number; lastModified: Date }> {
  const cacheKey = `s3:head:${bucket}:${key}`;
  const redis = getRedis();

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const v = JSON.parse(cached) as CachedHeadValue;
      return { contentLength: v.contentLength, lastModified: new Date(v.lastModifiedIso) };
    }
  } catch (err) {
    // Redis blip — log once at debug volume, then fall through to S3.
    // Don't fail the request just because the cache is down.
    console.warn(`[s3 cache] redis GET failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fresh = await headObject(bucket, key, userSalt);

  try {
    const payload: CachedHeadValue = {
      contentLength: fresh.contentLength,
      lastModifiedIso: fresh.lastModified.toISOString(),
    };
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', HEAD_OBJECT_CACHE_TTL_S);
  } catch (err) {
    // Best-effort cache write. Caller already has fresh value.
    console.warn(`[s3 cache] redis SET failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return fresh;
}

/**
 * Invalidate the cached HEAD for a (bucket, key) — call after a delete or
 * an in-place file replacement (rare; usually a replacement gets a new
 * file_metadata id and a new s3 key, which makes the old cache entry
 * unreachable naturally). Idempotent; ignores redis errors.
 */
export async function invalidateCachedHeadObject(bucket: string, key: string): Promise<void> {
  try {
    await getRedis().del(`s3:head:${bucket}:${key}`);
  } catch {
    // Ignored — see cachedHeadObject failure semantics.
  }
}

// ---------------------------------------------------------------------------
// Unencrypted operations (no SSE-C key needed)
// ---------------------------------------------------------------------------

/**
 * Delete an object. No SSE-C key needed for deletion.
 *
 * v0.10.274: also invalidates the in-process `mdatCache` and the Redis
 * `cachedHeadObject` entry for this (bucket, key). Without invalidation
 * the LRU would keep serving the deleted file's bytes from memory until
 * the entry naturally aged out, which is fine for /video routes (the
 * deleted event won't be referenced from the UI anyway), but defensive
 * cleanup keeps the caches honest with the storage layer.
 *
 * Both invalidations are best-effort — a Redis blip or an LRU miss
 * doesn't fail the delete itself.
 */
export async function deleteObject(
  bucket: string,
  key: string,
): Promise<void> {
  const s3 = getS3Client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  invalidateMdatByBucketKey(bucket, key);
  await invalidateCachedHeadObject(bucket, key);
}

/**
 * List every in-progress (incomplete/aborted) multipart upload in a bucket.
 * These consume storage but are INVISIBLE to ListObjectsV2 — only this API
 * surfaces them. The object store may have no lifecycle rules to auto-expire
 * them, so they accumulate from interrupted FTPS STORs (pod OOM, restart,
 * client disconnect) until aborted. Paginates internally. No SSE-C key needed.
 */
export async function listMultipartUploads(
  bucket: string,
): Promise<{ key: string; uploadId: string; initiated?: Date }[]> {
  const s3 = getS3Client();
  const out: { key: string; uploadId: string; initiated?: Date }[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const resp = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1000,
    }));
    for (const u of resp.Uploads ?? []) {
      if (u.Key && u.UploadId) out.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated });
    }
    keyMarker = resp.IsTruncated ? resp.NextKeyMarker : undefined;
    uploadIdMarker = resp.IsTruncated ? resp.NextUploadIdMarker : undefined;
  } while (keyMarker);
  return out;
}

/**
 * Abort one incomplete multipart upload, discarding its orphaned parts. Safe:
 * an incomplete MPU never became a real object, and a completed object with the
 * same key is a separate entity untouched by this. No SSE-C key needed.
 */
export async function abortMultipartUpload(
  bucket: string,
  key: string,
  uploadId: string,
): Promise<void> {
  const s3 = getS3Client();
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

/**
 * Delete every object under a prefix, batching up to 1000 keys per request
 * (S3 DeleteObjects hard limit). Returns the number of objects removed.
 *
 * Used by the user-deletion worker: recordings live under `{userUuid}/` and
 * thumbnails under `{userUuid}/__generated__/`. The caller invokes this once
 * per bucket per user; we do not assume the prefix only contains one user's
 * data (callers must pass a user-scoped prefix).
 */
export async function deleteObjectsByPrefix(
  bucket: string,
  prefix: string,
): Promise<number> {
  const s3 = getS3Client();
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    const keys = (page.Contents ?? [])
      .map(o => o.Key)
      .filter((k): k is string => typeof k === 'string');

    if (keys.length > 0) {
      // S3 DeleteObjects returns 200 even when individual keys fail (access
      // denied, transient backend error, etc.) — per-key errors land in
      // `response.Errors`. With Quiet: true the response body omits the
      // per-key Deleted list but still surfaces Errors. Throwing on a
      // non-empty Errors lets the caller's try/catch (e.g. the user-deletion
      // worker) surface the failure and retry on the next tick instead of
      // proceeding to hardDeleteUser and orphaning the survivors in S3
      // (objects under a hard-deleted user's prefix would otherwise stay
      // behind because this function silently dropped per-key errors).
      const resp = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
      }));
      const errors = resp.Errors ?? [];
      if (errors.length > 0) {
        const sample = errors.slice(0, 3)
          .map(e => `${e.Key}: ${e.Code ?? '?'}: ${e.Message ?? '?'}`)
          .join(' | ');
        throw new Error(
          `deleteObjectsByPrefix: ${errors.length}/${keys.length} keys failed in ` +
          `bucket=${bucket} prefix=${prefix} — sample: ${sample}`,
        );
      }
      deleted += keys.length;

      // v0.10.274: drop cache entries for deleted keys. Same logic as
      // single-key deleteObject above — the LRU would naturally age these
      // out but that's seconds-to-hours of stale-byte risk. For a
      // user-deletion sweep we want the cache and S3 to agree as soon as
      // the delete returns. Loop body is two cheap operations per key
      // (in-memory LRU iterate + Redis DEL); the outer batch is already
      // bounded at 1000 keys so this stays sub-second.
      for (const k of keys) {
        invalidateMdatByBucketKey(bucket, k);
      }
      await Promise.all(keys.map((k) => invalidateCachedHeadObject(bucket, k)));
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

/**
 * Stream objects under a prefix as an async iterator. Use this when callers
 * fold the listing into a sum / Set / membership predicate — `listObjects`
 * (below) collects up to 500k entries in memory before returning, which is
 * a real concern for the storage reconciler's full-bucket pass. Each yielded
 * object is dropped as soon as the consumer's
 * iteration body completes, so peak memory is one S3 page (~1000 keys)
 * rather than the entire bucket.
 *
 * Pagination is internal; the iterator stops when S3 reports `IsTruncated:
 * false`. No SSE-C key needed.
 */
export async function* listObjectsStream(
  bucket: string,
  prefix: string,
): AsyncGenerator<{ key: string; size: number; lastModified?: Date }> {
  const s3 = getS3Client();
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (obj.Key) {
          yield { key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified };
        }
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * List objects under a prefix. No SSE-C key needed for listing.
 * Returns all keys (handles pagination internally). Capped at 500k to keep
 * peak RAM bounded — for callers that don't need the whole list in memory,
 * use `listObjectsStream` instead.
 */
export async function listObjects(
  bucket: string,
  prefix: string,
): Promise<{ key: string; size: number; lastModified?: Date }[]> {
  const s3 = getS3Client();
  const results: { key: string; size: number; lastModified?: Date }[] = [];
  let continuationToken: string | undefined;
  const MAX_KEYS = 500_000;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (obj.Key) {
          results.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified,
          });
        }
      }
    }

    if (results.length >= MAX_KEYS) {
      console.warn(`listObjects: truncated at ${MAX_KEYS} keys for prefix ${prefix}`);
      break;
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return results;
}

/**
 * Like listObjects but passes S3's StartAfter on the FIRST page. Subsequent
 * pages use ContinuationToken normally. S3 returns keys in lexicographic
 * order, so for prefix `{uuid}/YYYY/MM/DD/...` this yields only keys
 * strictly greater than startAfter — the delta path.
 */
export async function listObjectsAfter(
  bucket: string,
  prefix: string,
  startAfter: string | undefined,
): Promise<{ key: string; size: number; lastModified?: Date }[]> {
  const s3 = getS3Client();
  const results: { key: string; size: number; lastModified?: Date }[] = [];
  let continuationToken: string | undefined;
  const MAX_KEYS = 500_000;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      StartAfter: continuationToken ? undefined : startAfter,
      ContinuationToken: continuationToken,
    }));
    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (obj.Key) results.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified,
        });
      }
    }
    if (results.length >= MAX_KEYS) {
      console.warn(`listObjectsAfter: truncated at ${MAX_KEYS} keys for prefix ${prefix}`);
      break;
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return results;
}

/**
 * List the S3 objects belonging to a single event in the recordings bucket.
 *
 * An event's files can land in any of three path shapes:
 *   1. `{uuid}/YYYY/MM/DD/CameraName_View_Timestamp.ext`  (canonical, scanner-built)
 *   2. `{uuid}/CameraName_View_Timestamp.ext`             (root-dir upload)
 *   3. `{uuid}/YYYY/MM/DD/...` but YYYY/MM/DD ≠ canonical (camera clock skew)
 *
 * To cover cases 2 and 3 without a full user-prefix scan, this function probes
 * the canonical date prefix first (cheap happy path) and falls back to a user
 * scan only when nothing matches. Filters in-process by the 14-digit timestamp.
 *
 * No SSE-C key needed (listing is unencrypted).
 */
export async function listEventFiles(
  bucket: string,
  userUuid: string,
  dateStr: string, // "YYYY/MM/DD" — the canonical event date (derived from filename timestamp)
  camera: string,
  tsRaw: string,   // 14-digit timestamp, e.g. "20260412143000"
  opts: { skipFallback?: boolean } = {},
): Promise<string[]> {
  const match = (key: string): boolean => {
    const filename = key.split('/').pop() ?? '';
    return filename.startsWith(`${camera}_`) && filename.includes(`_${tsRaw}.`);
  };

  const canonicalPrefix = `${userUuid}/${dateStr}/${camera}_`;
  const canonical = await listObjects(bucket, canonicalPrefix);
  const canonicalHits = canonical.map(o => o.key).filter(match);
  if (canonicalHits.length > 0) return canonicalHits;

  // Fallback: file lives in root or a wrong-dated folder. Listing under the
  // user prefix is O(total user keys). On a user with thousands of recordings
  // that's the single biggest cost in the delete-notify hot path, so the
  // caller must opt in when it can't live with a canonical-only answer.
  if (opts.skipFallback) return [];
  const userObjects = await listObjects(bucket, `${userUuid}/`);
  return userObjects.map(o => o.key).filter(match);
}
