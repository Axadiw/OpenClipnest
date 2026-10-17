/**
 * `/api/v0/users/me/processing-status` — surfaces work-in-flight from the
 * upload→worker pipeline. Frontend polls this endpoint at low frequency to
 * render the "Processing N files…" banner.
 *
 * Returns inProgressCount (file_metadata rows missing a sidecar and not
 * tombstoned) + inProgressFiles preview list. Permanent failures are NOT
 * surfaced — they're tombstoned silently (playback_unplayable=TRUE on the
 * event hides it from the grid). Retired 2026-05-13; see DROP TABLE
 * processing_failures in db.ts.
 */
import { Router } from 'express';
import { getProcessingStatus } from '../db/queries/events.js';

const router = Router();

router.get('/processing-status', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const status = await getProcessingStatus(userId);
    res.json(status);
  } catch (err) {
    console.error('processing-status error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch processing status' });
  }
});

export default router;
