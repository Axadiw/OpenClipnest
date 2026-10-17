#!/usr/bin/env node
/**
 * CLI: wipe ALL of a user's content (events, file_metadata, S3 objects across
 * the 3 buckets, scan state, upload history, notifications, quota counters)
 * without deleting the user account itself. The user's email/password/FTPS
 * creds, plan, timezone, passkeys, and ban history are preserved.
 *
 * Usage (inside the clipnest-api container, which has DATABASE_URL +
 * CLIPNEST_S3_* + REDIS_URL):
 *   node dist/scripts/wipe-user-content.js <email> [--dry-run] [--yes]
 *
 * Without --yes: prints a pre-flight summary and exits without writing.
 * Without --dry-run + with --yes: executes the wipe.
 *
 * Use case: support a user who needs a clean slate after a data incident.
 * The user deletion path (`DELETE FROM users …`) cascades but also nukes
 * the account; this script is the in-between hammer.
 *
 * Exit codes: 0=success or dry-run, 2=env error, 3=user not found,
 *             4=missing --yes confirmation, 1=other failure.
 */
import { Redis } from 'ioredis';
import { CONFIG } from '../config.js';
import { deleteObjectsByPrefix } from '../services/s3.js';
import { publishScanTrigger } from '../services/streamsClient.js';

process.stdout.write('wipe-user-content: starting\n');

