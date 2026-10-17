/**
 * In-process LRU cache for fmp4 patch sidecars (~5 KB each, keyed by
 * `file_metadata.id`). Hot path = stream-start: we look up the sidecar
 * here before falling back to a Range GET against the sidecars S3 bucket.
 *
 * Why in-process and not Redis: the values are immutable per file_metadata
 * id (a sidecar is regenerated only when its file_metadata row is replaced,
 * which means a new id), and a 5 KB blob via Redis costs ~500 µs per read
 * versus ~50 µs for an in-process Map lookup. For a single-machine
 * deployment the local cache is strictly better; on multi-node we'd swap
 * for a Redis layer but the call site stays the same.
 *
 * Cap defaults to 50k entries / 250 MB RAM (configurable via env). LRU
 * eviction keeps memory bounded under any traffic pattern.
 *
 * Concurrent miss dedup: if N requests for the same uncached id arrive
 * simultaneously, we fire ONE S3 GET and have everyone await the same
 * Promise. Without this dedup, a popular freshly-published event hit by 10
 * viewers would trigger 10 redundant S3 GETs in the cold-cache window.
 */
import { LRUCache } from 'lru-cache';
import type { Readable } from 'stream';
import { Buffer } from 'buffer';
import { CONFIG } from '../config.js';
import { getObject } from './s3.js';

const MAX_ENTRIES = parseInt(
  process.env.SIDECAR_CACHE_MAX_ENTRIES || '50000',
  10,
);
const MAX_BYTES = parseInt(
  process.env.SIDECAR_CACHE_MAX_BYTES || String(250 * 1024 * 1024),
  10,
);
// Defensive bound on a single sidecar blob — a Reolink sidecar is ~5 KB,
// 1 MB is wildly above any realistic upper bound (would mean 50k+
// fragments). If we ever pull something this big it's almost certainly
// data corruption.
const MAX_SIDECAR_BYTES = 1024 * 1024;

const cache = new LRUCache<number, Buffer>({
  max: MAX_ENTRIES,
  maxSize: MAX_BYTES,
  sizeCalculation: (buf) => buf.length,
});

const inflight = new Map<number, Promise<Buffer>>();

/**
 * Drain a Readable into a Buffer. Bounded by `MAX_SIDECAR_BYTES`.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_SIDECAR_BYTES) {
      throw new Error(
        `sidecarCache: sidecar exceeded ${MAX_SIDECAR_BYTES} bytes (corrupted?)`,
      );
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

export interface SidecarCoords {
  /** primary key in `file_metadata`. Stable across the file's lifetime. */
  fileMetadataId: number;
  /** original mp4 S3 key — sidecar lives at `<this>.fmp4patch` */
  s3Key: string;
  /** SSE-C salt for the owning user — sidecars share the user's salt. */
  userSalt: string;
}

/**
 * Resolve the sidecar bytes for a file. RAM hit on hot path; S3 GET on
 * cold path; awaiting the same Promise on duplicate concurrent misses.
 *
 * Throws on S3 transport errors so the caller (video route) can return
 * 503/Retry-After. Callers should NOT cache the failure — a transient S3
 * blip should not poison the entry forever.
 */
export async function getSidecar(coords: SidecarCoords): Promise<Buffer> {
  const cached = cache.get(coords.fileMetadataId);
  if (cached) return cached;

  const existing = inflight.get(coords.fileMetadataId);
  if (existing) return existing;

  const sidecarKey = `${coords.s3Key}.fmp4patch`;
  const promise = (async () => {
    const { body } = await getObject(
      CONFIG.s3SidecarsBucket,
      sidecarKey,
      coords.userSalt,
    );
    return streamToBuffer(body as Readable);
  })()
    .then((buf) => {
      cache.set(coords.fileMetadataId, buf);
      return buf;
    })
    .finally(() => {
      inflight.delete(coords.fileMetadataId);
    });
  inflight.set(coords.fileMetadataId, promise);
  return promise;
}

/**
 * Invalidate a cache entry (called when a file is deleted or its
 * file_metadata row is dropped). Idempotent.
 */
export function invalidateSidecar(fileMetadataId: number): void {
  cache.delete(fileMetadataId);
  // No need to touch inflight — those resolve naturally and the .set call
  // above is harmless even after a delete (it'd just re-populate, but the
  // delete-after-fetch race is OK because the next call would refetch).
}
