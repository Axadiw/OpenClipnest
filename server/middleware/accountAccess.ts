import type { RequestHandler } from 'express';
import { isAccessLocked } from '../db/queries/access.js';

/** Body every refused request gets, so clients can show the right message. */
export const ACCOUNT_LOCKED_BODY = { error: 'Account locked', code: 'ACCOUNT_LOCKED' } as const;

/**
 * Refuse the request when the account's access is locked by either lock
 * (users.access_locked_at or users.admin_locked_at). Used on every route that
 * serves recording bytes, mints a media token or deletes recordings. Fails closed on a lookup error.
 */
export const requireUnlockedAccount: RequestHandler = async (req, res, next) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    if (await isAccessLocked(userId)) { res.status(403).json(ACCOUNT_LOCKED_BODY); return; }
  } catch (err) {
    console.error('Account access check failed:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal error' });
    return;
  }
  next();
};
