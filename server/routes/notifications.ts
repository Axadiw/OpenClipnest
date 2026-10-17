import { Router } from 'express';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadNotificationCount,
  deleteNotification,
  deleteReadNotifications,
} from '../db/queries/notifications.js';

const router = Router();

router.get('/', async (req, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const items = await listNotifications(req.user!.userId, { limit, before });
  res.json({ notifications: items });
});

router.get('/unread-count', async (req, res) => {
  const count = await getUnreadNotificationCount(req.user!.userId);
  res.json({ count });
});

router.post('/:id/read', async (req, res) => {
  const ok = await markNotificationRead(req.user!.userId, req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Notification not found or already read' });
    return;
  }
  res.json({ success: true });
});

router.post('/read-all', async (req, res) => {
  const updated = await markAllNotificationsRead(req.user!.userId);
  res.json({ success: true, updated });
});

// Per-row delete. Returns 404 if the row doesn't belong to this user so
// notification IDs can't be probed cross-user. Allowed for both read and
// unread rows — the UI currently only exposes it on read ones, but a user
// is always authorized to remove their own notification regardless of state.
router.delete('/:id', async (req, res) => {
  const ok = await deleteNotification(req.user!.userId, req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  res.json({ success: true });
});

router.delete('/', async (req, res) => {
  const deleted = await deleteReadNotifications(req.user!.userId);
  res.json({ success: true, deleted });
});

export default router;
