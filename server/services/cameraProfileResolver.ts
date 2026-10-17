import { getCameraProfileSettings, updateUserCameraProfile } from '../db/queries/cameraProfiles.js';
import type { CameraEvent, EventView, UserCameraProfile } from '../types.js';
import { buildGlobalProfiles, type CameraProfile } from '../config/cameraProfiles.js';
import { VIDEO_EXTS, IMAGE_EXTS } from './scannerExts.js';
import { assertUntrustedRegexSafe } from './untrustedRegex.js';

export const GLOBAL_CAMERA_PROFILES: CameraProfile[] = buildGlobalProfiles(VIDEO_EXTS, IMAGE_EXTS);

export function buildCustomProfile(p: UserCameraProfile): CameraProfile {
  const re = new RegExp(p.regex, 'i');
  // Per-view editor drives the rendered toggle glyphs: each configured view
  // becomes one CameraProfile.view carrying the user-picked iconKind. The
  // label is the profile name (custom profiles ship raw display strings).
  // Fall back to the single legacy view if a row predates views_config.
  const views = (p.viewsConfig && p.viewsConfig.length > 0)
    ? p.viewsConfig.map(v => ({ id: v.id, label: p.name, iconKind: v.iconKind }))
    : [{ id: p.viewDefault, label: p.name, iconKind: 'generic' as const }];
  return {
    name: `custom:${p.id}`,
    regex: re,
    // User-authored regex — left flagged untrusted until the scanner's
    // vetUntrustedProfiles runs it through the worker-thread timeout guard.
    untrusted: true,
    custom: { id: p.id },
    views,
    extract: (m) => {
      const groups = m.groups ?? {};
      if (!groups['camera'] || !groups['ts'] || !groups['ext']) return null;
      // ts-relaxation: vendors like Axis (`2024-01-15_14-30-22`) and Foscam
      // (`20240115-143022`) carry dashed/segmented timestamps that can't be a
      // single contiguous `(?<ts>\d{14})`. Strip every non-digit from the
      // matched `ts` group and require the RESULT to be exactly 14 digits
      // (YYYYMMDDHHMMSS); use that normalized run as tsRaw. Existing
      // `(?<ts>\d{14})` regexes strip to the same 14 digits (no-op). The strip
      // runs on an already-regex-matched, length-bounded group (the scanner
      // caps input at MAX_UNTRUSTED_INPUT), so it adds no ReDoS surface.
      const tsNormalized = groups['ts'].replace(/\D/g, '');
      if (tsNormalized.length !== 14) return null;
      return {
        camera: groups['camera'],
        // Accept either named group: `view` is the canonical name post-v0.10.336;
        // `lens` stays as backward-compat for profiles authored before the rename.
        view: (groups['view'] || groups['lens'] || p.viewDefault),
        tsRaw: tsNormalized,
        ext: groups['ext'].toLowerCase(),
      };
    },
  };
}

const PRESET_PROFILE_NAMES: Record<string, string[]> = {
  reolink:   ['clipnest-default', 'clipnest-single-view'],
  hikvision: ['hikvision'],
  axis:      ['axis'],
  foscam:    ['foscam-mdalarm'],
};

// ─── Untrusted custom-regex vetting ──────────────────────────────────────────
// classifyFilename refuses to run any profile still flagged `untrusted` (the
// ReDoS guard), and buildCustomProfile
// always flags user-authored profiles untrusted. They only become runnable by
// vetting each regex through the worker-thread timeout guard and flipping the
// safe ones to `untrusted: false`. This step used to live in the scanner
// (`vetUntrustedProfiles`); R3 deleted the scanner and the synchronous ingest
// path lost it — so EVERY upload from a custom-mode user was classified
// 'unrecognized' (no event, no processing banner). Restored here, the single
// choke point both ingest (completeUpload) and enrichment resolve through.
//
// assertUntrustedRegexSafe runs a worker-thread match per adversarial probe; the
// result is a pure function of (source, flags), and completeUpload resolves
// profiles per-file, so memoize to keep a bulk upload from re-vetting the same
// regex hundreds of times. Bounded to cap memory; eviction just forces a re-vet.
const VET_CACHE_CAP = 5_000;
const vetCache = new Map<string, boolean>();

