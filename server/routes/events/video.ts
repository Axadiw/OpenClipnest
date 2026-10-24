import { Router, type Request, type Response } from 'express';
import type { Readable, Writable } from 'stream';
import { Buffer } from 'buffer';
import {
  getEventByIdForOwner,
  getFileMetadataByKey,
  getPlaybackPatchState,
} from '../../db/queries/events.js';
import {
  updateTransferUsage,
  checkAndResetTransfer,
  getUserQuota,
} from '../../db/queries/storage.js';
import { getUserByInternalId } from '../../db/queries/users.js';
import { getObject, cachedHeadObject } from '../../services/s3.js';
import { resolveS3Path } from '../../utils/s3path.js';
import { decideThrottle, buildThrottleStream } from '../../services/quota-throttle.js';
import { mediaRateLimit } from '../../middleware/rateLimit.js';
import { videoConcurrencyCap } from '../../middleware/concurrencyLimit.js';
import { getSidecar, invalidateSidecar } from '../../services/sidecarCache.js';
import { inspectMoov } from '../../services/mp4/moov.js';
import { patchPreludeMvhdDuration } from '../../services/mp4/moovPatch.js';
import { parseMfraEntries, shiftMfraOffsets, buildSidx, computeSidxSize } from '../../services/mp4/seekTables.js';
import { parseSidecar } from '../../services/mp4/sidecar.js';
import {
  pipeS3ToResponse,
  pipeS3IntoSink,
  pipeThrottleToResponse,
  attachSlowConsumerMonitor,
  SLOW_CONSUMER_ERROR_MESSAGE,
} from '../../utils/s3Stream.js';
import { getCachedMdat, buildMdatCacheKey } from '../../utils/mdatCache.js';
import {
  observeStreamThroughput,
  originFor,
  recordSlowConsumerKill,
  recordVideoServeFailure,
  type VideoPath,
} from '../../utils/metrics.js';
import { patchAudioStts } from '../../services/mp4/audioStts.js';
import { readBoxHeader } from '../../services/mp4/boxes.js';
import { CONFIG } from '../../config.js';
import type { CleanFrameSidecarData } from '../../services/mp4/cleanFrameSidecar.js';
import { loadCleanFrameSidecar, isS3NotFound } from '../../services/cleanFrameLoad.js';
import { requireUnlockedAccount } from '../../middleware/accountAccess.js';
import {
  cleanFrameLayout,
  cleanFrameMaxSrcEnd,
  payloadRangeToOriginalRanges,
  coalesceOriginalRanges,
  createGapSkipTransform,
} from '../../services/mp4/cleanFrameServe.js';

export const videoRouter = Router();

/**
 * Helper: get the user's encryption salt from DB.
 */
async function getUserSalt(userId: number): Promise<string | undefined> {
  const user = await getUserByInternalId(userId);
  return user?.encryptionSalt;
}

/**
 * The authoritative served size of the `?fmt=clean` response for a file, or
 * `null` when no usable clean sidecar exists (genuine miss, OR a STALE sidecar
 * that references bytes past the current original — see cleanFrameMaxSrcEnd).
 * HEAD uses this so it advertises the SAME total the clean GET serves; falling
 * back to the original `fileSize` only when there is no clean body to serve.
 */
async function cleanFrameServedSize(
  bucket: string,
  s3Key: string,
  userSalt: string,
  fileSize: number,
): Promise<number | null> {
  try {
    const sidecar = await loadCleanFrameSidecar(bucket, s3Key, userSalt);
    if (cleanFrameMaxSrcEnd(sidecar.byteRanges) > fileSize) return null; // stale
    return cleanFrameLayout(sidecar.prelude.length, sidecar.mdatHeader.length, sidecar.byteRanges).servedSize;
  } catch {
    return null;
  }
}

/**
 * Stitch a "virtual" fmp4 from three byte sources: the synthesized prelude
 * (ftyp + patched moov, durations written in-place — same size as original),
 * the original mp4's mdat zone passed through from S3, and the synthesized
 * mfra suffix. Browsers and native players see a spec-compliant fragmented
 * MP4 with declared total duration + a seek table, even though we never
 * modified the source object.
 *
 * The patched moov is byte-identical in length to the original. We MUST
 * preserve that — Reolink's tfhd uses `base_data_offset` flag (0x000001)
 * with absolute file positions; any shift in moov size would invalidate
 * every moof and Chrome would fail audio decode at sample 0.
 *
 * Layout math (origSize = file size on S3, prelude/mfra come from sidecar):
 *   origMoovEnd = ftypSize + origMoovSize = preludeLen
 *   mdatZoneLen = origSize - origMoovEnd
 *   virtualSize = preludeLen + mdatZoneLen + mfraLen = origSize + mfraLen
 *
 * Range requests against [A, B] in virtual space hit up to three physical
 * sources. Each source is written sequentially through one quota-throttled
 * stream that pipes to the response.
 */
