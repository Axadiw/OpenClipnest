import { Router, type Request, type Response } from 'express';
import type { Readable } from 'stream';
import { Buffer } from 'buffer';
import { CONFIG } from '../config.js';
import {
  getEvents, getEventByIdForOwner, getCameraNames, getCameraDetails,
  getEventCalendar, THUMBNAIL_UNPLAYABLE,
} from '../db/queries/events.js';
import { updateTransferUsage, checkAndResetTransfer, getUserQuota } from '../db/queries/storage.js';
import { getUserByInternalId } from '../db/queries/users.js';
import { deleteEventAndThumbnail } from '../services/eventCleanup.js';
import { deleteS3AndMetadata, deleteRecordingAllBuckets } from '../services/fileLifecycle.js';
import { generateMediaToken } from '../services/auth.js';
import { getObject, headObject } from '../services/s3.js';
import { resolveS3Path } from '../utils/s3path.js';
import { mediaRateLimit } from '../middleware/rateLimit.js';
import { pipeS3ToResponse } from '../utils/s3Stream.js';
import { enrichEventsWithViewMeta, enrichEventWithViewMeta } from '../services/cameraProfileResolver.js';
import { videoRouter } from './events/video.js';
import { requireUnlockedAccount } from '../middleware/accountAccess.js';

const router = Router();

// Video / HLS routes split out into ./events/video.ts. Mounted FIRST so the
// specific `/:id/video/:view/...` paths don't get shadowed by the parametric
// `/:id/detail` and `/:id/thumbnail` handlers defined below — Express matches
// in registration order, and `router.use(videoRouter)` registers its child
// stack before any later `router.get(...)` here.
router.use(videoRouter);

/**
 * Helper: get the user's encryption salt from DB.
 */
async function getUserSalt(userId: number): Promise<string | undefined> {
  const user = await getUserByInternalId(userId);
  return user?.encryptionSalt;
}

/**
 * Decode an opaque cursor string produced by a previous `nextCursor`
 * response. Encoding is `base64url(JSON.stringify({ t, i }))` — chosen
 * over a plain "${ts}|${id}" string so clients can't trivially craft a
 * cursor that points at an arbitrary row, and so changing the cursor
 * shape later doesn't break URLs. Malformed cursors fall back to "no
 * cursor" (first page) rather than 400 — a stale link is more useful as
 * "top of list" than as a hard error.
 */
function decodeCursor(raw: unknown): { timestamp: string; id: string } | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return undefined;
    // Sanity-check the timestamp shape — anything else and we treat as
    // missing rather than feeding garbage into Postgres's ::timestamptz cast.
    if (Number.isNaN(Date.parse(parsed.t))) return undefined;
    return { timestamp: parsed.t, id: parsed.i };
  } catch {
    return undefined;
  }
}

function encodeCursor(c: { timestamp: string; id: string } | null): string | null {
  if (!c) return null;
  return Buffer.from(JSON.stringify({ t: c.timestamp, i: c.id }), 'utf8').toString('base64url');
}

// HH:MM 00:00–23:59, zero-padded. Anything else (`5:00`, `25:00`, `09:60`)
// fails the regex so we never feed unsafe text into SQL or compare it
// lexicographically against `substring(timestamp,12,5)` where it'd silently
// behave like a tighter/looser bound than the user expected.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// datetime-local input shape: `YYYY-MM-DDTHH:MM` (no seconds, no zone). We
// normalize to the stored timestamp form `YYYY-MM-DDTHH:MM:00.000Z` so the
// lexicographic comparison against `events.timestamp` (TEXT, see db.ts
// keyset-pagination notes) lines up at the second/millisecond level.
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

function normalizeRangeBound(s: string | undefined): string | undefined {
  if (!s || !DATETIME_LOCAL_RE.test(s)) return undefined;
  return `${s}:00.000Z`;
}

