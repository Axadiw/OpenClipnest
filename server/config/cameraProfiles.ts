/**
 * Camera filename classification profiles.
 *
 * Each profile is a named regex + field extractor that turns a single
 * basename (never a full path — the scanner strips the directory before
 * calling into here) into the four canonical fields the scanner needs:
 *   camera name, view id (profile-defined string), 14-digit timestamp, ext.
 *
 * View IDs are arbitrary profile-defined strings (Reolink uses '00'/'01',
 * other vendors can use 'A'/'B', 'main', 'tele', etc.). Each profile owns
 * its `views` list — frontend renders one toggle button per entry, in
 * order; the first entry is the default view at playback time.
 *
 * Profiles are tried in array order — the first match wins — so more
 * specific patterns belong before generic fallbacks. Adding support for
 * a new camera vendor is: append a profile here and add a fixture row
 * in scanner.test.ts.
 */

import { MAX_UNTRUSTED_INPUT } from '../services/untrustedRegex.js';
import type { IconKind } from '../types.js';

export type { IconKind };

export interface CameraView {
  /** View identifier — matches the regex `view` capture group. */
  id: string;
  /**
   * Display label. For built-in profiles this is an i18n key
   * (e.g. 'profile.view.wide'); for custom profiles it can be a raw
   * string. Frontend resolves keys via i18n, falls back to raw text.
   */
  label: string;
  /** SVG glyph hint; falls back to 'generic' if omitted. */
  iconKind?: IconKind;
}

export interface ClassifiedFile {
  camera: string;
  view: string;
  tsRaw: string; // 14-digit YYYYMMDDHHMMSS
  ext: string;   // lowercased extension, no leading dot
}

export interface CameraProfile {
  name: string;
  regex: RegExp;
  /**
   * Views this profile recognises, in render order. First entry is the
   * primary view (default playback). Single-view cameras have one entry.
   */
  views: CameraView[];
  /** Pull the canonical fields out of the regex exec result. */
  extract: (match: RegExpExecArray) => ClassifiedFile | null;
  /**
   * True for user-authored custom profiles: their regex is untrusted and MUST
   * be vetted by the scanner's `vetUntrustedProfiles` (worker-thread timeout
   * guard) before use. `classifyFilename` skips any profile still flagged
   * untrusted, so a catastrophic-backtracking regex can never run natively on
   * the event loop. Built-in profiles omit this (trusted).
   */
  untrusted?: boolean;
  /** Present for custom profiles only — identifies the DB row so a regex that
   *  times out during a scan can be disabled by the caller. */
  custom?: { id: number };
}

type ExtList = readonly string[];

function buildExtAlternation(videoExts: ExtList, imageExts: ExtList): string {
  return [...videoExts, ...imageExts].join('|');
}

/**
 * Produce the global profile catalog. Caller owns the extension lists so
 * FTPS and scanner can both use the same source of truth without this
 * module growing a dependency on the scanner's `ALLOWED_EXTENSIONS`.
 */
export function buildGlobalProfiles(
  videoExts: ExtList,
  imageExts: ExtList,
): CameraProfile[] {
  const extAlt = buildExtAlternation(videoExts, imageExts);

  const SINGLE_VIEW: CameraView[] = [
    { id: '00', label: 'profile.view.camera', iconKind: 'generic' },
  ];

  return [
    {
      // Clipnest's own FTPS-normalized convention, emitted by every camera
      // model we currently support: `{Camera}_{00|01}_{YYYYMMDDHHMMSS}.{ext}`.
      // Reolink dual-view (TrackMix etc.) — wide = '00', tele/zoom = '01'.
      name: 'clipnest-default',
      regex: new RegExp(`^(.+)_(00|01)_(\\d{14})\\.(${extAlt})$`, 'i'),
      views: [
        { id: '00', label: 'profile.view.wide', iconKind: 'wide' },
        { id: '01', label: 'profile.view.zoom', iconKind: 'zoom' },
      ],
      extract: (m) => ({
        camera: m[1],
        view: m[2],
        tsRaw: m[3],
        ext: m[4].toLowerCase(),
      }),
    },
    {
      // Placed after clipnest-default; any file matching _00_/_01_ view convention
      // will be claimed by clipnest-default first.
      //
      // Hikvision cameras using the Webcam_G<serial>_<timestamp>[ms][_SUFFIX].<ext>
      // naming convention. The millisecond field (3 digits after the 14-digit
      // timestamp) and the trailing suffix (e.g. _TIMING, _EVENT) are both
      // optional. Note: the `i` flag makes the suffix pattern case-insensitive,
      // so lowercase variants like _timing or _event also match.
      name: 'hikvision',
      regex: new RegExp(`^Webcam_G(\\d+)_(\\d{14})(?:\\d{3})?(?:_[A-Z]+)?\\.(${extAlt})$`, 'i'),
      views: SINGLE_VIEW,
      extract: (m) => ({
        camera: 'G' + m[1],
        view: '00',
        tsRaw: m[2],
        ext: m[3].toLowerCase(),
      }),
    },
    {
      // Foscam cameras using MDAlarm_<YYYYMMDD>-<HHMMSS>.<ext> naming convention.
      name: 'foscam-mdalarm',
      regex: new RegExp(`^MDAlarm_(\\d{8})-(\\d{6})\\.(${extAlt})$`, 'i'),
      views: SINGLE_VIEW,
      extract: (m) => ({
        camera: 'Foscam-MDAlarm',
        view: '00',
        tsRaw: m[1] + m[2],
        ext: m[3].toLowerCase(),
      }),
    },
    {
      // Axis cameras (and other vendors) using <name>_<YYYY>-<MM>-<DD>_<HH>-<MM>-<SS>.<ext>
      // naming convention. Must come before clipnest-single-view because it uses
      // dashes in the timestamp which the generic fallback can't distinguish from
      // camera-name characters.
      // The greedy (.+) for the camera name is intentional — Axis camera names
      // may contain underscores and other special characters; the anchored
      // date/time segments following it are unambiguous delimiters.
      name: 'axis',
      regex: new RegExp(`^(.+)_(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})\\.(${extAlt})$`, 'i'),
      views: SINGLE_VIEW,
      extract: (m) => ({
        camera: m[1],
        view: '00',
        tsRaw: m[2] + m[3] + m[4] + m[5] + m[6] + m[7],
        ext: m[8].toLowerCase(),
      }),
    },
    {
      // Single-view fallback for cameras that don't emit a view suffix at
      // all (e.g. older IP cams). We treat them as wide-only. Guarded by
      // a negative lookahead to avoid stealing matches from the default
      // profile above for `Name_00_ts.ext` files.
      name: 'clipnest-single-view',
      regex: new RegExp(`^(?!.+_(?:00|01)_\\d{14}\\.)(.+)_(\\d{14})\\.(${extAlt})$`, 'i'),
      views: SINGLE_VIEW,
      extract: (m) => ({
        camera: m[1],
        view: '00',
        tsRaw: m[2],
        ext: m[3].toLowerCase(),
      }),
    },
  ];
}