async function streamPatchedMp4(args: {
  res: Response;
  bucket: string;
  s3Key: string;
  userSalt: string;
  origSize: number;
  prelude: Buffer;
  /**
   * Segment Index Box bytes — injected between prelude and mdat zone so
   * Chrome's media engine learns every fragment's offset+size+duration in
   * one shot, instead of bisecting moof-by-moof. Caller pre-computes from
   * `parseMfraEntries(mfra)` + this file's S3 size; see the call site for
   * the shifted-coord arithmetic. Pass an empty buffer to disable sidx
   * injection (e.g. for backwards-compat smoke tests).
   */
  sidx: Buffer;
  mfra: Buffer;
  range: string | undefined;
  throttleBps: number | null;
  userId: number;
  /**
   * Report the byte count this call will stream to the per-request transfer
   * meter (see the GET /video/:view handler). Called once, right after the
   * status/headers are written. The handler's single finish/close listener
   * does the actual updateTransferUsage — so a mid-stream abort still bills the
   * bytes that reached the client, and this path never double-bills.
   */
  reportBytes?: (n: number) => void;
}): Promise<void> {
  const {
    res, bucket, s3Key, userSalt, origSize, prelude, sidx, mfra, range, throttleBps, userId, reportBytes,
  } = args;

  const preludeLen = prelude.length;
  const sidxLen = sidx.length;
  const mfraLen = mfra.length;
  // The patched moov has the same length as the original (durations are
  // written in-place into existing mvhd/tkhd/mdhd fields), so the original
  // mdat zone starts exactly where the prelude ends in S3 coords.
  const origMoovEnd = preludeLen;
  const mdatZoneLen = origSize - origMoovEnd;
  if (mdatZoneLen < 0) {
    throw new Error(`stitch: origSize ${origSize} < origMoovEnd ${origMoovEnd}`);
  }
  // Response layout: [prelude (zone 1)][sidx (zone 2)][mdat S3 pass-through (zone 3)][mfra (zone 4)].
  const virtualSize = preludeLen + sidxLen + mdatZoneLen + mfraLen;

  let start = 0;
  let end = virtualSize - 1;
  let isPartial = false;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : virtualSize - 1;
    // RFC 7233 §2.1: clamp an end past EOF to the last byte rather than 416.
    // `virtualSize` is the stitched response size (prelude+sidx+mdat+mfra), so
    // the same off-by guard the pass-through path needs applies here too.
    end = Math.min(end, virtualSize - 1);
    if (isNaN(start) || start < 0 || start >= virtualSize || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${virtualSize}` });
      res.end();
      return;
    }
    isPartial = true;
  }

  const totalBytes = end - start + 1;
  res.writeHead(isPartial ? 206 : 200, {
    ...(isPartial && { 'Content-Range': `bytes ${start}-${end}/${virtualSize}` }),
    'Accept-Ranges': 'bytes',
    'Content-Length': totalBytes,
    'Content-Type': 'video/mp4',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  reportBytes?.(totalBytes);

  const throttle = buildThrottleStream(throttleBps);
  // pipeThrottleToResponse, not a raw throttle.pipe(res): the raw pipe leaves a
  // close/finish/error/unpipe listener on `res` that never gets removed, and
  // those accumulate toward the MaxListenersExceededWarning (Sentry CLIPNEST-
  // BACKEND-JN/JM). The helper strips exactly the pipe-added listeners once the
  // throttle drains. See utils/s3Stream.ts.
  pipeThrottleToResponse(throttle, res);

  // Slow-consumer kill (v0.10.274 follow-up to the v0.10.273 architectural
  // fix). With `mdatCache` resident the typical request path is in-memory
  // only and a slow client merely backpressures the throttle — releasing
  // them on detection just frees the Buffer slice. The case where this
  // matters operationally is the oversized-file fallback path (zone 3 below
  // when `getCachedMdat` returns null), which holds a real S3 socket open
  // until the client drains. Without slow-kill there, one phone on bad 4G
  // pulling a >50 MB file pins a keep-alive socket for tens of seconds.
  // Destroying `throttle` cascades through `throttle.pipe(res)` (response
  // closes half-written, client sees TCP RST) AND through the optional
  // `pipeS3IntoSink` below (sink errors, source `body.destroy()` fires,
  // socket returns to agent pool).
  const stopSlowMonitor = attachSlowConsumerMonitor(res, (rateKbps) => {
    // Log at info-level (not warn): the kill is intentional, expected
    // behaviour for clients on bad networks — its job is to keep the S3
    // keep-alive pool healthy. Sentry's captureConsoleIntegration in
    // server/sentry.ts pipes warn+error to Sentry, so a warn here surfaces
    // every slow-client disconnect as a discrete telemetry issue (hundreds of
    // events from one user's camera, all the same kill firing on each
    // reconnect). console.log keeps the diagnostic in the service logs
    // without polluting Sentry.
    console.log(`[streamPatchedMp4] slow consumer killed: ${rateKbps.toFixed(1)} KB/s`);
    recordSlowConsumerKill('patched');
    if (!throttle.destroyed) {
      throttle.destroy(new Error(SLOW_CONSUMER_ERROR_MESSAGE));
    }
  });

  try {
  // Zone 1: prelude bytes [0, preludeLen).
  const z1End = preludeLen - 1;
  const z1ReqStart = Math.max(start, 0);
  const z1ReqEnd = Math.min(end, z1End);
  if (z1ReqStart <= z1ReqEnd) {
    await writeAsync(throttle, prelude.subarray(z1ReqStart, z1ReqEnd + 1));
  }

  // Zone 2: sidx bytes [preludeLen, preludeLen + sidxLen). May be empty
  // (sidxLen===0 → skip the zone entirely).
  if (sidxLen > 0) {
    const z2VirtStart = preludeLen;
    const z2VirtEnd = preludeLen + sidxLen - 1;
    const z2ReqStart = Math.max(start, z2VirtStart);
    const z2ReqEnd = Math.min(end, z2VirtEnd);
    if (z2ReqStart <= z2ReqEnd) {
      const offIntoSidx = z2ReqStart - z2VirtStart;
      const lenFromSidx = z2ReqEnd - z2ReqStart + 1;
      await writeAsync(throttle, sidx.subarray(offIntoSidx, offIntoSidx + lenFromSidx));
    }
  }

  // Zone 3: mdat S3 pass-through [preludeLen + sidxLen, preludeLen + sidxLen + mdatZoneLen).
  //
  // Cache fast-path (v0.10.273): if the full mdat zone is small enough to
  // fit in `mdatCache` (default <50 MB per file, 500 MB pool total), we pull
  // the WHOLE thing once and slice the requested range from the in-memory
  // Buffer. Eliminates the one remaining S3 sub-call per /video request
  // (head + sidecar are already cached as of v0.10.272) — which is what
  // saturates the keep-alive pool under load and produces the wedge.
  // Range requests don't need a special code path: cached Buffer.subarray()
  // is O(1).
  const z3VirtStart = preludeLen + sidxLen;
  const z3VirtEnd = z3VirtStart + mdatZoneLen - 1;
  const z3ReqStart = Math.max(start, z3VirtStart);
  const z3ReqEnd = Math.min(end, z3VirtEnd);
  if (z3ReqStart <= z3ReqEnd) {
    const physStart = origMoovEnd + (z3ReqStart - z3VirtStart);
    const physEnd = origMoovEnd + (z3ReqEnd - z3VirtStart);

    const cacheKey = buildMdatCacheKey(bucket, s3Key, userSalt);
    const fullMdat = await getCachedMdat(cacheKey, mdatZoneLen, async () => {
      // Cold miss: fetch the FULL mdat zone (no Range header) so we can
      // serve any subsequent range request from the Buffer. The fetched
      // bytes start at `origMoovEnd` and end at the end of the file —
      // `getObject` returns a Readable for the whole object. Subsequent
      // .subarray() math below subtracts `origMoovEnd` to convert
      // request-frame offsets to mdat-zone-frame offsets.
      const { body } = await getObject(bucket, s3Key, userSalt, `bytes=${origMoovEnd}-${origSize - 1}`);
      return body as Readable;
    });

    if (fullMdat) {
      // Slice from the cached buffer. `physStart`/`physEnd` are file-frame
      // offsets; convert to mdat-frame (subtract `origMoovEnd`).
      const sliceStart = physStart - origMoovEnd;
      const sliceEnd = physEnd - origMoovEnd + 1; // exclusive
      await writeAsync(throttle, fullMdat.subarray(sliceStart, sliceEnd));
    } else {
      // Skipped cache (oversized file) — fall back to legacy ranged S3 GET.
      const { body } = await getObject(bucket, s3Key, userSalt, `bytes=${physStart}-${physEnd}`);
      await pipeS3IntoSink(body as Readable, throttle);
    }
  }

  // Zone 4: mfra suffix [preludeLen + sidxLen + mdatZoneLen, virtualSize).
  const z4VirtStart = preludeLen + sidxLen + mdatZoneLen;
  const z4ReqStart = Math.max(start, z4VirtStart);
  const z4ReqEnd = Math.min(end, virtualSize - 1);
  if (z4ReqStart <= z4ReqEnd) {
    const offIntoMfra = z4ReqStart - z4VirtStart;
    const lenFromMfra = z4ReqEnd - z4ReqStart + 1;
    await writeAsync(throttle, mfra.subarray(offIntoMfra, offIntoMfra + lenFromMfra));
  }

  throttle.end();
  // Transfer is recorded once by the GET /video/:view handler's res
  // finish/close handler (actual bytesWritten), not here — so a mid-stream
  // abort still bills the bytes that reached the client, and a post-header
  // throw that falls through can't double-bill. `totalBytes` retained only
  // for the Content-Length header math above.
  void userId;
  } finally {
    stopSlowMonitor();
  }
}

/**
 * Stream a "clean-frame" virtual MP4 reconstructed on the fly from the
 * `.clean_frame` sidecar + sample bytes from the original recording.
 *
 * Served layout:
 *   [prelude (ftyp + clean faststart moov)]
 *   [mdat box header (8 or 16 bytes)]
 *   [compacted mdat payload = byteRanges concatenated from original S3 object]
 *
 * Range requests into the mdat payload zone are decomposed into per-run S3
 * ranged GETs (typically only a few of the ~95 runs are touched per request)
 * and piped in order through the throttle stream.
 */
async function streamCleanFrameMp4(args: {
  res: Response;
  bucket: string;
  s3Key: string;
  userSalt: string;
  sidecar: CleanFrameSidecarData;
  range: string | undefined;
  throttleBps: number | null;
  userId: number;
  /** See streamPatchedMp4.reportBytes. */
  reportBytes?: (n: number) => void;
}): Promise<void> {
  const { res, bucket, s3Key, userSalt, sidecar, range, throttleBps, userId, reportBytes } = args;
  const { prelude, mdatHeader, byteRanges } = sidecar;

  const layout = cleanFrameLayout(prelude.length, mdatHeader.length, byteRanges);
  const { preludeLen, mdatHeaderLen, servedSize } = layout;

  let start = 0, end = servedSize - 1;
  let isPartial = false;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : servedSize - 1;
    end = Math.min(end, servedSize - 1);
    if (isNaN(start) || start < 0 || start >= servedSize || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${servedSize}` });
      res.end();
      return;
    }
    isPartial = true;
  }

  const totalBytes = end - start + 1;
  res.writeHead(isPartial ? 206 : 200, {
    ...(isPartial && { 'Content-Range': `bytes ${start}-${end}/${servedSize}` }),
    'Accept-Ranges': 'bytes',
    'Content-Length': totalBytes,
    'Content-Type': 'video/mp4',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  reportBytes?.(totalBytes);

  const throttle = buildThrottleStream(throttleBps);
  // See streamPatchedMp4 — strip the pipe-added res listeners to avoid the
  // MaxListenersExceededWarning leak.
  pipeThrottleToResponse(throttle, res);
  const stopSlowMonitor = attachSlowConsumerMonitor(res, (rateKbps) => {
    console.log(`[streamCleanFrameMp4] slow consumer killed: ${rateKbps.toFixed(1)} KB/s`);
    recordSlowConsumerKill('clean');
    if (!throttle.destroyed) throttle.destroy(new Error(SLOW_CONSUMER_ERROR_MESSAGE));
  });

  try {
    // Zone 1: prelude bytes [0, preludeLen)
    const z1ReqStart = Math.max(start, 0);
    const z1ReqEnd = Math.min(end, preludeLen - 1);
    if (z1ReqStart <= z1ReqEnd) {
      await writeAsync(throttle, prelude.subarray(z1ReqStart, z1ReqEnd + 1));
    }

    // Zone 2: mdat header bytes [preludeLen, preludeLen + mdatHeaderLen)
    const z2VirtStart = preludeLen;
    const z2VirtEnd = preludeLen + mdatHeaderLen - 1;
    const z2ReqStart = Math.max(start, z2VirtStart);
    const z2ReqEnd = Math.min(end, z2VirtEnd);
    if (z2ReqStart <= z2ReqEnd) {
      const offIntoMdatHeader = z2ReqStart - z2VirtStart;
      await writeAsync(throttle, mdatHeader.subarray(offIntoMdatHeader, z2ReqEnd - z2VirtStart + 1));
    }

    // Zone 3: compacted mdat payload [preludeLen + mdatHeaderLen, servedSize)
    // Each byteRange is a contiguous run in the ORIGINAL S3 object.
    const z3VirtStart = preludeLen + mdatHeaderLen;
    if (end >= z3VirtStart) {
      // payloadStart/payloadEnd are 0-based offsets within the concatenated payload.
      const payloadStart = Math.max(start, z3VirtStart) - z3VirtStart;
      const payloadEnd = end - z3VirtStart;

      const origRanges = payloadRangeToOriginalRanges(byteRanges, payloadStart, payloadEnd);
      const span = coalesceOriginalRanges(origRanges);
      if (span) {
        const { body } = await getObject(bucket, s3Key, userSalt, `bytes=${span.spanStart}-${span.spanEnd}`);
        const gapSkip = createGapSkipTransform(span.keep);
        (body as Readable).pipe(gapSkip);
        await pipeS3IntoSink(gapSkip as unknown as Readable, throttle);
      }
    }

    throttle.end();
    void userId;
  } finally {
    stopSlowMonitor();
  }
}

/** Backpressure-aware write to a stream. */
function writeAsync(stream: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      stream.removeListener('error', onError);
      reject(err);
    };
    stream.once('error', onError);
    if (stream.write(buf)) {
      stream.removeListener('error', onError);
      resolve();
    } else {
      stream.once('drain', () => {
        stream.removeListener('error', onError);
        resolve();
      });
    }
  });
}

