import { Router } from 'express';
import { CONFIG } from '../config.js';
import {
  deviceCodeGenerateRateLimit,
  deviceCodePollRateLimit,
} from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/editionGuards.js';
import { issueSessionTokens } from '../services/sessions.js';
import { getUserByInternalId } from '../db/queries/users.js';
import {
  generateUserCode,
  formatUserCode,
  normalizeUserCode,
  generateDeviceCode,
} from '../services/tvDeviceAuth.js';
import {
  createDeviceCode,
  approveDeviceCode,
  getDeviceCodeByDeviceCode,
  markDeviceCodeUsed,
  invalidatePendingDeviceCodesForDevice,
} from '../db/queries/tvDeviceCodes.js';

const router = Router();

// Codes live 5 minutes; the TV polls every 5 seconds.
const CODE_TTL_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 5;

// ---------------------------------------------------------------------------
// POST /code — the TV asks for a fresh code pair (unauthenticated).
// ---------------------------------------------------------------------------
router.post('/code', deviceCodeGenerateRateLimit, async (req, res) => {
  try {
    // The TV sends a stable identifierForVendor so a fresh code supersedes any
    // it showed before (e.g. after a restart). Bound the length defensively.
    const rawDeviceId = typeof req.body?.device_id === 'string' ? req.body.device_id.trim() : '';
    const deviceId = rawDeviceId ? rawDeviceId.slice(0, 200) : null;
    // Kill any earlier still-pending code from this device before minting a new
    // one, so the old (now off-screen) code can no longer be approved on the web.
    if (deviceId) {
      await invalidatePendingDeviceCodesForDevice(deviceId);
    }
    const userCode = generateUserCode();
    const deviceCode = generateDeviceCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
    await createDeviceCode({ userCode, deviceCode, expiresAt, deviceId });
    res.json({
      user_code: formatUserCode(userCode),
      device_code: deviceCode,
      interval: POLL_INTERVAL_SECONDS,
      expires_in: CODE_TTL_SECONDS,
      verification_uri: `${CONFIG.publicAppUrl}/tv`,
    });
  } catch (err) {
    console.error('TV device /code error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /approve — a signed-in content owner binds a code to their account.
// ---------------------------------------------------------------------------
router.post('/approve', requireAuth, requireOwner, async (req, res) => {
  try {
    const userCode = normalizeUserCode(req.body?.user_code);
    if (!userCode) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    const approved = await approveDeviceCode(userCode, req.user!.userId);
    if (!approved) {
      res.status(400).json({ error: 'invalid_or_expired' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('TV device /approve error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /token — the TV polls; once approved it gets a normal session pair.
// ---------------------------------------------------------------------------
router.post('/token', deviceCodePollRateLimit, async (req, res) => {
  try {
    const deviceCode = typeof req.body?.device_code === 'string' ? req.body.device_code : '';
    if (!deviceCode) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const row = await getDeviceCodeByDeviceCode(deviceCode);
    if (!row) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const expired = new Date(row.expiresAt).getTime() < Date.now();
    // A lapsed, already-burnt, or denied code is dead — the TV should show a
    // fresh code rather than keep polling.
    if (expired || row.status === 'used' || row.status === 'denied') {
      res.status(400).json({ error: 'expired_token' });
      return;
    }
    if (row.status === 'pending') {
      res.status(400).json({ error: 'authorization_pending' });
      return;
    }

    // status === 'approved'
    const user = row.userId != null ? await getUserByInternalId(row.userId) : undefined;
    if (!user || !user.active) {
      res.status(400).json({ error: 'expired_token' });
      return;
    }

    const basePayload = {
      userId: user.internalId,
      userUuid: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: user.tokenGeneration,
    };
    const { token, refreshToken } = await issueSessionTokens(basePayload);
    // Single-use: burn the code so a leaked device_code is worthless post-login.
    await markDeviceCodeUsed(row.id);

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        isAdmin: user.isAdmin,
        active: user.active,
      },
    });
  } catch (err) {
    console.error('TV device /token error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