/**
 * Streaming-handler error sink. If the response is still in its init phase
 * (no headers transmitted yet) we send a JSON error the way every other
 * route does. If headers — or worse, bytes — are already on the wire, we
 * cannot send a JSON 500 without tripping `ERR_HTTP_HEADERS_SENT`, so we
 * `res.destroy(err)` instead. The
 * destroy yanks the socket; the client sees an abrupt close and retries on
 * its next render, which is the only safe recovery once a partial body
 * has been transmitted.
 *
 * Only used on streaming branches (thumbnail body, video body) where the
 * race actually exists. Init-phase 4xx/5xx returns already complete the
 * response before any byte is written and don't need this guard.
 *
 * Exported for unit tests — see `events.test.ts`.
 */
export function endStreamWithError(res: Response, err: unknown, fallbackStatus = 500): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(fallbackStatus).json({ error: 'stream_failed', detail: msg });
}

router.get('/', async (req, res) => {
  try {
    const cursor = decodeCursor(req.query.cursor);
    const parsedLimit = parseInt(req.query.limit as string, 10);
    const MAX_LIMIT = 1000;
    const rawLimit = isNaN(parsedLimit) ? CONFIG.itemsPerPage : parsedLimit;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
    const cameras = req.query.camera
      ? (Array.isArray(req.query.camera) ? req.query.camera as string[] : [req.query.camera as string])
      : undefined;
    const userId = req.user?.userId;

    // Time-filter mode. `range` = continuous datetime [from, to); anything
    // else (including missing) = daily mode with optional HH:MM mask.
    const mode = req.query.mode === 'range' ? 'range' : 'daily';
    let dateFrom: string | undefined;
    let dateTo: string | undefined;
    let timeFrom: string | undefined;
    let timeTo: string | undefined;
    let rangeFrom: string | undefined;
    let rangeTo: string | undefined;

    if (mode === 'range') {
      const rawFrom = typeof req.query.from === 'string' ? req.query.from : undefined;
      const rawTo = typeof req.query.to === 'string' ? req.query.to : undefined;
      const nFrom = normalizeRangeBound(rawFrom);
      const nTo = normalizeRangeBound(rawTo);
      // Both-or-neither: half-set ranges silently degrade to "no range filter"
      // rather than 400, matching the half-set timeFrom/timeTo policy below.
      if (nFrom && nTo) {
        rangeFrom = nFrom;
        rangeTo = nTo;
      }
    } else {
      dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
      dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
      const rawTimeFrom = typeof req.query.timeFrom === 'string' ? req.query.timeFrom : undefined;
      const rawTimeTo = typeof req.query.timeTo === 'string' ? req.query.timeTo : undefined;
      if (rawTimeFrom && rawTimeTo && TIME_RE.test(rawTimeFrom) && TIME_RE.test(rawTimeTo)) {
        timeFrom = rawTimeFrom;
        timeTo = rawTimeTo;
      }
    }

    const result = await getEvents({
      cameras, dateFrom, dateTo, timeFrom, timeTo, rangeFrom, rangeTo,
      cursor, limit, userId,
      ownerId: userId,  // Filter to only this user's events
    });
    const enrichedEvents = req.user?.userUuid
      ? await enrichEventsWithViewMeta(result.events, req.user.userUuid)
      : result.events;
    res.json({
      events: enrichedEvents,
      total: result.total,
      nextCursor: encodeCursor(result.nextCursor),
    });
  } catch (err) {
    console.error('Get events error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

router.get('/cameras', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.json({ cameras: await getCameraNames(userId) });
  } catch (err) {
    console.error('Get cameras error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch cameras' });
  }
});

router.get('/cameras/detailed', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.json({ cameras: await getCameraDetails(userId) });
  } catch (err) {
    console.error('Get cameras detailed error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch camera details' });
  }
});

/**
 * Calendar density: per-day event counts inside a date window. The frontend
 * Timeline view feeds this to the date-picker popover so each day cell can
 * be shaded by how active it was — saves the user from blindly scrolling
 * past long stretches with no recordings on any camera.
 */