// Dedicated HEAD path for the video stream. Express's default behaviour is to
// route HEAD through the matching GET handler (and just strip the body), which
// for this endpoint means every HEAD pays for a full `getSidecar()` round-trip
// to S3 (~500 ms typical, sporadic 503 when the sidecar bucket is hot). Chrome
// fires HEAD/probe requests next to its Range GETs to validate the resource;
// when it sees a 503 it treats the source as broken and bails into
// NETWORK_NO_SOURCE — exactly the "Loading video…" / "Network slow, retrying"
// failure mode Firefox does not reproduce because it skips the HEAD probe.
//
// This handler short-circuits: auth + ownership + `headObject(S3)` for the
// declared `Content-Length`. No sidecar fetch, no quota touch, no patch-state
// lookup. The numbers don't have to match the GET byte-perfectly (the patched
// stream is `origSize + mfraLen`, a few KB larger) — clients always re-learn
// the real length from `Content-Range` on the first Range GET.
videoRouter.head('/:id/video/:view', requireUnlockedAccount, mediaRateLimit, async (req: Request<{ id: string; view: string }>, res) => {
  if (req.user?.mediaEventId && req.user.mediaEventId !== req.params.id) {
    res.status(403).end();
    return;
  }
  const viewId = req.params.view;
  if (!viewId || viewId.length > 16) {
    res.status(400).end();
    return;
  }
  const userId = req.user?.userId;
  if (!userId) { res.status(401).end(); return; }

  const userSalt = await getUserSalt(userId);
  if (!userSalt) { res.status(500).end(); return; }

  const event = await getEventByIdForOwner(req.params.id, userId);
  if (!event) { res.status(404).end(); return; }

  const relPath = event.views.find(l => l.id === viewId)?.videoRelPath;
  if (!relPath) { res.status(404).end(); return; }

  const s3Path = resolveS3Path(req.user!.userUuid, relPath);
  if (!s3Path) { res.status(404).end(); return; }

  try {
    // cachedHeadObject (Redis, TTL 1h) eliminates this sub-call from the S3
    // pool on the hot path — see services/s3.ts. Without this, 100 concurrent
    // /video requests fan out to 300-500 socket-asks against pool=500 and
    // wedge it; with this, fan-out drops to ~1 (the streaming getObject) +
    // a sub-ms Redis read.
    const fileSize = (await cachedHeadObject(s3Path.bucket, s3Path.key, userSalt)).contentLength;

    // CRITICAL (CLEAN-FRAME-SIZE-MISMATCH-502): when the caller asks for the
    // `?fmt=clean` stream, HEAD MUST advertise the clean reconstruction's served
    // size — NOT the original object size. The clean faststart MP4 strips the
    // per-fragment moof/mfra/free container overhead and so is a different total
    // length. If HEAD reports the original size, the browser seeks to the
    // original EOF, the `?fmt=clean` GET 416s/resets on that out-of-range tail,
    // and nginx turns it into a 502 — the "last ~2 s won't play" bug. Fall back
    // to the original size only when there's no usable clean body (no sidecar /
    // stale sidecar), which matches what the GET path then serves.
    let advertisedLen = fileSize;
    if (CONFIG.cleanFrameEnabled && req.query['fmt'] === 'clean') {
      const served = await cleanFrameServedSize(s3Path.bucket, s3Path.key, userSalt, fileSize);
      if (served !== null) advertisedLen = served;
    }
    // Strip helmet's default CSP / CORP from the response — they are intended
    // for HTML documents and have no value on a binary media resource. Chrome's
    // media engine treats `default-src 'none'` (no `media-src`) on a direct
    // navigation to the URL as a hard NETWORK_NO_SOURCE, and stalls embedded
    // <video> loads when CORP collides with internal media-isolation rules.
    // Firefox ignores both, which is why it plays this stream fine today.
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': advertisedLen,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'private, max-age=0, must-revalidate',
    });
    res.end();
  } catch {
    res.status(404).end();
  }
});

