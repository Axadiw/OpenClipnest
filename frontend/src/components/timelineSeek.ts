/**
 * Bar-click → seek-offset rules for the timeline's inline player.
 *
 * A plain click / tap on an event bar plays the clip from the START — bars
 * are narrow (often clamped to MIN_BAR_WIDTH) so "where inside the bar did I
 * land" was mostly noise, and users kept missing the beginning of a clip.
 * The old proportional seek survives as an explicit "precision mode":
 * ⌘-click (Mac) / Ctrl-click (everything else) with a mouse, or a long-press
 * on touch.
 */

/** Touch long-press duration that arms precision mode on a bar. */
export const LONG_PRESS_MS = 500;

/** How long the precision-mode badge stays up after a touch long-press. */
export const PRECISION_FLASH_MS = 1500;

/** Keep a precise seek this far inside the clip end so the player lands on a
 *  decodable frame instead of a fake EOF. */
const END_MARGIN_SEC = 0.25;

/**
 * Where to start playback for a click at `clickX` on a bar whose rendered box
 * starts at `rectLeft` and is `rectWidth` px wide, for a clip `clipLenSec`
 * long. Non-precise clicks always return 0 (play from the start). Precise
 * clicks map the click proportionally onto the clip, clamped to
 * `[0, clipLenSec - 0.25]`.
 */
export function barClickSeekSec(
  clickX: number,
  rectLeft: number,
  rectWidth: number,
  clipLenSec: number,
  precise: boolean,
): number {
  if (!precise) return 0;
  if (!(rectWidth > 0) || !(clipLenSec > 0)) return 0;
  const raw = ((clickX - rectLeft) / rectWidth) * clipLenSec;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(clipLenSec - END_MARGIN_SEC, raw));
}

/**
 * True when opening (`eventId`, `view`, `seekSec`) would leave the inline
 * player's remount key unchanged — same clip, same view, same (rounded) seek.
 * The caller then has to restart the live <video> in place, because pushing
 * identical state would not remount it and nothing would visibly happen
 * (e.g. a plain click on the clip that is already playing must restart it).
 */
export function isSameClipSeek(
  current: { eventId: string; view: string; seekSec?: number } | null,
  eventId: string,
  view: string,
  seekSec: number,
): boolean {
  if (!current) return false;
  return current.eventId === eventId
    && current.view === view
    && Math.round(current.seekSec ?? 0) === Math.round(seekSec);
}

/** Mac platforms label the precision modifier ⌘; everything else, Ctrl. */
export function isMacPlatform(platform: string | null | undefined): boolean {
  return /Mac/i.test(platform ?? '');
}
