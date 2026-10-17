// Buffer overlay math — derives the "<pct>% · <downloaded> / <needed>"
// triplet shown over the video while it's still loading the initial
// segments. Two source-of-truth modes, kept in one helper so the
// inline TimelineView player and the fullscreen VideoPlayer can render
// the same numbers without duplicating the math.
//
//   1. HLS active — `hlsLoadedBytes` is accumulated from
//      Hls.Events.FRAG_LOADED payload sizes by the caller. We trust
//      that number directly and derive `startupBytes` from the
//      observed bitrate (loaded bytes per buffered second × 3 s, the
//      threshold MSE needs to flip into HAVE_FUTURE_DATA).
//
//   2. Direct mp4 fallback (Safari without MSE, legacy events whose
//      sidecar isn't ready yet) — no per-fragment telemetry; we
//      approximate downloaded bytes from `bufferedSec / durationSec`
//      times the file's `directTotalBytes` (from the media-token
//      response). `startupBytes` comes from the same per-second
//      proportion.
//
// Pre-v0.10.224 the math always took path #2 and combined it with
// `v.buffered.end(last) / v.duration` for the buffered fraction. That
// reported 100 % whenever the last segment was buffered (typical HLS
// seek pattern: load segment 0 + the segment containing the seek
// target, leave the middle empty), which produced visually
// nonsensical "100 % · 7.2 MB / 1.7 MB" displays. Callers now sum
// every `v.buffered` range before passing `bufferedSec`, and
// HLS-active callers also feed in `hlsLoadedBytes` so path #1 reports
// the real network traffic.

export interface BufferOverlayInput {
  // Sum of seconds covered by all `v.buffered` ranges. NOT
  // `buffered.end(last)` — for HLS the last range often touches the
  // clip end after a single late-segment fetch, while large gaps sit
  // in the middle.
  bufferedSec: number;
  // Perceived duration from `v.duration`. `null` before metadata
  // lands — the overlay shows only a spinner then.
  durationSec: number | null;
  // Total bytes of the direct-mp4 source from the media-token
  // response. `null` when the event predates byte-size reporting.
  // Only consulted on the no-HLS fallback path.
  directTotalBytes: number | null;
  // Bytes loaded by `hls.js` so far (accumulated FRAG_LOADED
  // payloads). `null` when HLS isn't the active source.
  hlsLoadedBytes: number | null;
}

export interface BufferOverlayDisplay {
  // 0-100. Progress toward the "ready to play" byte threshold. Both
  // the percent number and the "<downloaded> / <needed>" pair report
  // the same signal so they agree visually (the old display showed
  // 7 % and 80 % side-by-side which read like a UI bug).
  pct: number;
  // Render the "downloaded" half of "<downloaded> / <needed>" when
  // non-null; render only the percent otherwise.
  downloadedBytes: number | null;
  // Render the "needed" half when non-null. May be null even when
  // `downloadedBytes` is set (e.g. HLS just got its first FRAG_LOADED
  // but `v.buffered` is still empty — we know bytes, can't yet
  // estimate the bitrate proxy).
  startupBytes: number | null;
}

// Seconds of buffered data that the player typically needs in front
// of currentTime before MSE flips into HAVE_FUTURE_DATA and playback
// resumes. Used as the byte-threshold proxy for the "needed" number.
const STARTUP_SECONDS = 3;

// Floor for the "needed" number — small files would otherwise round
// to 0 KB and the display would look broken.
const MIN_STARTUP_BYTES = 64 * 1024;

export function computeBufferOverlay(input: BufferOverlayInput): BufferOverlayDisplay {
  const { bufferedSec, durationSec, directTotalBytes, hlsLoadedBytes } = input;

  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { pct: 0, downloadedBytes: null, startupBytes: null };
  }

  if (hlsLoadedBytes !== null) {
    if (bufferedSec <= 0) {
      return { pct: 0, downloadedBytes: hlsLoadedBytes, startupBytes: null };
    }
    const bytesPerSec = hlsLoadedBytes / bufferedSec;
    const startupBytes = Math.max(MIN_STARTUP_BYTES, Math.round(bytesPerSec * STARTUP_SECONDS));
    const pct = Math.min(100, Math.round((hlsLoadedBytes / startupBytes) * 100));
    return { pct, downloadedBytes: hlsLoadedBytes, startupBytes };
  }

  if (directTotalBytes === null) {
    const pct = Math.min(100, Math.round((bufferedSec / durationSec) * 100));
    return { pct, downloadedBytes: null, startupBytes: null };
  }

  const downloadedBytes = Math.round((bufferedSec / durationSec) * directTotalBytes);
  const startupBytes = Math.min(
    directTotalBytes,
    Math.max(MIN_STARTUP_BYTES, Math.round((directTotalBytes * STARTUP_SECONDS) / durationSec)),
  );
  const pct = Math.min(100, Math.round((downloadedBytes / startupBytes) * 100));
  return { pct, downloadedBytes, startupBytes };
}