router.get('/calendar', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    // Strict YYYY-MM-DD validation. Anything else is rejected so we never
    // pass an SQL fragment as a date or query an unbounded window.
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(from) || !dateRe.test(to)) {
      res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: 'from must be on or before to' });
      return;
    }
    // Cap the window at ~1 year so a malicious or buggy client can't ask
    // us to roll up the full table in one shot.
    const fromMs = Date.parse(from + 'T00:00:00Z');
    const toMs = Date.parse(to + 'T00:00:00Z');
    if (toMs - fromMs > 366 * 24 * 3600_000) {
      res.status(400).json({ error: 'window must not exceed 366 days' });
      return;
    }
    const days = await getEventCalendar(userId, from, to);
    res.json({ days });
  } catch (err) {
    console.error('Get calendar error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
});


router.get('/:id/detail', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const event = await getEventByIdForOwner(req.params.id, userId);
    if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

    const enriched = req.user?.userUuid
      ? await enrichEventWithViewMeta(event, req.user.userUuid)
      : event;
    res.json({ event: enriched });
  } catch (err) {
    console.error('Get event detail error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

router.post('/:id/media-token', requireUnlockedAccount, async (req: Request<{ id: string }>, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const event = await getEventByIdForOwner(req.params.id, userId);
    if (!event) { res.status(404).json({ error: 'Event not found' }); return; }
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const token = generateMediaToken(req.user, req.params.id);

    // Pre-resolve original video sizes so the frontend can render its
    // buffer indicator ("X MB / Y MB") without a separate Range:bytes=0-0
    // probe to the video endpoint. The probe used to add one round trip
    // + one auth/throttle hit per video load. HEAD lookups here are
    // cheap (S3 metadata only) and we already do them on first byte of
    // /video/:viewId — moving them to token issuance shifts cost, doesn't
    // add it. The response shape is `viewSizes: { [viewId]: bytes }` so
    // it generalises across N-view cameras.
    const viewSizes: Record<string, number> = {};
    const userSalt = await getUserSalt(userId);
    if (userSalt) {
      const userUuid = req.user.userUuid;
      for (const view of event.views) {
        const original = resolveS3Path(userUuid, view.videoRelPath);
        if (!original) continue;
        try {
          const h = await headObject(original.bucket, original.key, userSalt);
          viewSizes[view.id] = h.contentLength;
        } catch { /* missing in S3 — skip this view, frontend treats as unknown */ }
      }
    }

    res.json({
      token,
      ...(Object.keys(viewSizes).length > 0 && { viewSizes }),
    });
  } catch (err) {
    console.error('Media token error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to generate media token' });
  }
});