interface Args {
  email: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  if (positional.length !== 1) {
    throw new Error('Usage: wipe-user-content <email> [--dry-run] [--yes]');
  }
  return {
    email: positional[0],
    dryRun: flags.has('--dry-run'),
    yes: flags.has('--yes'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Use CONFIG.databaseUrl (not raw process.env.DATABASE_URL) — on prod the
  // env var is provided as bare `host:port/db` and config.ts is what stitches
  // user/password and the postgresql:// scheme onto it. Talking straight to
  // process.env here gives ECONNREFUSED.
  if (!CONFIG.databaseUrl) {
    console.error('CONFIG.databaseUrl is empty — env not initialized');
    process.exit(2);
  }

  const { initDb } = await import('../db/index.js');
  const { getUserByEmail } = await import('../db/queries/users.js');
  const {
    getEventCountForUser, getUserFileCount, deleteEventsByOwner, deleteFileMetadataByOwner,
  } = await import('../db/queries/events.js');
  const {
    deleteUploadEventsByUser, deleteUserScanState, resetUserContentQuota,
  } = await import('../db/queries/storage.js');
  const { deleteAllNotificationsForUser } = await import('../db/queries/notifications.js');
  await initDb();

  let redis: Redis | null = null;
  try {
    const user = await getUserByEmail(args.email);
    if (!user) {
      console.error(`User "${args.email}" not found`);
      process.exit(3);
    }
    const ownerId = user.internalId;
    const uuid = user.id;

    // Pre-flight: count what we're about to touch.
    const [eventCount, fileMetaCount] = await Promise.all([
      getEventCountForUser(ownerId),
      getUserFileCount(ownerId),
    ]);

    // NOTE: upload_events, notifications, user_scan_state counts are not
    // exposed via existing query helpers; use inline db.execute for the
    // pre-flight summary (read-only, no side-effects).
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    const [uploadRow, notifRow, scanRow] = await Promise.all([
      db.execute<{ n: number }>(sql`SELECT COUNT(*)::int n FROM upload_events WHERE user_id = ${ownerId}`),
      db.execute<{ n: number }>(sql`SELECT COUNT(*)::int n FROM notifications WHERE user_id = ${ownerId}`),
      db.execute<{ n: number }>(sql`SELECT COUNT(*)::int n FROM user_scan_state WHERE user_id = ${ownerId}`),
    ]);

    console.log(
      `wipe-user-content: target email=${args.email} uuid=${uuid} ownerId=${ownerId}\n` +
      `                   disk_usage_bytes=${user.diskUsageBytes}\n` +
      `                   events=${eventCount}, file_metadata=${fileMetaCount},\n` +
      `                   upload_events=${(uploadRow.rows[0] as { n: number }).n}, notifications=${(notifRow.rows[0] as { n: number }).n},\n` +
      `                   user_scan_state=${(scanRow.rows[0] as { n: number }).n}\n` +
      `                   buckets to wipe: ${CONFIG.s3RecordingsBucket}, ${CONFIG.s3ThumbnailsBucket}, ${CONFIG.s3SidecarsBucket}\n` +
      `                   prefix: ${uuid}/`,
    );

    if (args.dryRun) {
      console.log('wipe-user-content: dry run complete, no changes applied.');
      return;
    }
    if (!args.yes) {
      console.error(
        'wipe-user-content: refusing to proceed without --yes (safety). ' +
        'Re-run with --yes once you have reviewed the summary above.',
      );
      process.exit(4);
    }

    // --- Step 1: wipe S3 prefixes across all three content buckets ---
    const prefix = `${uuid}/`;
    const buckets = [
      CONFIG.s3RecordingsBucket,
      CONFIG.s3ThumbnailsBucket,
      CONFIG.s3SidecarsBucket,
    ];
    for (const bucket of buckets) {
      console.log(`wipe-user-content: deleting prefix=${prefix} in bucket=${bucket}`);
      const n = await deleteObjectsByPrefix(bucket, prefix);
      console.log(`wipe-user-content:   → deleted ${n} objects from ${bucket}`);
    }

    // --- Step 2: wipe DB rows in a single transaction ---
    // NOTE: This admin script uses bulk DELETE rather than the per-row
    // deleteS3AndMetadata helper from services/fileLifecycle.ts. Reason:
    // wipe-user-content runs against accounts with up to ~50k file_metadata
    // rows; per-row cascade would add ~10 minutes. The helper is for runtime
    // hot paths (event delete, reconciler); bulk-wipe is a one-shot admin
    // tool with full account context — the speed trade-off wins here.
    const { withTx } = await import('../db/index.js');
    let evDelCount = 0;
    let fmDelCount = 0;
    let upDelCount = 0;
    let ntDelCount = 0;
    let ssDelCount = 0;

    // Order matters only when there's no FK cascade. file_metadata,
    // upload_events, notifications, user_scan_state are independent.
    await withTx(async (_tx) => {
      evDelCount = await deleteEventsByOwner(ownerId);
      fmDelCount = await deleteFileMetadataByOwner(ownerId);
      upDelCount = await deleteUploadEventsByUser(ownerId);
      ntDelCount = await deleteAllNotificationsForUser(ownerId);
      ssDelCount = await deleteUserScanState(ownerId);
      // Reset quota counters; transfer_reset_at is set to the start of next
      // month to mirror the policy used in reset-user-quota.ts.
      await resetUserContentQuota(ownerId);
    });

    console.log(
      `wipe-user-content: DB rows deleted — events=${evDelCount} file_metadata=${fmDelCount} ` +
      `upload_events=${upDelCount} notifications=${ntDelCount} user_scan_state=${ssDelCount}; ` +
      `disk/transfer/upload counters reset.`,
    );

    // --- Step 3: clear stale FTPS-auth invalidation cache (best effort) ---
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      // Prod Redis requires AUTH; the ConfigMap exposes REDIS_URL without
      // credentials and the password lives in REDIS_PASSWORD (clipnest-secrets).
      // Compose it into the ioredis options — same pattern as the
      // clipnest-reconcile CronJob fix from PR #170.
      redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        password: process.env.REDIS_PASSWORD || undefined,
      });
      await redis.connect();
      const ftpsInvKey = `ftps:invalidate:${args.email.toLowerCase()}`;
      const removed = await redis.del(ftpsInvKey);
      console.log(`wipe-user-content: redis DEL ${ftpsInvKey} → ${removed}`);

      // --- Step 4: nudge event-manager so its in-memory scan state for this
      //              user is reconciled with the now-empty DB. Empty s3Key
      //              means "older message format" which the scanner treats
      //              as forceFull (services/scanner.ts).
      await publishScanTrigger(uuid, '');
      console.log(`wipe-user-content: published forceFull stream:scan-trigger for ${uuid}`);
    } else {
      console.warn('wipe-user-content: REDIS_URL not set, skipping FTPS auth cache + scan-trigger nudge');
    }

    console.log(`wipe-user-content: done.`);
  } finally {
    if (redis) {
      try { await (redis as Redis).quit(); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stdout.write(`wipe-user-content FAILED: ${msg}\n`);
  process.exit(1);
});
