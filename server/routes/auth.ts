import { Router } from 'express';
import {
  getUserByEmail,
  getUserByInternalId,
  getTokenGeneration,
  bumpTokenGeneration,
  countUnusedBackupCodes,
  getFtpsState,
} from '../db/queries/users.js';
import { isUserLocked, isUserBanned, recordFailedLogin, resetLoginAttempts } from '../db/queries/lockout.js';
import {
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  DUMMY_HASH,
} from '../services/auth.js';
import { loginRateLimit, loginEmailRateLimit, refreshTokenRateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { auditLog } from '../services/audit.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';

// Core authentication: password login, token refresh and sign-out. Password
// change, the separate FTPS credential, email-driven flows (verification,
// reset, account-deletion confirmation), passkeys and OAuth identity management
// are cloud-only and live in server/cloud/routes/auth.ts, mounted at the same
// /api/v0/auth prefix by the cloud edition.

const router = Router();

router.post('/login', loginRateLimit, loginEmailRateLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const user = await getUserByEmail(email);

    // Admin ban overrides the lockout response so the user sees the right reason.
    if (user) {
      const banStatus = await isUserBanned(user.internalId);
      if (banStatus.banned) {
        auditLog('LOGIN_BANNED', { email, ip: req.ip, until: banStatus.until });
        res.status(403).json({
          error: 'Account suspended',
          banned: true,
          until: banStatus.indefinite ? null : banStatus.until,
          reason: banStatus.reason ?? null,
          indefinite: !!banStatus.indefinite,
        });
        return;
      }
      // The web channel's lockout only: a camera retrying an outdated
      // password locks the FTP logins, never this sign-in.
      const lockStatus = await isUserLocked(user.internalId, 'web');
      if (lockStatus.locked) {
        const retryAfter = Math.ceil((new Date(lockStatus.lockedUntil!).getTime() - Date.now()) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        auditLog('LOGIN_LOCKED', { email, ip: req.ip, lockedUntil: lockStatus.lockedUntil });
        res.status(423).json({ error: 'Account temporarily locked. Try again later.', retryAfter });
        return;
      }
    }

    // Always run bcrypt.compare to prevent timing-based user enumeration
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    // Treat inactive accounts the same as invalid credentials to prevent user enumeration:
    // a 403 "pending verification" response would confirm both email existence and correct password.
    if (!user || !valid || !user.active) {
      if (user) await recordFailedLogin(user.internalId, 'web');
      auditLog('LOGIN_FAILURE', { email, ip: req.ip });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Passkey-enabled accounts MUST authenticate via /auth/login/passkey;
    // refuse the password path so a stolen password is useless on its own.
    const ftpsState = await getFtpsState(user.internalId);
    if (ftpsState?.passkeyEnabled) {
      auditLog('LOGIN_PASSKEY_REQUIRED', { email: user.email, userId: user.id, ip: req.ip });
      res.status(400).json({ error: 'Use passkey to sign in', passkeyRequired: true });
      return;
    }

    await resetLoginAttempts(user.internalId, 'web');
    auditLog('LOGIN_SUCCESS', { email: user.email, userId: user.id, ip: req.ip });

    // Refund the rate-limit point on success. Brute-force protection only
    // needs to count FAILED attempts — a legitimate password-manager
    // workflow (typo + correct, or multi-account session) would otherwise
    // burn the per-IP budget twice as fast as the cap suggests. Failure
    // paths above (invalid credentials, banned, locked, passkey-required)
    // intentionally do NOT refund.
    await req.refundRateLimit?.();

    const basePayload = {
      userId: user.internalId,
      userUuid: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: user.tokenGeneration,
    };
    const token = generateAccessToken(basePayload);
    const refreshToken = generateRefreshToken(basePayload);

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
    console.error('Login error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Exchange a refresh token for a new access+refresh pair. Rate-limited under
// its own budget — sharing /auth/login's budget caused login flak from the
// same egress IP (CGNAT, office NAT) to knock out healthy sessions' silent
// refresh. The token-stuffing risk is bounded by the refresh-token signature
// check below; the IP cap is just a backstop. Refresh tokens must be
// kind='refresh'; an access token here is rejected so a stolen access token
// cannot extend a session.
router.post('/refresh', refreshTokenRateLimit, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    if (payload.kind !== 'refresh') {
      res.status(401).json({ error: 'Wrong token kind' });
      return;
    }

    const user = await getUserByInternalId(payload.userId);
    if (!user || !user.active) {
      res.status(401).json({ error: 'Account unavailable' });
      return;
    }

    const banStatus = await isUserBanned(user.internalId);
    if (banStatus.banned) {
      res.status(403).json({
        error: 'Account suspended',
        banned: true,
        until: banStatus.indefinite ? null : banStatus.until,
        reason: banStatus.reason ?? null,
        indefinite: !!banStatus.indefinite,
      });
      return;
    }

    const currentGen = await getTokenGeneration(user.internalId);
    if (payload.tokenGen !== currentGen) {
      res.status(401).json({ error: 'Refresh token revoked' });
      return;
    }

    const basePayload = {
      userId: user.internalId,
      userUuid: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: currentGen,
    };
    const token = generateAccessToken(basePayload);
    const newRefreshToken = generateRefreshToken(basePayload);

    auditLog('TOKEN_REFRESH', { userId: user.id, email: user.email, ip: req.ip });
    res.json({ token, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('Refresh error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// POST /logout — revoke every session for the current user by bumping the
// global token_generation, invalidating all outstanding access + refresh tokens.
// Consistent with password-change / passkey-removal, which already bump it.
// This is sign-out-everywhere by design; per-device revocation is future work.
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await bumpTokenGeneration(req.user!.userId);
    auditLog('LOGOUT', { userId: req.user!.userId, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/passkey-state', requireAuth, async (req, res) => {
  try {
    const [ftps, user] = await Promise.all([
      getFtpsState(req.user!.userId),
      getUserByInternalId(req.user!.userId),
    ]);
    const unused = ftps?.passkeyEnabled ? await countUnusedBackupCodes(req.user!.userId) : 0;
    res.json({
      passkeyEnabled: !!ftps?.passkeyEnabled,
      hasFtpsPassword: !!ftps?.hasFtpsPassword,
      hasPasswordLogin: user?.passwordHash !== null && user?.passwordHash !== undefined,
      unusedBackupCodes: unused,
    });
  } catch (err) {
    console.error('Passkey state error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to load passkey state' });
  }
});

export default router;
