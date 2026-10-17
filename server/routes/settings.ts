import { Router } from 'express';
import {
  getCameraProfileSettings,
  setCameraProfileMode,
  insertUserCameraProfile,
  updateUserCameraProfile,
  deleteUserCameraProfile,
  resetUserCameraProfiles,
} from '../db/queries/cameraProfiles.js';
import { getUserTimezone, setUserTimezone } from '../db/queries/events.js';
import { VENDOR_PROFILE_TEMPLATES } from '../config/cameraProfiles.js';
import type { CameraProfileMode, IconKind } from '../types.js';
import {
  assertUntrustedRegexSafe,
  safeRegexExec,
  RegexTimeoutError,
  MAX_UNTRUSTED_INPUT,
} from '../services/untrustedRegex.js';

const router = Router();

const VALID_MODES: CameraProfileMode[] = ['auto', 'reolink', 'hikvision', 'axis', 'foscam', 'custom'];
const CUSTOM_PROFILE_CAP = 20;
const VALID_ICON_KINDS: readonly IconKind[] = [
  'wide', 'zoom', 'fisheye', 'generic', 'tele', 'ptz', 'doorbell', 'thermal',
];
const MAX_VIEWS_PER_PROFILE = 16;

type ViewsConfig = Array<{ id: string; iconKind: IconKind }>;

/**
 * Validate + normalize the `viewsConfig` request field. Returns the parsed
 * array on success, or an error string the route turns into a 400. Accepts
 * the legacy `viewDefault` string for backward compat: when `viewsConfig` is
 * absent we synthesize a single generic-icon view from it (defaulting to '00').
 */
function parseViewsConfig(
  viewsConfig: unknown,
  viewDefault: unknown,
): { value: ViewsConfig } | { error: string } {
  if (viewsConfig === undefined) {
    // Legacy path: derive a one-view config from viewDefault.
    let id = '00';
    if (viewDefault !== undefined) {
      if (typeof viewDefault !== 'string' || viewDefault.length === 0 || viewDefault.length > 16) {
        return { error: 'viewDefault must be a string of length 1..16' };
      }
      id = viewDefault;
    }
    return { value: [{ id, iconKind: 'generic' }] };
  }
  if (!Array.isArray(viewsConfig) || viewsConfig.length < 1 || viewsConfig.length > MAX_VIEWS_PER_PROFILE) {
    return { error: `viewsConfig must be an array of 1..${MAX_VIEWS_PER_PROFILE} entries` };
  }
  const out: ViewsConfig = [];
  for (const entry of viewsConfig) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'each viewsConfig entry must be an object' };
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 16) {
      return { error: 'each viewsConfig entry id must be a string of length 1..16' };
    }
    const iconKind = (entry as { iconKind?: unknown }).iconKind;
    if (typeof iconKind !== 'string' || !VALID_ICON_KINDS.includes(iconKind as IconKind)) {
      return { error: `each viewsConfig entry iconKind must be one of: ${VALID_ICON_KINDS.join(', ')}` };
    }
    out.push({ id, iconKind: iconKind as IconKind });
  }
  return { value: out };
}

// The zones an account may pick: the runtime's IANA list plus 'UTC', the
// default of new accounts — ICU lists canonical zone names only, and 'UTC'
// is not among them, so without it a UTC account could never be re-selected.
const ACCOUNT_TIMEZONES = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