// GET /events/:id/video/:view/frames  (requireAuth — access token only, NOT media-token)
// Returns { grid: number[] } (presentation times in seconds) from the `.frames` sidecar.
// If the sidecar is absent or unreadable, responds with { grid: [] } at HTTP 200 so the
// client can fall back to fps-based stepping without an ugly network error.
//
// This is a media read (a ~4 MB S3 object fetch), so it carries the SAME
// bucket as the other media routes: `mediaRateLimit` (its own higher-ceiling
// rate bucket — index.ts's MEDIA_GET_PATH regex excludes `video/*` from the
// general apiRateLimit precisely because these routes are expected to bring
// their own) plus once-only transfer metering. Without both, this endpoint was
// an unrate-limited, unbilled ~4 MB S3 read: free egress + socket-pool
// amplification.
videoRouter.get('/:id/video/:view/frames', requireUnlockedAccount, mediaRateLimit, async (req: Request<{ id: string; view: string }>, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const event = await getEventByIdForOwner(req.params.id, userId);
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const view = event.views.find(v => v.id === req.params.view);
  if (!view) { res.status(404).json({ error: 'View not found' }); return; }

  const userSalt = await getUserSalt(userId);
  if (!userSalt) { res.status(500).json({ error: 'User encryption key not found' }); return; }

  const s3Path = resolveS3Path(req.user!.userUuid, view.videoRelPath);
  if (!s3Path) { res.status(404).json({ error: 'File not found' }); return; }

  // Transfer accounting — once-only, mirroring the playback / original-download
  // handlers. We meter the bytes actually pulled from S3 (the egress this route
  // consumes), recorded EXACTLY ONCE on finish/close so a client abort mid-read
  // is still billed and a completed request is never double-billed.
  let framesBytesRead = 0;
  let transferRecorded = false;
  const recordTransferOnce = (): void => {
    if (transferRecorded) return;
    transferRecorded = true;
    if (framesBytesRead > 0) void updateTransferUsage(userId, framesBytesRead);
  };
  res.once('finish', recordTransferOnce);
  res.once('close', recordTransferOnce);

  try {
    const { body } = await getObject(CONFIG.s3SidecarsBucket, `${s3Path.key}.frames`, userSalt);
    const MAX_FRAMES_BYTES = 4 * 1024 * 1024; // 4 MB cap
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) {
      framesBytesRead += (chunk as Buffer).length;
      if (framesBytesRead > MAX_FRAMES_BYTES) {
        // Sidecar unexpectedly large — fall through to empty grid.
        res.json({ grid: [] });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const buf = Buffer.concat(chunks);
    const parsed = JSON.parse(buf.toString('utf8')) as { grid?: unknown };
    const grid = Array.isArray(parsed?.grid) ? parsed.grid as number[] : [];
    res.json({ grid });
  } catch {
    // NoSuchKey (no sidecar yet) or any read/parse error → graceful empty grid.
    res.json({ grid: [] });
  }
});

// GET /events/:id/video/:view/original
// RAW byte-for-byte download of the ORIGINAL recording as uploaded by the
// camera over FTP. This path deliberately bypasses ALL playback processing —
// no clean-frame reconstruction, no fmp4 sidecar stitch, no moov/sidx/mfra
// patching. It streams the original S3 object exactly, so "Download" always
// yields the pristine file the camera produced (never the reconstructed
// playback stream the `/video/:view` endpoint serves). `Content-Disposition:
// attachment` makes the browser save rather than navigate.
videoRouter.get('/:id/video/:view/original', requireUnlockedAccount, mediaRateLimit, videoConcurrencyCap, async (req: Request<{ id: string; view: string }>, res) => {
  if (req.user?.mediaEventId && req.user.mediaEventId !== req.params.id) {
    res.status(403).json({ error: 'Token not valid for this resource' });
    return;
  }
  const viewId = req.params.view;
  if (!viewId || viewId.length > 16) { res.status(400).json({ error: 'Invalid view id' }); return; }
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const userSalt = await getUserSalt(userId);
  if (!userSalt) { res.status(500).json({ error: 'User encryption key not found' }); return; }

  const event = await getEventByIdForOwner(req.params.id, userId);
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const relPath = event.views.find(l => l.id === viewId)?.videoRelPath;
  if (!relPath) { res.status(404).json({ error: `No video for view "${viewId}"` }); return; }

  const s3Path = resolveS3Path(req.user!.userUuid, relPath);
  if (!s3Path) { res.status(404).json({ error: 'File not found' }); return; }

  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');

  // Transfer accounting — once-only, against actual socket bytesWritten. Same
  // shape as the playback GET handler (see its comment block).
  const socketAtStart = (res.socket?.bytesWritten ?? 0);
  const streamStartedMs = Date.now();
  let plannedBytes = 0;
  let transferRecorded = false;
  const recordTransferOnce = (): void => {
    if (transferRecorded) return;
    transferRecorded = true;
    const socketDelta = (res.socket?.bytesWritten ?? socketAtStart) - socketAtStart;
    const sent = socketDelta > 0
      ? (plannedBytes > 0 ? Math.min(socketDelta, plannedBytes) : socketDelta)
      : plannedBytes;
    if (sent > 0) void updateTransferUsage(userId, sent);
    observeStreamThroughput('original', originFor(req.user?.userUuid), sent, (Date.now() - streamStartedMs) / 1000);
  };
  res.once('finish', recordTransferOnce);
  res.once('close', recordTransferOnce);

  try {
    const fileSize = (await cachedHeadObject(s3Path.bucket, s3Path.key, userSalt)).contentLength;

    const { transferUsageBytes } = await checkAndResetTransfer(userId);
    const quota = await getUserQuota(userId);
    const decision = decideThrottle(transferUsageBytes, quota?.transferLimitBytes ?? 0);
    if (decision.mode === 'block') {
      recordVideoServeFailure('quota_block');
      res.status(429).json({ error: 'Monthly transfer quota exceeded' });
      return;
    }
    const throttleBps = decision.mode === 'throttle' ? decision.bytesPerSec : null;

    const rawFilename = relPath.split('/').pop() || 'video.mp4';
    const filename = rawFilename.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      end = Math.min(end, fileSize - 1);
      if (isNaN(start) || start < 0 || start >= fileSize || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        res.end();
        return;
      }
      const { body, contentRange } = await getObject(s3Path.bucket, s3Path.key, userSalt, `bytes=${start}-${end}`);
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': contentRange || `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      plannedBytes += chunkSize;
      await pipeS3ToResponse(body as Readable, res, buildThrottleStream(throttleBps));
    } else {
      const { body } = await getObject(s3Path.bucket, s3Path.key, userSalt);
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      plannedBytes += fileSize;
      await pipeS3ToResponse(body as Readable, res, buildThrottleStream(throttleBps));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown';
    if (message === SLOW_CONSUMER_ERROR_MESSAGE) {
      console.log('Original download: slow consumer kill completed, S3 socket released');
    } else {
      console.error('Original download error:', message);
    }
    if (!res.headersSent) {
      res.status(404).json({ error: 'Video not found in storage' });
    } else if (!res.writableEnded) {
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
});

videoRouter.get('/:id/video/:view', requireUnlockedAccount, mediaRateLimit, videoConcurrencyCap, async (req: Request<{ id: string; view: string }>, res) => {
  // Validate media token scope if used
  if (req.user?.mediaEventId && req.user.mediaEventId !== req.params.id) {
    res.status(403).json({ error: 'Token not valid for this resource' });
    return;
  }

  const viewId = req.params.view;
  if (!viewId || viewId.length > 16) {
    res.status(400).json({ error: 'Invalid view id' });
    return;
  }

  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const userSalt = await getUserSalt(userId);
  if (!userSalt) { res.status(500).json({ error: 'User encryption key not found' }); return; }

  const event = await getEventByIdForOwner(req.params.id, userId);
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const relPath = event.views.find(l => l.id === viewId)?.videoRelPath;
  if (!relPath) { res.status(404).json({ error: `No video for view "${viewId}"` }); return; }

  const s3Path = resolveS3Path(req.user!.userUuid, relPath);
  if (!s3Path) { res.status(404).json({ error: 'File not found' }); return; }

  const fmRow = await getFileMetadataByKey(s3Path.bucket, s3Path.key);
  if (!fmRow) {
    res.status(404).json({ error: 'Video not found in storage' });
    return;
  }

  // Reject permanently-unprocessable files outright. Otherwise let the
  // request through — if the sidecar isn't ready we fall back to the raw
  // mp4 pass-through path further down, which the browser can still play
  // (just without our duration/seek injection).
  const patchState = await getPlaybackPatchState(fmRow.id);
  if (patchState?.unplayable) {
    res.status(410).json({ error: 'Video could not be processed' });
    return;
  }

  // Drop helmet's `Content-Security-Policy` and `Cross-Origin-Resource-Policy`
  // from this response. Both target HTML documents and offer no protection on
  // a binary `video/mp4` body. They DO cause real harm in Chrome: a top-level
  // navigation to this URL inherits the CSP, lands in a "media document" with
  // `default-src 'none'` (no `media-src`), and Chrome refuses to play
  // (NETWORK_NO_SOURCE). Embedded `<video>` loads in the SPA stall the same
  // way under some Chrome media-pipeline heuristics. Firefox ignores both
  // headers on a media response, which is why playback is fast there.
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');

  // --- Per-request transfer accounting ---
  // The byte total this request streams is recorded EXACTLY ONCE, on response
  // completion (finish/close), against the actual bytes written to the socket.
  // Why this shape:
  //   * Previously each streaming branch called updateTransferUsage(...) inline,
  //     fire-and-forget. On a mid-stream abort (iOS AVPlayer cancels Range GETs
  //     constantly) the branch's post-send call never ran, so aborted bytes
  //     escaped the meter. On a post-header throw + fall-through (the same code
  //     path that leaked listeners, see below) it could run twice → double-count.
  //   * A single `res.once('finish'|'close')` handler that reads the socket's
  //     bytesWritten delta records what actually went out on the wire, once, for
  //     every termination (clean end, client abort, slow-consumer kill). It does
  //     NOT block or delay the response (it fires after the socket is done).
  //   * Conservative by design: `bytesWritten` includes the response headers
  //     (a few hundred bytes) and any partially-sent body on abort. We prefer to
  //     slightly over-count headers than to drop a whole aborted transfer.
  // The pre-stream 429 gate (decideThrottle below) is unchanged — this only
  // makes the post-send accounting robust, never the gating.
  const socketAtStart = (res.socket?.bytesWritten ?? 0);
  const streamStartedMs = Date.now();
  // Serving path for the throughput metric; the clean branch sets 'clean',
  // otherwise the fmp4 fall-through leaves it 'patched'.
  let metricsPath: VideoPath = 'patched';
  let plannedBytes = 0;
  let transferRecorded = false;
  // Each streaming branch reports the byte count it is about to send via this.
  // On a normal completion with a live socket we prefer the ACTUAL bytesWritten
  // delta (so a mid-stream abort bills only what reached the client); when the
  // socket isn't observable (e.g. in-memory test transport) we fall back to the
  // planned count. Either way the latch below records it exactly once.
  const reportPlannedBytes = (n: number): void => {
    if (n > 0) plannedBytes += n;
  };
  const recordTransferOnce = (): void => {
    if (transferRecorded) return;
    transferRecorded = true;
    const socketDelta = (res.socket?.bytesWritten ?? socketAtStart) - socketAtStart;
    // Prefer the real socket delta when we have one (>0); otherwise the planned
    // bytes. Never exceed `plannedBytes` when both are known — a socket delta
    // can include a few hundred header bytes, but capping at planned keeps us
    // from over-billing the user vs the Content-Length we advertised.
    const sent = socketDelta > 0
      ? (plannedBytes > 0 ? Math.min(socketDelta, plannedBytes) : socketDelta)
      : plannedBytes;
    if (sent > 0) {
      // Fire-and-forget is acceptable HERE (the response is already finished,
      // so awaiting cannot affect playback) but the latch guarantees once-only.
      void updateTransferUsage(userId, sent);
    }
    // Origin = who is WATCHING. The synthetic probe fetches its own events
    // every cycle, so without this split its downloads dominate the customer
    // throughput histogram at every quiet hour (see metrics.ts).
    observeStreamThroughput(metricsPath, originFor(req.user?.userUuid), sent, (Date.now() - streamStartedMs) / 1000);
  };
  // Single completion handler — covers normal finish, client abort, and the
  // slow-consumer kill. `once` so at most one listener of each is attached per
  // request (cf. the listener-leak fix below).
  res.once('finish', recordTransferOnce);
  res.once('close', recordTransferOnce);

  try {
    // cachedHeadObject (Redis, TTL 1h) — see comment on the HEAD handler
    // above. Hot-path elimination of one S3 sub-call per /video request.
    const fileSize = (await cachedHeadObject(s3Path.bucket, s3Path.key, userSalt)).contentLength;

    // Transfer quota check — Fix 0E. Three bands: pass / soft-throttle / 429.
    const { transferUsageBytes } = await checkAndResetTransfer(userId);
    const quota = await getUserQuota(userId);
    const decision = decideThrottle(
      transferUsageBytes,
      quota?.transferLimitBytes ?? 0,
    );
    if (decision.mode === 'block') {
      recordVideoServeFailure('quota_block');
      res.status(429).json({ error: 'Monthly transfer quota exceeded' });
      return;
    }
    const throttleBps = decision.mode === 'throttle' ? decision.bytesPerSec : null;

    const rawFilename = relPath.split('/').pop() || 'video.mp4';
    const filename = rawFilename.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const range = req.headers.range;

    // RFC 7233 §2.1: reject clearly-unsatisfiable ranges (start >= fileSize)
    // before any S3 I/O so a bad Range header never triggers the sidecar fetch.
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const rangeStart = parseInt(parts[0], 10);
      if (!isNaN(rangeStart) && rangeStart >= fileSize) {
        recordVideoServeFailure('range_unsatisfiable');
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        res.end();
        return;
      }
    }

    // Fast path (clean-frame): serve the iOS-native backward-steppable clean
    // faststart MP4 reconstructed on-the-fly from the `.clean_frame` sidecar.
    // Gated by CONFIG.cleanFrameEnabled + `?fmt=clean` query param so the flag
    // can be toggled without a deploy and callers opt in explicitly.
    // Falls through to the fmp4patch path on sidecar-miss or soft errors; the
    // `res.headersSent` guard prevents fall-through once bytes are on the wire.
    if (CONFIG.cleanFrameEnabled && req.query['fmt'] === 'clean') {
      // Load the sidecar FIRST (with retry), entirely BEFORE any res.writeHead.
      // Deciding clean-vs-fallthrough up front — never after bytes are on the
      // wire — also removes the old clean→fmp4 double-pipe that caused the
      // "11 close listeners on [ServerResponse]" leak.
      let cfSidecar: CleanFrameSidecarData | null = null;
      try {
        cfSidecar = await loadCleanFrameSidecar(s3Path.bucket, s3Path.key, userSalt);
      } catch (err) {
        if (!isS3NotFound(err)) {
          // Transient sidecar-bucket error that survived the retries. Do NOT
          // fall through to the non-clean path: it advertises the ORIGINAL size
          // instead of the clean servedSize, and that size-flip is the
          // CLEAN-FRAME-SIZE-MISMATCH-502 bug. A retryable 503 keeps `?fmt=clean`
          // on one consistent size — the client just retries.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[clean_frame] transient sidecar load error, 503:', msg.slice(0, 200));
          // The web player retries this 503 (useVideoStallRetry) and the native
          // players now do too, so it is invisible in support reports — which is
          // exactly why it needs to be visible here.
          recordVideoServeFailure('sidecar_transient');
          res.setHeader('Retry-After', '2');
          res.status(503).json({ error: 'Clean stream temporarily unavailable' });
          return;
        }
        // Genuine NoSuchKey — this file has no clean sidecar. Fall through to the
        // non-clean path below; a sidecar-less file is served at the original
        // size on EVERY request, so there is no size-flip and HEAD (which also
        // returns null → fileSize) stays consistent with it.
      }
      if (cfSidecar) {
        // Stale-sidecar handling: if the sidecar references original bytes past
        // the CURRENT object size, it was built against a different (larger)
        // original — the file was reprocessed and the `.clean_frame` sidecar was
        // never rebuilt (fmp4PatchWorker is idempotent: `if (state?.readyAt)
        // return 'skipped-already-ready'`, so a re-scan will NOT refresh it).
        // Serving its byteRanges would Range-GET out of bounds and reset the
        // tail → nginx 502. We do NOT 503 here — a persistently-stale sidecar
        // never recovers, so a 503 just loops the web player on an unplayable
        // "error". Instead we FALL THROUGH to the non-clean path below, which
        // streams the current original directly and plays fine. A
        // deterministically-stale sidecar falls through on EVERY request, so
        // there is no clean↔non-clean size-flip (the original 502 cause), and
        // HEAD (cleanFrameServedSize → null on stale → fileSize) stays
        // consistent with the non-clean body served here.
        if (cleanFrameMaxSrcEnd(cfSidecar.byteRanges) > fileSize) {
          console.warn('[clean_frame] stale sidecar (maxSrcEnd > fileSize), serving non-clean');
          // Serves 200 but silently downgrades, permanently, for this file — a
          // log line alone makes that invisible in aggregate.
          recordVideoServeFailure('stale_sidecar');
        } else {
          metricsPath = 'clean';
          await streamCleanFrameMp4({
            res,
            bucket: s3Path.bucket,
            s3Key: s3Path.key,
            userSalt,
            sidecar: cfSidecar,
            range,
            throttleBps,
            userId,
            reportBytes: reportPlannedBytes,
          });
          return;
        }
      }
    }

    // Try the sidecar first. Class A files have a sidecar in the dedicated
    // bucket; class B/C files (already-good MP4) skip generation entirely
    // and we serve the original byte-for-byte. The 404 from getObject is
    // the in-band signal for that fork.
    let sidecarBuf: Buffer | null = null;
    try {
      sidecarBuf = await getSidecar({
        fileMetadataId: fmRow.id,
        s3Key: s3Path.key,
        userSalt,
      });
      // Wedge detection happens at the S3 SDK middleware layer — see the
      // `wedgeDetector` middleware in services/s3.ts. Every command sent
      // through the shared S3 client (including the getSidecar GET, the
      // headObject probes in /media-token, and anything a new route adds
      // tomorrow) feeds its success/failure into the counter automatically.
      // No per-call-site hook here any more — it was a leaky abstraction
      // that missed /media-token.
    } catch (err) {
      const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      const msg = err instanceof Error ? err.message : String(err);
      const isNotFound =
        (e.name && /NoSuchKey|NotFound/i.test(e.name)) ||
        (e.Code && /NoSuchKey|NotFound/i.test(e.Code)) ||
        e.$metadata?.httpStatusCode === 404 ||
        /specified key does not exist|NoSuchKey|status code: 404/i.test(msg);
      if (!isNotFound) {
        // Real S3 error — bubble as 503 so the client retries. The wedge
        // counter has already been advanced by the SDK middleware.
        recordVideoServeFailure('sidecar_fetch');
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: 'Sidecar fetch failed' });
        return;
      }
    }

    if (sidecarBuf) {
      // Class A: stitch [prelude][sidx_v?][sidx_a?][mdat][mfra]
      const { prelude, mfra, durationMs, perTrack } = parseSidecar(sidecarBuf);
      // Backwards-compat guard: the previous patch format injected a 16-byte
      // `mehd` box into moov. Streaming such a sidecar under the in-place
      // duration logic would mis-align the mdat zone by 16 bytes (every range
      // request returns the wrong physical bytes). Old-format sidecars are
      // detected by the presence of mehd in the prelude's moov; we treat them
      // as if absent so the route falls through to raw pass-through, and we
      // evict them from the in-process cache so the next request hits S3
      // (where the worker will eventually overwrite with the new format).
      const moovInfo = inspectMoov(prelude);
      if (moovInfo.moov.hasMehd) {
        invalidateSidecar(fmRow.id);
        sidecarBuf = null;
      } else {
        // Sidx injection strategy (v0.10.210 = "Option B"):
        //  - single-track files: ONE sidx with one subsegment per moof,
        //    `subsegment_duration[i]` driven by primary track decodeTime
        //    deltas. Works since v0.10.201.
        //  - multi-track files with v6 sidecar (perTrack present): emit
        //    ONE sidx PER TRACK back-to-back between moov and the first
        //    moof. Each sidx has its track's reference_ID, mdhd timescale
        //    and per-fragment durations. Mirrors ffmpeg's
        //    `+dash+global_sidx` output, which we verified end-to-end
        //    against the same Reolink fmp4 shape: 100 MB clip went from
        //    85 requests / 9 s cold-start (no sidx) to 3 requests / 0.36 s
        //    in Chrome, and Firefox played both variants without HVCC
        //    rejection. The video sidx must declare `first_offset =
        //    audioSidxBytes` so its references stay anchored to the first
        //    moof even though the audio sidx sits between them.
        //  - multi-track files without v6: no sidx, fall back to the
        //    v0.10.207 path with mvhd patched. The reconciler lazily
        //    rebakes these to v6 over the schema-bump migration window.
        //
        // History — why we ended up here:
        //   v0.10.201/202/204/208: every single-sidx variant we tried for
        //     multi-track broke playback (Chrome 2× duration / Firefox
        //     HVCC error / PIPELINE_ERROR_DECODE). One sidx can only carry
        //     one track's timeline; the second track had to derive its
        //     timeline from somewhere, and Reolink's mvhd/tkhd durations
        //     are 0, so browsers either rejected the file or over-counted.
        //   v0.10.210: dual sidx (one per track) gives each track its own
        //     authoritative timeline and the cross-track summing problem
        //     disappears. Confirmed against ffmpeg-generated reference.
        const moovInfoLocal = moovInfo.moov;
        const isSingleTrack = moovInfoLocal.trackCount === 1;
        // v0.10.212: dual-sidx path for multi-track files is DISABLED.
        // The dual-sidx + base_data_offset interaction broke playback
        // (Reolink moofs use absolute base_data_offset; inserting sidx
        // shifts the moof positions but the moofs still point at the
        // original mdat location → MSE can't find media). Multi-track
        // `<video src>` hits fall through to the v0.10.207 no-sidx +
        // mvhd-patch route, which works (~8s Chrome cold-start). The
        // common path for the web player is the clean-frame fast path
        // above (`?fmt=clean`); this stitch path is the fallback when no
        // clean_frame sidecar exists. v6 sidecar per-track data still
        // parses fine but goes unused here.
        void perTrack;
        const canUseSidx = isSingleTrack;
        let effectivePrelude = prelude;
        if (!canUseSidx && durationMs !== undefined && durationMs > 0) {
          // No-sidx path: patch mvhd.duration in place so Chrome's
          // avformat_find_stream_info() terminates after reading moov
          // without scanning the entire mdat zone (the v0.10.187 fix for
          // PIPELINE_ERROR_READ). Skipped on the sidx path because sidx
          // already declares track durations and adding a non-zero
          // mvhd.duration on top of dual-sidx triggered duration over-
          // report in v0.10.201.
          effectivePrelude = Buffer.from(prelude);
          patchPreludeMvhdDuration(effectivePrelude, durationMs);
        }

        let sidx: Buffer = Buffer.alloc(0);
        let shiftedMfra = mfra;
        if (canUseSidx) {
          // Single-track files only (multi-track falls through to the
          // no-sidx mvhd-patch path above). One sidx box, one ref per
          // moof, subsegment_duration from decodeTime deltas. Works since
          // v0.10.201, no regression.
          const mfraEntries = parseMfraEntries(mfra);
          const refCount = mfraEntries.length;
          const sidxLen = computeSidxSize(refCount);
          const mdatZoneLen = fileSize - effectivePrelude.length;
          const lastEntry = mfraEntries[mfraEntries.length - 1];
          const totalTicks = durationMs !== undefined && durationMs > 0
            ? Math.round((durationMs / 1000) * moovInfoLocal.primaryTrackTimescale)
            : lastEntry.decodeTime + 1;
          shiftedMfra = shiftMfraOffsets(mfra, sidxLen);
          const entries = mfraEntries.map((e) => ({
            decodeTime: e.decodeTime,
            moofOffset: e.moofOffset + sidxLen,
          }));
          sidx = buildSidx({
            entries,
            primaryTrackId: moovInfoLocal.primaryTrackId,
            timescale: moovInfoLocal.primaryTrackTimescale,
            mdatZoneEnd: effectivePrelude.length + sidxLen + mdatZoneLen,
            totalDurationTicks: totalTicks,
          });
        }
        await streamPatchedMp4({
          res,
          bucket: s3Path.bucket,
          s3Key: s3Path.key,
          userSalt,
          origSize: fileSize,
          prelude: effectivePrelude,
          sidx,
          mfra: shiftedMfra,
          range,
          throttleBps,
          userId,
          reportBytes: reportPlannedBytes,
        });
        return;
      }
    }

    // Class B/C pass-through path — original mp4 is already playable.
    //
    // Audio stts fix for Reolink class-B-path files: read the file head from
    // S3 to locate the moov, then call patchAudioStts to detect and patch any
    // audio track stts entries with sample_delta=0 (AVPlayer discards the
    // track when mdhd.duration=0). patchAudioStts patches in-place (same
    // moov size), so the fileSize and all absolute byte offsets stay valid.
    // If no fix is needed, fall through to the original raw pass-through.
    let passThroughMoov: Buffer | null = null;
    let passThroughMoovEnd = 0; // byte offset where the moov ends in S3 file
    try {
      // Read enough bytes to cover ftyp + moov header (at least 32 bytes).
      const headProbeEnd = Math.min(32, fileSize - 1);
      const { body: headBody } = await getObject(s3Path.bucket, s3Path.key, userSalt, `bytes=0-${headProbeEnd}`);
      const headProbeChunks: Buffer[] = [];
      for await (const chunk of headBody as AsyncIterable<Buffer>) headProbeChunks.push(Buffer.from(chunk));
      const headProbe = Buffer.concat(headProbeChunks);
      const ftypHdr = readBoxHeader(headProbe, 0);
      if (ftypHdr && ftypHdr.type === 'ftyp' && ftypHdr.size > 0) {
        const moovHdrProbe = readBoxHeader(headProbe, ftypHdr.size);
        if (moovHdrProbe && moovHdrProbe.type === 'moov' && moovHdrProbe.size > 0) {
          const moovEnd = ftypHdr.size + moovHdrProbe.size;
          if (moovEnd <= fileSize) {
            // Fetch the full moov.
            const { body: moovBody } = await getObject(
              s3Path.bucket, s3Path.key, userSalt,
              `bytes=${ftypHdr.size}-${moovEnd - 1}`,
            );
            const moovChunks: Buffer[] = [];
            for await (const chunk of moovBody as AsyncIterable<Buffer>) moovChunks.push(Buffer.from(chunk));
            const moovBuf = Buffer.concat(moovChunks);
            const patched = patchAudioStts(moovBuf);
            if (patched !== moovBuf) {
              // A fix was applied — use the patched moov for stitched serving.
              passThroughMoov = patched;
              passThroughMoovEnd = moovEnd;
            }
          }
        }
      }
    } catch {
      // Best-effort: if we can't read/patch the moov, fall through to raw.
      passThroughMoov = null;
    }

    if (passThroughMoov !== null) {
      // Serve stitched: [ftyp (raw S3)][patched moov][rest (raw S3)].
      // The patched moov is the same size as the original (in-place patch),
      // so fileSize and all absolute offsets remain valid.
      const ftypSize = passThroughMoovEnd - passThroughMoov.length;
      const restStart = passThroughMoovEnd; // bytes after moov
      let reqStart = 0;
      let reqEnd = fileSize - 1;
      let isPartial = false;
      if (range) {
        const rangeParts = range.replace(/bytes=/, '').split('-');
        reqStart = parseInt(rangeParts[0], 10);
        reqEnd = rangeParts[1] ? parseInt(rangeParts[1], 10) : fileSize - 1;
        reqEnd = Math.min(reqEnd, fileSize - 1);
        if (isNaN(reqStart) || reqStart < 0 || reqStart >= fileSize || reqEnd < reqStart) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
          res.end();
          return;
        }
        isPartial = true;
      }
      const totalBytes = reqEnd - reqStart + 1;
      res.writeHead(isPartial ? 206 : 200, {
        ...(isPartial && { 'Content-Range': `bytes ${reqStart}-${reqEnd}/${fileSize}` }),
        'Accept-Ranges': 'bytes',
        'Content-Length': totalBytes,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      reportPlannedBytes(totalBytes);
      const throttle = buildThrottleStream(throttleBps);
      // See streamPatchedMp4 — strip the pipe-added res listeners to avoid the
      // MaxListenersExceededWarning leak.
      pipeThrottleToResponse(throttle, res);
      try {
        // Zone A: ftyp from S3 [0, ftypSize)
        const zA_reqStart = Math.max(reqStart, 0);
        const zA_reqEnd = Math.min(reqEnd, ftypSize - 1);
        if (zA_reqStart <= zA_reqEnd) {
          const { body } = await getObject(s3Path.bucket, s3Path.key, userSalt, `bytes=${zA_reqStart}-${zA_reqEnd}`);
          await pipeS3IntoSink(body as Readable, throttle);
        }
        // Zone B: patched moov in-memory [ftypSize, passThroughMoovEnd)
        const zB_virtStart = ftypSize;
        const zB_virtEnd = passThroughMoovEnd - 1;
        const zB_reqStart = Math.max(reqStart, zB_virtStart);
        const zB_reqEnd = Math.min(reqEnd, zB_virtEnd);
        if (zB_reqStart <= zB_reqEnd) {
          const offIntoMoov = zB_reqStart - zB_virtStart;
          const lenFromMoov = zB_reqEnd - zB_reqStart + 1;
          await writeAsync(throttle, passThroughMoov.subarray(offIntoMoov, offIntoMoov + lenFromMoov));
        }
        // Zone C: rest from S3 [passThroughMoovEnd, fileSize)
        if (reqEnd >= restStart && restStart < fileSize) {
          const zC_s3Start = Math.max(reqStart, restStart);
          const zC_s3End = Math.min(reqEnd, fileSize - 1);
          if (zC_s3Start <= zC_s3End) {
            const { body } = await getObject(s3Path.bucket, s3Path.key, userSalt, `bytes=${zC_s3Start}-${zC_s3End}`);
            await pipeS3IntoSink(body as Readable, throttle);
          }
        }
        throttle.end();
      } catch (innerErr) {
        if (!throttle.destroyed) throttle.destroy(innerErr instanceof Error ? innerErr : undefined);
        throw innerErr;
      }
    } else if (range) {
      // Raw pass-through with Range (no moov patch needed or moov read failed).
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      // RFC 7233 §2.1: a range end past EOF is clamped to the last byte, not
      // rejected. Native players self-clamp, but a raw `bytes=0-N` with N >=
      // fileSize (common 4 MB chunk window on files <4 MB) must still serve
      // 206. Only an unsatisfiable start (>= fileSize) or an inverted range
      // (after clamping) is a true 416.
      end = Math.min(end, fileSize - 1);
      if (isNaN(start) || start < 0 || start >= fileSize || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        res.end();
        return;
      }
      const { body, contentRange } = await getObject(s3Path.bucket, s3Path.key, userSalt, `bytes=${start}-${end}`);
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': contentRange || `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      reportPlannedBytes(chunkSize);
      await pipeS3ToResponse(body as Readable, res, buildThrottleStream(throttleBps));
      // Transfer is recorded once by the res finish/close handler hoisted at the
      // top of this handler (actual bytesWritten), not inline here.
    } else {
      const { body } = await getObject(s3Path.bucket, s3Path.key, userSalt);
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      reportPlannedBytes(fileSize);
      await pipeS3ToResponse(body as Readable, res, buildThrottleStream(throttleBps));
      // Transfer recorded once by the res finish/close handler (see top of
      // handler) using actual bytesWritten.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown';
    // Slow-consumer kill is the SAME signal the attachSlowConsumerMonitor
    // callback above already logged at info-level — propagated here via the
    // throttle.destroy(SLOW_CONSUMER_ERROR_MESSAGE) thrown error. Logging
    // it again at console.error would re-surface every kill as a Sentry
    // "Video streaming error" event (same kill, second signal). Quiet
    // the second path so each kill produces zero Sentry issues; the kill
    // itself remains visible in stdout via the warn-renamed-to-log above.
    if (message === SLOW_CONSUMER_ERROR_MESSAGE) {
      console.log('Video streaming: slow consumer kill completed, S3 socket released');
    } else {
      console.error('Video streaming error:', message);
    }
    if (!res.headersSent) {
      res.status(404).json({ error: 'Video not found in storage' });
    } else if (!res.writableEnded) {
      // Headers (and possibly a partial body) are already on the wire — we
      // can't send a JSON error. Destroy the socket so a mid-stream failure
      // (incl. a clean-frame throw re-raised past the now-guarded fall-
      // through) releases the connection instead of hanging half-written.
      // The res finish/close handler still records the bytes already sent.
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
});
