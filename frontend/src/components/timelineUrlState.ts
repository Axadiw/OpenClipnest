import type { CameraEvent, ViewId } from '../types';

export interface ParsedTimelineUrlParams {
  eventId: string;
  view: ViewId;
  seekSec: number | null;
}

export interface SerializedTimelineParams {
  event: string | null;
  view: string | null;
  t: string | null;
}

export function parseTimelineUrlParams(params: URLSearchParams): ParsedTimelineUrlParams | null {
  const eventId = params.get('event');
  const viewRaw = params.get('view');
  if (!eventId) return null;
  // Profile-defined view ids are arbitrary strings (Reolink uses '00'/'01'
  // — backward-compatible — but custom profiles can pick 'A', 'main', etc).
  // Server-side validation caps length at 16 chars; mirror that here.
  if (!viewRaw || viewRaw.length === 0 || viewRaw.length > 16) return null;

  const tRaw = params.get('t');
  let seekSec: number | null = null;
  if (tRaw !== null) {
    const n = Number(tRaw);
    if (Number.isFinite(n) && n >= 0) seekSec = n;
  }

  return { eventId, view: viewRaw, seekSec };
}

// Defensive clamp for `?t=` against the clip's known duration. The URL
// serializer below rounds seekSec to integer (`Math.round(12.7)` = 13),
// so a bookmark from the last second of a 13.018 s clip writes `?t=13`
// and on reload the deferred-seek effect in TimelineView would interpret
// `pending (13) >= duration - 0.25 (12.768)` as "past perceived end" and
// loop in its broken-moov nudge fallback for 60 s. Clamping to
// `duration - 1` keeps the playhead a full second before EOF — far
// enough to avoid the browser's EOF dead-zone, close enough that the
// user lands roughly where they bookmarked. Returns `seekSec` unchanged
// when duration is unknown; trySeek applies the same clamp once
// `v.duration` resolves.
export function clampSeekToDuration(
  seekSec: number | null | undefined,
  duration: number | null | undefined,
): number | null {
  if (seekSec == null || !Number.isFinite(seekSec) || seekSec < 0) return null;
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return seekSec;
  if (seekSec >= duration - 0.25) return Math.max(0, duration - 1);
  return seekSec;
}

export function serializeInlineVideoToParams(
  inlineVideo: { event: Pick<CameraEvent, 'id'>; view: ViewId; seekSec?: number } | null,
): SerializedTimelineParams {
  if (!inlineVideo) return { event: null, view: null, t: null };
  const { event, view, seekSec } = inlineVideo;
  const t = (typeof seekSec === 'number' && Number.isFinite(seekSec) && seekSec >= 0)
    ? String(Math.round(seekSec))
    : null;
  return { event: event.id, view, t };
}