// GET /api/v0/settings/timezone
router.get('/timezone', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.json({ timezone: await getUserTimezone(userId) });
  } catch (err) {
    console.error('Get timezone error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v0/settings/timezone
router.put('/timezone', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { timezone } = req.body as { timezone?: unknown };
    if (typeof timezone !== 'string' || !timezone) {
      res.status(400).json({ error: 'timezone is required' }); return;
    }
    if (!ACCOUNT_TIMEZONES.has(timezone)) {
      res.status(400).json({ error: 'Invalid IANA timezone' }); return;
    }
    await setUserTimezone(userId, timezone);
    res.json({ ok: true });
  } catch (err) {
    console.error('Set timezone error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v0/settings/camera-profiles
router.get('/camera-profiles', async (req, res) => {
  try {
    const { mode, profiles } = await getCameraProfileSettings(req.user!.userUuid);
    // `templates` are the canonical vendor profiles the frontend seeds into
    // "custom" mode (and offers as a "reset to defaults"). Surfaced here so the
    // client never hardcodes the regexes — single source of truth lives in
    // server/config/cameraProfiles.ts.
    res.json({ mode, customProfiles: profiles, templates: VENDOR_PROFILE_TEMPLATES });
  } catch (err) {
    console.error('Get camera profiles error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v0/settings/camera-profiles/mode
router.put('/camera-profiles/mode', async (req, res) => {
  try {
    const { mode } = req.body as { mode?: unknown };
    if (typeof mode !== 'string' || !VALID_MODES.includes(mode as CameraProfileMode)) {
      res.status(400).json({ error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` });
      return;
    }
    await setCameraProfileMode(req.user!.userUuid, mode as CameraProfileMode);
    res.json({ mode });
  } catch (err) {
    console.error('Put camera profile mode error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v0/settings/camera-profiles/custom
router.post('/camera-profiles/custom', async (req, res) => {
  try {
    const body = req.body as {
      name?: unknown;
      regex?: unknown;
      viewDefault?: unknown;
      viewsConfig?: unknown;
      priority?: unknown;
    };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    if (body.name.length > 200) {
      res.status(400).json({ error: 'name must not exceed 200 characters' });
      return;
    }
    if (typeof body.regex !== 'string' || body.regex.trim().length === 0) {
      res.status(400).json({ error: 'regex must be a non-empty string' });
      return;
    }
    if (body.regex.length > 500) {
      res.status(400).json({ error: 'regex must not exceed 500 characters' });
      return;
    }
    try {
      new RegExp(body.regex);
    } catch {
      res.status(400).json({ error: 'Invalid regex syntax' });
      return;
    }
    // Reject catastrophic-backtracking (ReDoS) regexes before they are stored —
    // a custom profile's regex later runs against attacker-controlled S3
    // filenames in the event-manager. See server/services/untrustedRegex.ts.
    const unsafeReason = await assertUntrustedRegexSafe(body.regex, 'i');
    if (unsafeReason) {
      res.status(400).json({ error: unsafeReason });
      return;
    }
    const parsedViews = parseViewsConfig(body.viewsConfig, body.viewDefault);
    if ('error' in parsedViews) {
      res.status(400).json({ error: parsedViews.error });
      return;
    }
    if (body.priority !== undefined && !Number.isInteger(body.priority)) {
      res.status(400).json({ error: 'priority must be an integer' });
      return;
    }

    const { profiles } = await getCameraProfileSettings(req.user!.userUuid);
    if (profiles.length >= CUSTOM_PROFILE_CAP) {
      res.status(400).json({ error: `Cannot exceed ${CUSTOM_PROFILE_CAP} custom profiles` });
      return;
    }

    const profile = await insertUserCameraProfile(req.user!.userUuid, {
      name: body.name.trim(),
      regex: body.regex.trim(),
      viewsConfig: parsedViews.value,
      priority: typeof body.priority === 'number' ? body.priority : 0,
    });
    res.status(201).json(profile);
  } catch (err) {
    console.error('Post custom camera profile error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v0/settings/camera-profiles/custom/:id
router.put('/camera-profiles/custom/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'id must be numeric' });
      return;
    }

    const body = req.body as {
      name?: unknown;
      regex?: unknown;
      viewDefault?: unknown;
      viewsConfig?: unknown;
      priority?: unknown;
      enabled?: unknown;
    };

    const data: {
      name?: string;
      regex?: string;
      viewsConfig?: ViewsConfig;
      priority?: number;
      enabled?: boolean;
    } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        res.status(400).json({ error: 'name must be a non-empty string' });
        return;
      }
      if (body.name.length > 200) {
        res.status(400).json({ error: 'name must not exceed 200 characters' });
        return;
      }
      data.name = body.name.trim();
    }
    if (body.regex !== undefined) {
      if (typeof body.regex !== 'string' || body.regex.trim().length === 0) {
        res.status(400).json({ error: 'regex must be a non-empty string' });
        return;
      }
      if (body.regex.length > 500) {
        res.status(400).json({ error: 'regex must not exceed 500 characters' });
        return;
      }
      try {
        new RegExp(body.regex);
      } catch {
        res.status(400).json({ error: 'Invalid regex syntax' });
        return;
      }
      const unsafeReason = await assertUntrustedRegexSafe(body.regex, 'i');
      if (unsafeReason) {
        res.status(400).json({ error: unsafeReason });
        return;
      }
      data.regex = body.regex.trim();
    }
    // Only touch views when the client sent either field — keeps the
    // partial-update contract (e.g. a name-only PUT leaves views untouched).
    if (body.viewsConfig !== undefined || body.viewDefault !== undefined) {
      const parsedViews = parseViewsConfig(body.viewsConfig, body.viewDefault);
      if ('error' in parsedViews) {
        res.status(400).json({ error: parsedViews.error });
        return;
      }
      data.viewsConfig = parsedViews.value;
    }
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'number' || !Number.isInteger(body.priority)) {
        res.status(400).json({ error: 'priority must be an integer' });
        return;
      }
      data.priority = body.priority;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      data.enabled = body.enabled;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'Request body must contain at least one updatable field' });
      return;
    }

    const updated = await updateUserCameraProfile(id, req.user!.userUuid, data);
    if (!updated) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error('Put custom camera profile error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v0/settings/camera-profiles/reset
//
// Atomic reset-to-defaults: transactionally deletes ALL custom profiles and
// seeds the 4 vendor templates (priorities 10/20/30/40 — same values the web
// client used when it seeded them itself). Deliberately NO cap check: the
// deletes run first inside the transaction, so the result is always 4 rows.
// This replaces the client-driven "seed 4 via POST /custom, then delete
// stale" flow, which could never complete for users with >16 profiles (the
// seeding step hit CUSTOM_PROFILE_CAP before the deletes ran) — and there is
// no empty-profile window either.
router.post('/camera-profiles/reset', async (req, res) => {
  try {
    const customProfiles = await resetUserCameraProfiles(
      req.user!.userUuid,
      VENDOR_PROFILE_TEMPLATES.map((t, i) => ({
        name: t.name,
        regex: t.regex,
        viewsConfig: t.viewsConfig,
        priority: (i + 1) * 10,
      })),
    );
    res.json({ customProfiles });
  } catch (err) {
    console.error('Reset camera profiles error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/v0/settings/camera-profiles/custom/:id
router.delete('/camera-profiles/custom/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'id must be numeric' });
      return;
    }
    const ok = await deleteUserCameraProfile(id, req.user!.userUuid);
    if (!ok) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error('Delete custom camera profile error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v0/settings/camera-profiles/test
router.post('/camera-profiles/test', async (req, res) => {
  try {
    const body = req.body as { regex?: unknown; filename?: unknown };

    if (typeof body.regex !== 'string' || body.regex.trim().length === 0) {
      res.status(400).json({ error: 'regex must be a non-empty string' });
      return;
    }
    if (typeof body.filename !== 'string' || body.filename.trim().length === 0) {
      res.status(400).json({ error: 'filename must be a non-empty string' });
      return;
    }

    // Syntax check on the main thread (cheap; surfaces invalid patterns).
    try {
      // Apply same `i` flag used by all built-in profiles so test preview matches runtime behavior
      new RegExp(body.regex, 'i');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Invalid regex: ${msg}` });
      return;
    }

    const filename = body.filename.trim();
    if (filename.length > MAX_UNTRUSTED_INPUT) {
      res.status(400).json({ error: `filename must not exceed ${MAX_UNTRUSTED_INPUT} characters` });
      return;
    }

    // Run the untrusted regex inside the worker-thread timeout guard so a
    // catastrophic-backtracking pattern in this preview endpoint can't block
    // the API event loop (ReDoS). See server/services/untrustedRegex.ts.
    let execResult;
    try {
      execResult = await safeRegexExec(body.regex, 'i', filename);
    } catch (err) {
      if (err instanceof RegexTimeoutError) {
        res.status(400).json({ error: 'regex is too slow (possible catastrophic backtracking) — simplify the pattern' });
        return;
      }
      throw err;
    }

    if (!execResult.matched) {
      res.json({ result: null, reason: 'no match' });
      return;
    }

    const groups = execResult.groups ?? {};
    const camera = groups.camera;
    const ts = groups.ts;
    const ext = groups.ext;
    // `view` is the canonical group name; `lens` is accepted for backward
    // compat with profiles authored before v0.10.336.
    const view = groups.view ?? groups.lens ?? '00';

    if (!camera || !ts || !ext) {
      res.status(400).json({
        error: 'Regex must have named capture groups: (?<camera>...), (?<ts>...), (?<ext>...)',
      });
      return;
    }
    // ts-relaxation (mirrors buildCustomProfile in cameraProfileResolver.ts so
    // the preview matches runtime classification): strip non-digits from the
    // matched `ts` group and require exactly 14 digits. Lets dashed/segmented
    // vendor timestamps (Axis `2024-01-15_14-30-22`, Foscam `20240115-143022`)
    // validate while a contiguous `\d{14}` stays a no-op.
    const tsNormalized = ts.replace(/\D/g, '');
    if (tsNormalized.length !== 14) {
      res.status(400).json({ error: 'Named group (?<ts>...) must capture exactly 14 digits (YYYYMMDDHHMMSS) after removing separators' });
      return;
    }

    res.json({ result: { camera, view, tsRaw: tsNormalized, ext } });
  } catch (err) {
    console.error('Test camera profile regex error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
