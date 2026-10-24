// Push Worker — standalone entrypoint.
//
// Consumes `stream:push` (group `push-workers`); for each job: resolve the
// target user's push preferences (snooze window + per-category toggles) and
// registered device tokens, build the payload, and hand it to the edition's
// push transport for every device (Clipnest Cloud: APNs/FCM directly;
// self-hosted: the Clipnest push relay, end-to-end encrypted). Tokens the
// transport reports as permanently invalid (410 / BadDeviceToken /
// Unregistered) are pruned from `push_devices`.
//
// Delivery semantics: at-least-once via XREADGROUP + XACK-after-process, same
// as the thumbnail worker. Push is best-effort, so the handler swallows
// per-device send failures (logged, not thrown) and only re-throws on
// infrastructure errors (DB unreachable) so XCLAIM retries. A poison-pill
// (malformed job) is acked as a no-op.
//
// `new_recording` carries a thumbnail: we set `mutable-content: 1` and a
// `thumbnailUrl` custom key pointing at the authenticated thumbnail endpoint
// with a freshly-minted short-lived media token in the query string, so the
// iOS Notification Service Extension can download + attach the image without
// the user's session token. See buildPushForJob() for the exact payload.

import { initDb } from './db/index.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';
import { getUserByInternalId } from './db/queries/users.js';
import {
  getPushPrefs,
  getPushDevicesForUser,
  prunePushDeviceByToken,
} from './db/queries/push.js';
import { generateMediaToken } from './services/auth.js';
import { categoryForKind, type PushOptions } from './services/push/types.js';
import { pushTransport } from './services/push/transport.js';
import {
  consume,
  scheduleStaleConsumerCleanup,
  STREAM_PUSH,
  STREAM_DLQ_PUSH,
  GROUP_PUSH_WORKERS,
} from './services/streamsClient.js';
import { CONFIG } from './config.js';
import { startHealthzServer } from './utils/healthz.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

interface PushJob {
  userId: number;
  notificationId: string;
  kind: string;
  title: string;
  message: string;
  /** Parsed notification `details` (eventId, camera, …). */
  details: Record<string, unknown>;
}

/**
 * Decide whether this job should be delivered for the given prefs. Returns a
 * reason string when it should be SKIPPED, or null when it should be sent.
 *
 *  - snooze: a `snoozeUntil` in the future suppresses ALL pushes.
 *  - category: `categories[kind] === false` suppresses that kind. Any other
 *    value (true, or absent) means "deliver" — opt-out model.
 */
export function pushSkipReason(
  job: { kind: string },
  prefs: { snoozeUntil: string | null; categories: Record<string, boolean> },
  now: number = Date.now(),
): string | null {
  if (prefs.snoozeUntil) {
    const until = Date.parse(prefs.snoozeUntil);
    if (!Number.isNaN(until) && until > now) return 'snoozed';
  }
  if (prefs.categories[job.kind] === false) return 'category_disabled';
  return null;
}

/**
 * Build the APNs PushOptions for a job, including the per-recording thumbnail
 * URL for `new_recording`. Exported for unit testing the payload shape without
 * a DB or socket.
 *
 * For `new_recording`:
 *   - `mutableContent: true` so the iOS NSE runs and can attach the image.
 *   - `threadId = camera` so all banners from one camera collapse/group.
 *   - `custom.thumbnailUrl` = absolute URL to the authenticated thumbnail
 *     endpoint, with `media_token` in the query string. The NSE fetches this
 *     directly (no auth header). `custom.eventId` lets the app deep-link to
 *     the recording on tap.
 */
export function buildPushForJob(
  job: PushJob,
  opts: { thumbnailUrl?: string } = {},
): PushOptions {
  const custom: Record<string, unknown> = { notificationId: job.notificationId };

  // Localized-alert fields (set on the notification's `details` at creation).
  // Present → loc-capable devices get an APNs loc-key alert; others (and any
  // kind without a locKey) keep the literal title/body. The title key is
  // derived from the kind so one catalog title serves every body variant.
  const locKey = typeof job.details.locKey === 'string' ? job.details.locKey : undefined;
  const locArgs = Array.isArray(job.details.locArgs)
    ? job.details.locArgs.map((a) => String(a))
    : undefined;
  const titleLocKey = locKey ? `notif.${job.kind}.title` : undefined;

  if (job.kind === 'new_recording') {
    const eventId = typeof job.details.eventId === 'string' ? job.details.eventId : undefined;
    const camera = typeof job.details.camera === 'string' ? job.details.camera : undefined;
    if (eventId) custom.eventId = eventId;
    if (camera) custom.camera = camera;
    if (opts.thumbnailUrl) custom.thumbnailUrl = opts.thumbnailUrl;
    return {
      title: job.title,
      body: job.message,
      kind: job.kind,
      category: categoryForKind(job.kind),
      threadId: camera,
      mutableContent: Boolean(opts.thumbnailUrl),
      custom,
      titleLocKey,
      locKey,
      locArgs,
    };
  }

  return {
    title: job.title,
    body: job.message,
    kind: job.kind,
    category: categoryForKind(job.kind),
    custom,
    titleLocKey,
    locKey,
    locArgs,
  };
}

/**
 * Mint the thumbnail URL for a `new_recording` push. Returns undefined when
 * the job isn't a new_recording, has no eventId, or the user can't be
 * resolved. The media token is a standard SPA media token (HS256, bound to
 * `mediaEventId`, ~15 min TTL) — identical to what POST /events/:id/media-token
 * issues — accepted by requireAuth via the `media_token` query param.
 */