router.get('/:id/thumbnail', mediaRateLimit, async (req: Request<{ id: string }>, res) => {
  // Validate media token scope if used
  if (req.user?.mediaEventId && req.user.mediaEventId !== req.params.id) {
    res.status(403).json({ error: 'Token not valid for this resource' });
    return;
  }

  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const userSalt = await getUserSalt(userId);
  if (!userSalt) { res.status(500).json({ error: 'User encryption key not found' }); return; }

  const event = await getEventByIdForOwner(req.params.id, userId);
  if (!event || !event.thumbnail) {
    res.status(404).json({ error: 'Thumbnail not found' });
    return;
  }
  // Tombstone: ffmpeg couldn't extract a frame (corrupt MP4). Return 410 so
  // the frontend can distinguish "never produced" (404) from "won't ever be
  // produced" and render a dedicated placeholder without retry-polling.
  if (event.thumbnail === THUMBNAIL_UNPLAYABLE) {
    res.status(410).json({ error: 'Thumbnail unavailable: source video is unplayable' });
    return;
  }

  const s3Path = resolveS3Path(req.user!.userUuid, event.thumbnail);
  if (!s3Path) { res.status(404).json({ error: 'File not found' }); return; }

  // Init phase: any failure here happens BEFORE response bytes hit the wire,
  // so the legacy "404 Thumbnail not found in storage" reply works fine. The
  // streaming phase below has its own error path (endStreamWithError) — we
  // must NOT collapse them into one try/catch, because once pipeS3ToResponse
  // has flushed headers a `res.status().json()` here would race
  // (ERR_HTTP_HEADERS_SENT).
  let thumbHead: { contentLength: number };
  let body: Readable;
  try {
    thumbHead = await headObject(s3Path.bucket, s3Path.key, userSalt);

    // Transfer quota pre-check (enforce before streaming)
    const { transferUsageBytes } = await checkAndResetTransfer(userId);
    const quota = await getUserQuota(userId);
    if (quota && quota.transferLimitBytes > 0 && transferUsageBytes + thumbHead.contentLength > quota.transferLimitBytes) {
      res.status(429).json({ error: 'Monthly transfer quota exceeded' });
      return;
    }

    const obj = await getObject(s3Path.bucket, s3Path.key, userSalt);
    body = obj.body as Readable;
  } catch {
    res.status(404).json({ error: 'Thumbnail not found in storage' });
    return;
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', thumbHead.contentLength);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Record transfer usage EXACTLY ONCE on completion against the bytes actually
  // written to the socket. The old
  // fire-and-forget `updateTransferUsage` after `await pipeS3ToResponse` only
  // ran on the clean-finish path, so a client abort mid-thumbnail escaped the
  // meter; and a thrown completion + retry could re-bill. A single finish/close
  // handler on actual bytesWritten covers clean end, abort, and slow-kill once,
  // without delaying the response. Slightly conservative (counts headers).
  const thumbSocketStart = (res.socket?.bytesWritten ?? 0);
  const thumbPlanned = thumbHead.contentLength;
  let thumbRecorded = false;
  const recordThumbTransferOnce = (): void => {
    if (thumbRecorded) return;
    thumbRecorded = true;
    const socketDelta = (res.socket?.bytesWritten ?? thumbSocketStart) - thumbSocketStart;
    // Prefer the real socket delta (accurate for mid-stream aborts), capped at
    // the advertised Content-Length so headers don't over-bill; fall back to the
    // planned size when the socket isn't observable (in-memory test transport).
    const sent = socketDelta > 0 ? Math.min(socketDelta, thumbPlanned) : thumbPlanned;
    if (sent > 0) void updateTransferUsage(userId, sent);
  };
  res.once('finish', recordThumbTransferOnce);
  res.once('close', recordThumbTransferOnce);

  try {
    // pipeS3ToResponse (not raw .pipe) so a client abort destroys the S3
    // Readable and releases the keep-alive socket — otherwise the agent
    // pins it as in-use for 30 s and a sustained leak rate wedges the
    // pool. See utils/s3Stream.ts and utils/socketPoolWedge.ts.
    await pipeS3ToResponse(body, res);
  } catch (err) {
    // Stream failure AFTER headers flushed (S3 mid-stream hiccup, client
    // disconnect, slow-consumer kill). We cannot send a JSON 500 here —
    // headers are already on the wire. endStreamWithError destroys the
    // socket; the browser silently retries the thumbnail on next render.
    endStreamWithError(res, err);
  }
});

/**
 * Remove every S3 object associated with an event (wide, zoom, thumbnail)
 * and drop the DB row. Updates `disk_usage_bytes` inline so the user's
 * usage display in Settings reflects the freed space immediately — the
 * 1-min `storageReconciler` is still the safety net for any drift, but
 * it can't be the primary path because the UX of "click delete, see your
 * GBs free up only after 1 min" is bad. Pre-v0.10.12 this was the
 * documented behaviour; flagged + fixed after a user report.
 *
 * Size source priority:
 *   1. `file_metadata.file_size_bytes` — populated by the FTPS upload hook
 *      and by the reconciler's S3-list backfill, so it covers everything
 *      from this release forward + everything seen by at least one
 *      reconciler pass.
 *   2. S3 HEAD with the user's SSE-C salt — fallback for legacy events that
 *      predate the file_metadata FIFO and haven't been reconciler-touched.
 *   3. Skip the decrement — last resort if both above fail (S3 already gone
 *      / IAM blip / etc.). The reconciler will sync `disk_usage_bytes`
 *      from the real S3 sum on its next pass.
 *
 * Generated thumbnails (`__s3_thumb__/...`) live in the thumbnails bucket
 * and don't count against the user's quota — we still delete them, but we
 * don't include their size in the inline decrement.
 */
async function deleteEventOwned(
  eventId: string,
  userId: number,
  userUuid: string,
  _encryptionSalt: string,
): Promise<'ok' | 'not_found'> {
  const event = await getEventByIdForOwner(eventId, userId);
  if (!event) return 'not_found';

  const paths = [...event.views.map(l => l.videoRelPath), event.thumbnail]
    .filter((p): p is string => !!p && p !== THUMBNAIL_UNPLAYABLE);

  for (const p of paths) {
    const loc = resolveS3Path(userUuid, p);
    if (!loc) continue;
    try {
      if (loc.bucket === CONFIG.s3RecordingsBucket) {
        // deleteRecordingAllBuckets deletes: the recording itself, the
        // per-recording .jpg thumbnail, and the .fmp4patch sidecar — all
        // with file_metadata + disk_usage_bytes cascade via deleteS3AndMetadata.
        await deleteRecordingAllBuckets({
          ownerId: userId,
          recordingS3Key: loc.key,
          reason: 'event-delete',
        });
      } else {
        // Thumbnails bucket (generated __s3_thumb__ entries or camera-uploaded
        // JPGs stored there). No sidecar exists for these.
        await deleteS3AndMetadata({
          ownerId: userId,
          s3Bucket: loc.bucket,
          s3Key: loc.key,
          reason: 'event-delete',
        });
      }
    } catch (err) {
      console.warn(
        `delete event ${eventId}: lifecycle delete failed for ${loc.key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // deleteEventAndThumbnail also removes the generated `__generated__/{id}.jpg`
  // thumbnail from the thumbnails bucket — its file_metadata row (if any)
  // gets cleaned by the safety-net loop. Disk usage decrement now happens
  // inside deleteS3AndMetadata per recording bucket row.
  await deleteEventAndThumbnail(eventId, userId, userUuid, 'user');

  return 'ok';
}

router.delete('/:id', requireUnlockedAccount, async (req: Request<{ id: string }>, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const user = await getUserByInternalId(userId);
    if (!user || !user.encryptionSalt) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const result = await deleteEventOwned(req.params.id, userId, user.id, user.encryptionSalt);
    if (result === 'not_found') { res.status(404).json({ error: 'Event not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete event error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

const BULK_DELETE_LIMIT = 100;

router.delete('/', requireUnlockedAccount, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
    const confirm = req.query.confirm === 'true';
    if (!confirm) { res.status(400).json({ error: 'confirm=true is required' }); return; }
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) { res.status(400).json({ error: 'No ids provided' }); return; }
    if (ids.length > BULK_DELETE_LIMIT) {
      res.status(400).json({ error: `Too many ids (max ${BULK_DELETE_LIMIT})` });
      return;
    }
    const user = await getUserByInternalId(userId);
    if (!user || !user.encryptionSalt) { res.status(401).json({ error: 'Unauthorized' }); return; }
    let deleted = 0;
    const notFound: string[] = [];
    for (const id of ids) {
      const r = await deleteEventOwned(id, userId, user.id, user.encryptionSalt);
      if (r === 'ok') deleted++;
      else notFound.push(id);
    }
    res.json({ deleted, notFound, requested: ids.length });
  } catch (err) {
    console.error('Bulk delete error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed bulk delete' });
  }
});

export default router;