/**
 * Canonical, custom-expressible vendor templates surfaced to the frontend by
 * `GET /settings/camera-profiles` (`templates` array). The "custom" recognition
 * mode seeds these four as editable user profiles when the list is empty.
 *
 * Unlike the built-in `buildGlobalProfiles` catalog (positional capture groups
 * + bespoke `extract`), every template here is a NAMED-GROUP regex that the
 * generic custom-profile machinery understands directly:
 *   (?<camera>) (?<ts>) (?<ext>) and optionally (?<view>).
 *
 * Axis and Foscam carry a dashed `ts` (e.g. `2024-01-15_14-30-22`,
 * `20240115-143022`) that isn't a contiguous 14-digit run; the custom-profile
 * ts-relaxation (strip non-digits → require exactly 14) normalizes them at
 * classify/test time. The extension alternation is inlined as a literal so the
 * strings round-trip verbatim through the API and the user-facing editor.
 *
 * Each regex MUST pass `assertUntrustedRegexSafe` (verified in tests) since a
 * seeded profile is stored as an untrusted user regex.
 */
export interface VendorProfileTemplate {
  name: string;
  regex: string;
  viewsConfig: Array<{ id: string; iconKind: IconKind }>;
}

const TEMPLATE_EXT_ALT = 'mp4|m4v|mov|mkv|webm|avi|ts|3gp|jpg|jpeg|png';

export const VENDOR_PROFILE_TEMPLATES: VendorProfileTemplate[] = [
  {
    name: 'Reolink',
    regex: `^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>${TEMPLATE_EXT_ALT})$`,
    viewsConfig: [
      { id: '00', iconKind: 'wide' },
      { id: '01', iconKind: 'zoom' },
    ],
  },
  {
    name: 'Hikvision',
    regex: `^Webcam_G(?<camera>\\d+)_(?<ts>\\d{14})(?:\\d{3})?(?:_[A-Z]+)?\\.(?<ext>${TEMPLATE_EXT_ALT})$`,
    viewsConfig: [{ id: '00', iconKind: 'generic' }],
  },
  {
    name: 'Axis',
    regex: `^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.(?<ext>${TEMPLATE_EXT_ALT})$`,
    viewsConfig: [{ id: '00', iconKind: 'generic' }],
  },
  {
    name: 'Foscam',
    regex: `^(?<camera>MDAlarm)_(?<ts>\\d{8}-\\d{6})\\.(?<ext>${TEMPLATE_EXT_ALT})$`,
    viewsConfig: [{ id: '00', iconKind: 'generic' }],
  },
];

/**
 * Try every profile in order; first match wins. Returns null on no match.
 *
 * Untrusted (custom) profiles are SKIPPED here. They must be vetted first by
 * the scanner (`vetUntrustedProfiles` in scanner.ts), which runs each in the
 * worker-thread timeout guard and flips a safe one to `untrusted: false` — so
 * an un-vetted attacker-authored regex can never run on the main thread. The
 * input length is also capped so even a vetted regex can't backtrack on a
 * pathological filename.
 */
export function classifyFilename(
  basename: string,
  profiles: CameraProfile[],
): ClassifiedFile | null {
  if (basename.length > MAX_UNTRUSTED_INPUT) return null;
  for (const p of profiles) {
    if (p.untrusted) continue;
    const m = p.regex.exec(basename);
    if (!m) continue;
    const out = p.extract(m);
    if (out) return out;
  }
  return null;
}