export async function mintThumbnailUrl(job: PushJob): Promise<string | undefined> {
  if (job.kind !== 'new_recording') return undefined;
  const eventId = typeof job.details.eventId === 'string' ? job.details.eventId : undefined;
  if (!eventId) return undefined;

  const user = await getUserByInternalId(job.userId);
  if (!user) return undefined;

  const token = generateMediaToken(
    {
      userId: user.internalId,
      userUuid: user.id, // getUserByInternalId maps uuid → `id`
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: user.tokenGeneration,
    },
    eventId,
  );

  // CONFIG.publicAppUrl already strips the trailing slash.
  return `${CONFIG.publicAppUrl}/api/v0/events/${encodeURIComponent(eventId)}/thumbnail?media_token=${encodeURIComponent(token)}`;
}

/**
 * Process one push job: filter on prefs, resolve devices, send to each, prune
 * dead tokens. Best-effort — per-device send errors are logged, not thrown.
 * Re-throws only on DB errors so XCLAIM retries the whole job.
 */
export async function processPushJob(job: PushJob): Promise<void> {
  const prefs = await getPushPrefs(job.userId);
  const skip = pushSkipReason(job, prefs);
  if (skip) {
    console.log(`Push worker: skipping notification ${job.notificationId} for user ${job.userId} (${skip})`);
    return;
  }

  const devices = await getPushDevicesForUser(job.userId);
  if (devices.length === 0) {
    // Common + expected: a user with no app installed. Quiet.
    return;
  }

  const transport = pushTransport();
  if (!transport.configured()) {
    console.warn(
      `Push worker: ${transport.name} transport not configured — ${devices.length} device(s) for ` +
      `user ${job.userId} not notified for ${job.notificationId}`,
    );
    return;
  }

  // Mint the thumbnail URL once per job (not per device) — it's user-scoped.
  let thumbnailUrl: string | undefined;
  try {
    thumbnailUrl = await mintThumbnailUrl(job);
  } catch (err) {
    console.warn(
      `Push worker: thumbnail URL mint failed for ${job.notificationId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payloadOpts = buildPushForJob(job, { thumbnailUrl });

  // The transport routes per platform; every path returns the same
  // SendPushResult, so pruning is uniform.
  await Promise.all(
    devices.map(async (device) => {
      const result = await transport.send(device, payloadOpts);
      if (result.ok) return;
      if (result.shouldPrune) {
        console.log(
          `Push worker: pruning dead ${device.platform} token for user ${job.userId} ` +
          `(status=${result.status} reason=${result.reason ?? 'n/a'})`,
        );
        await prunePushDeviceByToken(device.deviceToken).catch((err) =>
          console.warn(
            `Push worker: prune failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      console.warn(
        `Push worker: ${device.platform} send failed for user ${job.userId} notification ` +
        `${job.notificationId} (status=${result.status} reason=${result.reason ?? 'n/a'})`,
      );
    }),
  );
}

// --- Startup ---

await initDb();
console.log('Push worker: database initialized');

{
  const transport = pushTransport();
  if (!transport.configured()) {
    console.warn(
      `Push worker: ${transport.name} transport is NOT configured (${transport.describeMissing()}). ` +
      'The worker will run and drain the stream but send nothing.',
    );
  } else {
    console.log(`Push worker: delivering via ${transport.name}`);
  }
}

const PUSH_CONCURRENCY = parseInt(process.env.PUSH_CONCURRENCY || '10', 10);

const consumer = consume<PushJob>({
  stream: STREAM_PUSH,
  group: GROUP_PUSH_WORKERS,
  dlq: STREAM_DLQ_PUSH,
  count: PUSH_CONCURRENCY,
  concurrency: PUSH_CONCURRENCY,
  parse: (f) => {
    let details: Record<string, unknown> = {};
    try {
      const parsed = f.details ? JSON.parse(f.details) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed details — treat as empty; handler still validates fields */
    }
    return {
      userId: Number(f.userId ?? 'NaN'),
      notificationId: f.notificationId ?? '',
      kind: f.kind ?? '',
      title: f.title ?? 'Clipnest',
      message: f.message ?? '',
      details,
    };
  },
  handler: async (job) => {
    if (!Number.isFinite(job.userId) || !job.kind) {
      console.warn('Push worker: received malformed job:', job);
      return; // ack malformed — retry won't help
    }
    await processPushJob(job);
  },
});

const HEALTHZ_PORT = parseInt(process.env.HEALTHZ_PORT || '3003', 10);
startHealthzServer(HEALTHZ_PORT, 'push-worker');

// Periodic stale-consumer cleanup — every pod restart leaks a consumer entry
// into the `push-workers` group; prune them like the other workers do.
scheduleStaleConsumerCleanup(STREAM_PUSH, GROUP_PUSH_WORKERS);

console.log('Push worker: ready, waiting for jobs');

// Graceful drain: stop the consumer loop (finishes the in-flight batch) and
// close the transport (APNs HTTP/2 session) so SIGTERM doesn't drop a half-sent
// push or leave a dangling socket. Mirrors the consume().stop() contract.
async function shutdown(signal: string): Promise<void> {
  console.log(`Push worker: ${signal} received, draining…`);
  try {
    await consumer.stop();
  } catch (err) {
    console.warn('Push worker: consumer stop error:', err instanceof Error ? err.message : String(err));
  }
  try {
    await pushTransport().close();
  } catch (err) {
    console.warn('Push worker: transport close error:', err instanceof Error ? err.message : String(err));
  }
  console.log('Push worker: drained, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
