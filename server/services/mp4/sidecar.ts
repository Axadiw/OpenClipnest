import { Buffer } from 'buffer';
import { readBoxHeader, findChildBox, parseMvhd } from './boxes.js';

// Sidecar pack/unpack

/**
 * Pack the prelude (ftyp + patched_moov) + mfra + optional trailing duration
 * + optional v6 per-track per-fragment duration table into the sidecar binary
 * format:
 *
 *     [u32 prelude_len][prelude]
 *     [u32 mfra_len][mfra]
 *     [u32 duration_ms]               ← v4+ (optional, see below)
 *     [u32 V6_MARKER = 0x76362e30]    ← "v6.0" sentinel; per-track per-fragment
 *     [u32 frag_count]                  durations driving the dual-sidx serve
 *     [u32 track_count]                 layout. Sits after the v4 duration so a
 *     per_track × track_count:          parser walks trailers in order; an
 *       [u32 trackId]                   unknown trailer stops the walk without
 *       [u32 timescale]                 throwing (forward-compat).
 *       [u32 dur_ticks] × frag_count
 *
 * The trailing `duration_ms` was introduced in the v4 schema bump because
 * the patched moov no longer carries durations in mvhd/tkhd/mdhd (every
 * non-zero header duration confuses iOS WebKit into a 2× over-report on
 * fragmented MP4 without `mehd`). Storing duration here lets
 * `getDurationSecondsFromExistingSidecar` keep recovering the canonical
 * value without re-walking fragments.
 *
 * The v6 per-track table drives the dual-sidx serve path: ONE sidx PER TRACK,
 * each indexing the same N fragments with the track's own timescale and
 * per-fragment duration (confirmed against ffmpeg's `+dash+global_sidx`). It
 * replaced the retired v5 trailer (a single primary-track max-duration table,
 * marker 0x76352e30), which collapsed video+audio durations into one number
 * and broke multi-track playback four times (v0.10.201/202/204/208) because a
 * single sidx can only carry one track's timeline. Lingering v5 sidecars in
 * storage now parse as v4 (the retired marker hits the unknown-trailer break)
 * and get rebaked to v6 by the reconciler.
 */
export const SIDECAR_V6_MARKER = 0x76362e30; // 'v6.0' big-endian

/**
 * Per-track per-fragment duration data for the v6 sidecar trailer. One entry
 * per track of interest (typically video + audio for Reolink dual-track
 * clips, or just video for single-track variants). `perFragmentTicks` has
 * length equal to fragment count and stores per-fragment duration in this
 * track's `timescale` ticks.
 */
export interface PerTrackDurations {
  trackId: number;
  timescale: number;
  perFragmentTicks: number[];
}

export function buildSidecar(
  prelude: Buffer,
  mfra: Buffer,
  durationMs?: number,
  perTrack?: PerTrackDurations[],
): Buffer {
  const hasDur = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0;
  const hasV6 = !!perTrack && perTrack.length > 0;
  if (hasV6 && !hasDur) {
    // The v6 table is meaningless without the v4 durationMs anchor that the
    // server also uses to clamp the last fragment's subsegment duration.
    // Require both rather than silently dropping the trailer.
    throw new Error('buildSidecar: v6 trailer requires durationMs');
  }
  if (hasV6) {
    const N0 = perTrack![0].perFragmentTicks.length;
    for (const t of perTrack!) {
      if (t.perFragmentTicks.length !== N0) {
        throw new Error(`buildSidecar: v6 track ${t.trackId} has ${t.perFragmentTicks.length} fragments, expected ${N0}`);
      }
    }
  }
  const v4TailLen = hasDur ? 4 : 0;
  const v6TailLen = hasV6
    ? 4 + 4 + 4 + perTrack!.reduce((s, t) => s + 4 + 4 + t.perFragmentTicks.length * 4, 0)
    : 0;
  const buf = Buffer.alloc(4 + prelude.length + 4 + mfra.length + v4TailLen + v6TailLen);
  let p = 0;
  buf.writeUInt32BE(prelude.length, p);
  p += 4;
  prelude.copy(buf, p);
  p += prelude.length;
  buf.writeUInt32BE(mfra.length, p);
  p += 4;
  mfra.copy(buf, p);
  p += mfra.length;
  if (hasDur) {
    buf.writeUInt32BE(Math.min(durationMs!, 0xffffffff) >>> 0, p);
    p += 4;
  }
  if (hasV6) {
    buf.writeUInt32BE(SIDECAR_V6_MARKER, p);
    p += 4;
    buf.writeUInt32BE(perTrack![0].perFragmentTicks.length, p);
    p += 4;
    buf.writeUInt32BE(perTrack!.length, p);
    p += 4;
    for (const t of perTrack!) {
      buf.writeUInt32BE(t.trackId >>> 0, p);
      p += 4;
      buf.writeUInt32BE(t.timescale >>> 0, p);
      p += 4;
      for (const d of t.perFragmentTicks) {
        buf.writeUInt32BE(d >>> 0, p);
        p += 4;
      }
    }
  }
  return buf;
}