export async function vetUntrustedProfiles(
  profiles: CameraProfile[],
  userUuid: string,
): Promise<CameraProfile[]> {
  const vetted: CameraProfile[] = [];
  for (const p of profiles) {
    if (!p.untrusted) {
      vetted.push(p);
      continue;
    }
    const key = `${p.regex.flags}\n${p.regex.source}`;
    const cached = vetCache.get(key);
    if (cached !== undefined) {
      if (cached) vetted.push({ ...p, untrusted: false });
      continue;
    }
    let unsafeReason: string | null;
    try {
      unsafeReason = await assertUntrustedRegexSafe(p.regex.source, p.regex.flags);
    } catch (e) {
      // Worker fault — fail closed (skip this run) but do NOT cache, so a
      // transient error is retried rather than permanently dropping a profile.
      console.error(
        `vetUntrustedProfiles: vetting errored for profile ${p.custom?.id ?? p.name} (${userUuid}):`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }
    const safe = unsafeReason === null;
    if (vetCache.size >= VET_CACHE_CAP) {
      const oldest = vetCache.keys().next().value;
      if (oldest !== undefined) vetCache.delete(oldest);
    }
    vetCache.set(key, safe);
    if (safe) {
      vetted.push({ ...p, untrusted: false });
    } else {
      // Catastrophic-backtracking regex: never run it against filenames, and
      // disable it so the user sees it's off and we stop re-vetting it.
      console.warn(
        `vetUntrustedProfiles: disabling custom camera profile ${p.custom?.id} for ${userUuid} — ${unsafeReason}`,
      );
      if (p.custom) {
        try {
          await updateUserCameraProfile(p.custom.id, userUuid, { enabled: false });
        } catch (e) {
          console.error(
            `vetUntrustedProfiles: failed to disable custom profile ${p.custom.id}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    }
  }
  return vetted;
}

export async function getEffectiveProfiles(userUuid: string): Promise<CameraProfile[]> {
  try {
    const { mode, profiles } = await getCameraProfileSettings(userUuid);
    if (mode === 'auto') return GLOBAL_CAMERA_PROFILES;
    if (mode === 'custom') {
      const custom = profiles
        .filter((p: import('../types.js').UserCameraProfile) => p.enabled)
        .map(buildCustomProfile);
      // A custom-mode user with no (or all-disabled) profiles must NOT resolve
      // to an empty profile list: parseS3Keys would then classify 0 files →
      // buildEvents → 0 events, and a full rescan's `replaceUserEvents([])`
      // would wipe the user's entire event history (e.g. an owner whose custom
      // profiles were dropped by the views_config migration).
      // Fall back to global so scanning degrades to "recognise standard layouts"
      // rather than "recognise nothing".
      if (custom.length === 0) {
        console.warn(
          `getEffectiveProfiles: mode=custom but 0 enabled profiles for ${userUuid} — falling back to global`,
        );
        return GLOBAL_CAMERA_PROFILES;
      }
      // Vet the untrusted user regexes before classifyFilename can use them
      // (see vetUntrustedProfiles). Without this every custom-mode upload is
      // classified 'unrecognized'.
      const vetted = await vetUntrustedProfiles(custom, userUuid);
      // Same invariant as the empty-custom guard above: if vetting drops every
      // profile (all catastrophic), resolving to [] would make a full rescan
      // classify 0 files and wipe history. Degrade to global, not "recognise nothing".
      if (vetted.length === 0) {
        console.warn(
          `getEffectiveProfiles: all custom profiles for ${userUuid} failed vetting — falling back to global`,
        );
        return GLOBAL_CAMERA_PROFILES;
      }
      return vetted;
    }
    const allowed = PRESET_PROFILE_NAMES[mode];
    if (!allowed) {
      console.warn(`getEffectiveProfiles: unrecognised mode "${mode}" for ${userUuid}, falling back to global`);
      return GLOBAL_CAMERA_PROFILES;
    }
    return GLOBAL_CAMERA_PROFILES.filter(p => allowed.includes(p.name));
  } catch {
    return GLOBAL_CAMERA_PROFILES;
  }
}

function enrichView(view: EventView, profiles: CameraProfile[]): EventView {
  for (const p of profiles) {
    const pv = p.views.find(x => x.id === view.id);
    if (pv) return { ...view, label: pv.label, iconKind: pv.iconKind };
  }
  return view;
}

export async function enrichEventsWithViewMeta<E extends Pick<CameraEvent, 'views'>>(
  events: E[],
  userUuid: string,
): Promise<E[]> {
  if (events.length === 0) return events;
  const profiles = await getEffectiveProfiles(userUuid);
  return events.map(e => ({ ...e, views: e.views.map(v => enrichView(v, profiles)) }));
}

export async function enrichEventWithViewMeta<E extends Pick<CameraEvent, 'views'>>(
  event: E,
  userUuid: string,
): Promise<E> {
  const profiles = await getEffectiveProfiles(userUuid);
  return { ...event, views: event.views.map(v => enrichView(v, profiles)) };
}
