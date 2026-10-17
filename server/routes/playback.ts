import { Router } from 'express';
import {
  platformBucket,
  recordPlaybackCompleted,
  recordPlaybackStarted,
} from '../utils/metrics.js';

const router = Router();

/**
 * POST /api/v0/playback
 *
 * The clients' playback beacon. "Playback started" and "watched to the end"
 * only exist inside a player: the server sees byte-range requests, and those
 * cannot tell watching from seeking — every player fetches the tail of an mp4
 * to read its moov atom, so inferring completion server-side would count a clip
 * as finished the moment it was opened.
 *
 * Body: `{ kind: 'started' | 'completed', platform: <client> }`.
 *   started   — the first real play of a loaded source. The clients guard this
 *               per source, so pause/resume and seeking do not re-fire it.
 *   completed — the player's `ended` event. Deliberately literal: someone who
 *               closes the tab at 98% did not watch to the end.
 *
 * NOTHING IS PERSISTED. This handler increments a process-local Prometheus
 * counter and returns 204 — there is no watch history, no user id, no event id,
 * not even a log line. That is what keeps an aggregate product metric from
 * quietly becoming per-user behavioural data, and it is the reason this route
 * can exist without a Privacy Policy change. If a future change needs per-user
 * or per-recording playback data, that is a different feature with a different
 * privacy review — do not grow it here.
 *
 * Mounted behind `requireAuth`, so only real sessions can move the counters.
 * `platform` is re-bucketed through the fixed enum, so a client cannot mint new
 * label values.
 *
 * Always 204, even on a malformed body: a beacon must never turn into an error
 * the player has to handle, and a wrong count is not worth a failed request in
 * front of a user watching a video.
 */
router.post('/', (req, res) => {
  const { kind, platform } = (req.body ?? {}) as { kind?: unknown; platform?: unknown };
  const bucket = platformBucket(platform);

  if (kind === 'started') recordPlaybackStarted(bucket);
  else if (kind === 'completed') recordPlaybackCompleted(bucket);

  res.status(204).end();
});

export default router;