export interface ParsedSidecar {
  prelude: Buffer;
  mfra: Buffer;
  /** Present iff sidecar was built with the v4+ trailing duration field. */
  durationMs?: number;
  /**
   * Per-track per-fragment durations. Present iff the sidecar was built
   * with v6 (`SIDECAR_V6_MARKER` trailer). Server uses these to emit one
   * `sidx` per track (Option B dual-sidx layout) so multi-track clips get
   * the same ≤1 s Chrome cold-start that single-track has had since
   * v0.10.201.
   */
  perTrack?: PerTrackDurations[];
}

/**
 * Reverse of buildSidecar. Throws on malformed input. Walks optional trailers
 * in order (v4 → v6) so a sidecar can carry any subset, and unknown trailers
 * stop the walk without throwing (forward-compat — this is also how a retired
 * v5 sidecar still in storage degrades cleanly to v4). Format is detected by
 * looking at the bytes immediately after the mfra:
 *   - 0 trailing bytes → v3
 *   - 4 trailing bytes → v4 (duration_ms only)
 *   - ≥12 trailing bytes → walk markers (V6_MARKER) after the duration field.
 */
export function parseSidecar(buf: Buffer): ParsedSidecar {
  if (buf.length < 8) throw new Error('parseSidecar: buffer too short');
  const preludeLen = buf.readUInt32BE(0);
  if (preludeLen + 8 > buf.length) {
    throw new Error('parseSidecar: prelude length exceeds buffer');
  }
  const prelude = buf.slice(4, 4 + preludeLen);
  const mfraLenOffset = 4 + preludeLen;
  const mfraLen = buf.readUInt32BE(mfraLenOffset);
  const mfraEnd = mfraLenOffset + 4 + mfraLen;
  if (mfraEnd > buf.length) {
    throw new Error('parseSidecar: mfra length exceeds buffer');
  }
  const mfra = buf.slice(mfraLenOffset + 4, mfraEnd);
  let perTrack: PerTrackDurations[] | undefined;

  if (buf.length === mfraEnd) {
    // v3 — no trailer.
    return { prelude, mfra };
  }
  if (buf.length < mfraEnd + 4) {
    throw new Error('parseSidecar: truncated trailer');
  }
  const durationMs = buf.readUInt32BE(mfraEnd);
  let p = mfraEnd + 4;

  // Walk optional trailer markers; stop on the first byte that doesn't match
  // a known marker (lets future versions — and a retired v5 trailer — skip
  // past us without breaking; they just look like an "unknown stray").
  while (p + 8 <= buf.length) {
    const marker = buf.readUInt32BE(p);
    if (marker === SIDECAR_V6_MARKER) {
      if (p + 12 > buf.length) {
        throw new Error(`parseSidecar: v6 header truncated at offset ${p}`);
      }
      const fragCount = buf.readUInt32BE(p + 4);
      const trackCount = buf.readUInt32BE(p + 8);
      let q = p + 12;
      const tracks: PerTrackDurations[] = [];
      for (let t = 0; t < trackCount; t++) {
        if (q + 8 + fragCount * 4 > buf.length) {
          throw new Error(`parseSidecar: v6 truncated at track ${t}`);
        }
        const trackId = buf.readUInt32BE(q);
        const timescale = buf.readUInt32BE(q + 4);
        const perFragmentTicks: number[] = [];
        for (let i = 0; i < fragCount; i++) {
          perFragmentTicks.push(buf.readUInt32BE(q + 8 + i * 4));
        }
        tracks.push({ trackId, timescale, perFragmentTicks });
        q += 8 + fragCount * 4;
      }
      perTrack = tracks;
      p = q;
    } else {
      // Unknown marker (a future v7, or a retired v5 sidecar) — stop walking.
      // Don't throw: still return the v4/v6 fields we understood.
      break;
    }
  }
  return { prelude, mfra, durationMs, perTrack };
}

/**
 * Given the prelude bytes of a sidecar (ftyp + patched moov), return the
 * playback duration in seconds parsed from the patched `mvhd` box.
 *
 * The patched moov has its mvhd duration overwritten in-place by
 * `patchMoovDurationsInPlace` when the sidecar was first generated, so this
 * recovers the same `totalDurationSeconds` that `buildSidecarForFile` returned
 * — without re-walking fragments. Used by the thumbnail worker / a
 * duration backfill to write `events.duration` for files whose sidecar
 * already exists (processing_state = 'ready') without doing a
 * fresh full-file index pass.
 *
 * Returns `null` if mvhd is missing or has duration=0 (degenerate prelude).
 */
export function readDurationSecondsFromPrelude(prelude: Buffer): number | null {
  // ftyp first, then moov.
  const ftyp = readBoxHeader(prelude, 0);
  if (!ftyp || ftyp.type !== 'ftyp') return null;
  const moovOffset = ftyp.size;
  const moovHdr = readBoxHeader(prelude, moovOffset);
  if (!moovHdr || moovHdr.type !== 'moov') return null;
  const moovDataStart = moovOffset + moovHdr.headerSize;
  const moovDataEnd = moovOffset + moovHdr.size;
  const mvhd = findChildBox(prelude, moovDataStart, moovDataEnd, 'mvhd');
  if (!mvhd) return null;
  const info = parseMvhd(prelude, mvhd.offset, mvhd.header.headerSize);
  if (info.timescale <= 0 || info.duration <= 0) return null;
  return info.duration / info.timescale;
}
