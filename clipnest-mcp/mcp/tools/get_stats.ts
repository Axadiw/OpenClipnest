import { getDiskUsageByCamera } from '../../../server/db/queries/storage.js';
import { getCameraDetails } from '../../../server/db/queries/events.js';
import type { McpAuthContext } from '../bearerAuth.js';

export type GetStatsInput = Record<string, never>;

export interface CameraStat {
  name: string;
  /** Displayable clip count for this camera. */
  clipCount: number;
  /** Sum of recording durations (seconds) for this camera. */
  durationSeconds: number;
  /** Storage used by this camera's recordings, in bytes. */
  storageBytes: number;
  /** ISO timestamp of the earliest displayable recording. */
  firstRecordingAt: string | null;
  /** ISO timestamp of the most recent displayable recording. */
  lastRecordingAt: string | null;
}

export interface GetStatsOutput {
  /** Total displayable clips across all cameras. */
  totalClips: number;
  /** Total storage used across all cameras, in bytes. */
  totalStorageBytes: number;
  /** Overall capture-time range across all cameras (null when no recordings). */
  dateRange: { from: string | null; to: string | null };
  perCamera: CameraStat[];
}

export const getStatsToolDescriptor = {
  name: 'get_stats',
  description:
    "Aggregate statistics for the user's footage: per-camera clip counts, recorded duration, storage usage, and the overall date range.",
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
} as const;

export async function getStatsImpl(
  _input: GetStatsInput,
  auth: McpAuthContext,
): Promise<GetStatsOutput> {
  // 1. Scope gate.
  if (!auth.scope.split(/\s+/).includes('account:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. Both queries are owner-scoped (WHERE owner_id = $1) and operate purely on
  //    `events` / `event_view_files` / `file_metadata` — NOT on `upload_events`,
  //    so this never triggers the upload_events full-scan (see memory:
  //    admin-user-list-slow-upload-events).
  const [usage, details] = await Promise.all([
    getDiskUsageByCamera(auth.userId),
    getCameraDetails(auth.userId),
  ]);

  // First/last per camera comes from getCameraDetails; merge it onto the
  // disk-usage rows (which carry bytes + duration + the displayable count).
  const firstLastByCamera = new Map<string, { first: string; last: string }>();
  for (const d of details) {
    firstLastByCamera.set(d.camera, { first: d.firstEventAt, last: d.lastEventAt });
  }

  const perCamera: CameraStat[] = usage.map(u => {
    const fl = firstLastByCamera.get(u.cameraName);
    return {
      name: u.cameraName,
      clipCount: u.eventCount,
      durationSeconds: u.durationSeconds,
      storageBytes: u.bytes,
      firstRecordingAt: fl?.first ?? null,
      lastRecordingAt: fl?.last ?? null,
    };
  });

  const totalClips = perCamera.reduce((acc, c) => acc + c.clipCount, 0);
  const totalStorageBytes = perCamera.reduce((acc, c) => acc + c.storageBytes, 0);

  // Overall range = min(first), max(last) across cameras. Timestamps are ISO
  // strings (wall-clock baked as UTC), so lexicographic compare is correct.
  let from: string | null = null;
  let to: string | null = null;
  for (const d of details) {
    if (from === null || d.firstEventAt < from) from = d.firstEventAt;
    if (to === null || d.lastEventAt > to) to = d.lastEventAt;
  }

  return {
    totalClips,
    totalStorageBytes,
    dateRange: { from, to },
    perCamera,
  };
}
