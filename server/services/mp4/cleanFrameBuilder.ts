import { Buffer } from 'buffer';
import { parseAllSamples, buildMoov, type TrackData, type SampleInfo } from './classicMoovBuilder.js';
import {
  packCleanFrameSidecar,
  type CleanFrameByteRange,
} from './cleanFrameSidecar.js';
import { buildFrameGrid } from './frameGrid.js';
import { readHdlrType } from './audioStts.js';
import type { RangeFetcher } from './fragmentIndex.js';
import type { SidecarParseCache } from './sidecarParseCache.js';

// ---------------------------------------------------------------------------
// cleanFrameBuilder — synthesizes the *.clean_frame* sidecar: a recipe for
// stitching, on the fly at serve time, a clean faststart MP4
//   [ftyp][clean moov][ONE contiguous mdat]
// from the per-sample data carried in a fragmented MP4's moof/traf/trun boxes.
//
// This builder COMPACTS all sample bytes into a single contiguous mdat in
// served order (file order), removing the moof/box gaps that interleave the
// samples in the original fragmented file. The clean moov's stco/co64 point
// into that compacted mdat. iOS AVAssetImageGenerator can frame-step on this
// clean (faststart, non-fragmented) format.
//
// The sidecar stores:
//   - prelude    = [ftyp][clean moov]  (stco already remapped to served offsets)
//   - mdatHeader = the 8- or 16-byte box header for the single compacted mdat
//   - byteRanges = ordered runs of sample bytes to copy from the original
//                  (moof/free gaps excluded)
//   - frameGrid  = the video track's presentation times (seconds, sorted)
//
// This module is a PURE builder: head buffer + file size + range fetcher in,
// packed CleanFrameSidecarData out (or null for inputs that don't need / can't
// get a clean moov — same give-ups as parseAllSamples: not fragmented, no moov,
// no moofs, no tracks, or a structural parse error).
// ---------------------------------------------------------------------------

interface ServedSample {
  trackIndex: number;
  /** absolute byte position of this sample in the original S3 file */
  absOffset: number;
  size: number;
}

/**
 * Box header for an mdat whose payload is `payloadSize` bytes. Uses the 8-byte
 * compact header unless the total box would exceed 2^32-1, in which case the
 * 16-byte 64-bit largesize form is used (size==1 + u64 largesize).
 */
function buildMdatHeader(payloadSize: number): Buffer {
  // Compact form total = 8 + payloadSize; if that fits in u32 use it.
  if (8 + payloadSize <= 0xffffffff) {
    const hdr = Buffer.allocUnsafe(8);
    hdr.writeUInt32BE(8 + payloadSize, 0);
    hdr.write('mdat', 4, 'ascii');
    return hdr;
  }
  // 64-bit largesize form: size field = 1, then u64 actual size (incl. 16B hdr).
  const hdr = Buffer.allocUnsafe(16);
  hdr.writeUInt32BE(1, 0);
  hdr.write('mdat', 4, 'ascii');
  const total = 16 + payloadSize;
  hdr.writeUInt32BE(Math.floor(total / 0x100000000), 8);
  hdr.writeUInt32BE(total >>> 0, 12);
  return hdr;
}

/**
 * Drop samples whose data falls past `fileSize`, keeping each track's
 * sample/run tables consistent. Handles TRUNCATED uploads: an incomplete FTPS
 * transfer leaves intact moov/moof headers (they describe the FULL recording)
 * but a short mdat, so the last fragment's samples reference bytes that aren't
 * there. Including them makes the builder emit a byteRange past EOF
 * (`maxSrcEnd > fileSize`) — the prod bug where the tail won't play (502 /
 * "loading" loop). ~0.5-0.8% of recordings are affected.
 *
 * Truncation cuts a contiguous byte tail, so surviving samples are a prefix
 * (per track and per run); a kept run's `firstSampleAbsOffset` (its lowest-
 * offset sample) always survives. `buildMoov` derives every duration and
 * sample table purely from the samples/runs passed in, so the trimmed tracks
 * yield a fully-consistent shorter clean MP4 (correct duration, no tail error).
 * No-op for complete files (the 99%+), so zero behaviour change there.
 */
function trimTracksToFileSize(
  tracks: TrackData[],
  fileSize: number,
): { tracks: TrackData[]; trimmed: boolean } {
  let trimmed = false;
  const out = tracks.map((t) => {
    if (!t.samples.some((s) => s.absOffset + s.size > fileSize)) return t;
    trimmed = true;
    const samples = t.samples.filter((s) => s.absOffset + s.size <= fileSize);
    const runs: TrackData['runs'] = [];
    let idx = 0;
    for (const run of t.runs) {
      const survivors = t.samples
        .slice(idx, idx + run.sampleCount)
        .filter((s) => s.absOffset + s.size <= fileSize).length;
      idx += run.sampleCount;
      if (survivors > 0) {
        runs.push({ firstSampleAbsOffset: run.firstSampleAbsOffset, sampleCount: survivors });
      }
    }
    return { ...t, samples, runs };
  });
  // Drop tracks left with no samples (a pathologically short file) so buildMoov
  // never sees an empty sample table.
  return { tracks: out.filter((t) => t.samples.length > 0), trimmed };
}

/**
 * Result of a clean-frame build.
 *
 * `truncated` is the STRUCTURAL truncation verdict: the file's own sample
 * tables referenced data past EOF, so `trimTracksToFileSize` had to drop
 * samples. It is deliberately part of the return type rather than a log line —
 * the flag used to be computed here and thrown away, which is exactly how a
 * half recording ended up indistinguishable from a complete one. Callers that
 * do not care can ignore `.truncated`; nobody can fail to notice it exists.
 *
 * Unlike the FTPS-side signal, this works no matter HOW the upload ended:
 * FTP closes the data connection to mean end-of-file, so a cut-short transfer
 * and a complete one look identical at the socket. The sample tables do not
 * lie.
 */
export interface CleanFrameBuildResult {
  buf: Buffer;
  truncated: boolean;
}

export async function buildCleanFrameSidecar(
  headBuf: Buffer,
  fileSize: number,
  fetchRange: RangeFetcher,
  cache?: SidecarParseCache,
): Promise<CleanFrameBuildResult | null> {
  try {
    const parsed = cache
      ? await cache.getOrParse(headBuf, fileSize, fetchRange)
      : await parseAllSamples(headBuf, fileSize, fetchRange);
    if (!parsed) return null;

    const { ftypBytes, mvhdBytes, mvhdInfo, tracks: rawTracks } = parsed;
    // Guard against truncated uploads: never emit a byteRange that reads past
    // the actual end of file. See trimTracksToFileSize.
    const trim = trimTracksToFileSize(rawTracks, fileSize);
    if (trim.trimmed) {
      console.warn(
        `[cleanFrameBuilder] truncated file (fileSize=${fileSize}): dropped samples whose data falls past EOF`,
      );
    }
    const tracks = trim.tracks;

    // -- Step 1: served order. Gather every sample (tagged with its track),
    // sorted by original absOffset = the order bytes land in the compacted mdat.
    const servedSamples: ServedSample[] = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      for (const s of tracks[ti].samples) {
        servedSamples.push({ trackIndex: ti, absOffset: s.absOffset, size: s.size });
      }
    }
    servedSamples.sort((a, b) => a.absOffset - b.absOffset);

    if (servedSamples.length === 0) return null;

    // -- Step 2: byteRanges. Walk served order; merge consecutive samples whose
    // ORIGINAL bytes are contiguous (prev.absOffset + prev.size === cur.absOffset)
    // into one run. A moof/box gap (or a jump between tracks) breaks the run.
    const byteRanges: CleanFrameByteRange[] = [];
    // Relative (pre-base) compacted offset of every sample, keyed by absOffset.
    // absOffset is unique across all samples (byte ranges never overlap).
    const relCompactedByAbs = new Map<number, number>();
    let compactedCursor = 0;
    for (const s of servedSamples) {
      relCompactedByAbs.set(s.absOffset, compactedCursor);
      const last = byteRanges[byteRanges.length - 1];
      if (last && last.srcOffset + last.length === s.absOffset) {
        last.length += s.size;
      } else {
        byteRanges.push({ srcOffset: s.absOffset, length: s.size });
      }
      compactedCursor += s.size;
    }
    const totalSampleBytes = compactedCursor;

    // Sanity: Σ byteRanges.length === Σ sample sizes.
    const totalRangeBytes = byteRanges.reduce((acc, r) => acc + r.length, 0);
    if (totalRangeBytes !== totalSampleBytes) {
      throw new Error(
        `cleanFrameBuilder: byteRange byte total ${totalRangeBytes} !== sample byte total ${totalSampleBytes}`,
      );
    }

    // -- Step 3: mdat header. 8 bytes unless > 4 GiB payload.
    const mdatHeader = buildMdatHeader(totalSampleBytes);
    const mdatHeaderLen = mdatHeader.length;

    // -- Step 4: chunk-offset provider. For one track, each run's chunk offset
    // is the SERVED offset of that run's first sample =
    //   base + relCompactedByAbs[run.firstSampleAbsOffset]
    // where base = preludeLen + mdatHeaderLen. The audio-stts fix can rewrite
    // durations but never sizes/offsets, so the effectiveTrack passed in here
    // carries the same runs/absOffsets as the parsed track.
    function chunkOffsetsFor(base: number): (effectiveTrack: TrackData) => number[] {
      return (effectiveTrack: TrackData) =>
        effectiveTrack.runs.map((r) => {
          const rel = relCompactedByAbs.get(r.firstSampleAbsOffset);
          if (rel === undefined) {
            throw new Error(
              `cleanFrameBuilder: run firstSampleAbsOffset ${r.firstSampleAbsOffset} not in served map`,
            );
          }
          return base + rel;
        });
    }

    // -- Step 5: two-pass clean moov synthesis (mirror classic).
    // The stco-vs-co64 decision must be fixed BEFORE pass 1 and identical across
    // both passes. The max served offset of any chunk is
    //   base + maxRelCompacted, base = preludeLen + mdatHeaderLen.
    // Bound preludeLen conservatively with a co64-built probe (co64 only grows
    // the prelude, never shrinks it) so we never under-estimate.
    // Drop empty runs (trun with sampleCount 0) before synthesising the moov.
    // Such a run pushes a `firstSampleAbsOffset` but emits NO sample, so that
    // offset is absent from `relCompactedByAbs` and chunkOffsetsFor would throw
    // "not in served map". An empty run carries zero samples and zero bytes, so
    // it is not a real chunk — filter it from each track's run list. (stco via
    // chunkOffsetsFor and stsc via buildStsc both read these runs, so they stay
    // consistent; the per-sample tables are unaffected — empty runs have no
    // samples.) classicMoovBuilder tolerates empty runs via firstSampleAbsOffset
    // + offDelta, which is why this only bites the compacted-offset clean path.
    const effectiveTracks = tracks.map((t) => ({
      ...t,
      runs: t.runs.filter((r) => r.sampleCount > 0),
    }));

    let maxRelCompacted = 0;
    for (const rel of relCompactedByAbs.values()) {
      if (rel > maxRelCompacted) maxRelCompacted = rel;
    }
    const probe = buildMoov(mvhdBytes, effectiveTracks, mvhdInfo.timescale, true, chunkOffsetsFor(0));
    const maxBase = ftypBytes.length + probe.length + mdatHeaderLen;
    const forceCo64 = maxBase + maxRelCompacted >= 0x100000000;

    const pass1 = buildMoov(
      mvhdBytes,
      effectiveTracks,
      mvhdInfo.timescale,
      forceCo64,
      chunkOffsetsFor(0),
    );
    const preludeLen = ftypBytes.length + pass1.length;
    const base = preludeLen + mdatHeaderLen;
    const pass2 = buildMoov(
      mvhdBytes,
      effectiveTracks,
      mvhdInfo.timescale,
      forceCo64,
      chunkOffsetsFor(base),
    );
    if (pass2.length !== pass1.length) {
      throw new Error(
        `cleanFrameBuilder: two-pass moov size mismatch ` +
          `(pass1=${pass1.length}, pass2=${pass2.length})`,
      );
    }

    const prelude = Buffer.concat([ftypBytes, pass2]);

    // -- Step 6: frame grid (video track only).
    const videoTrack = tracks.find((t) => readHdlrType(t.hdlrBytes) === 'vide');
    const frameGrid = videoTrack
      ? buildFrameGrid(
          videoTrack.samples.map((s: SampleInfo) => ({
            durationTicks: s.durationTicks,
            compositionOffset: s.compositionOffset,
          })),
          videoTrack.timescale,
        )
      : [];

    return {
      buf: packCleanFrameSidecar({ prelude, mdatHeader, byteRanges, frameGrid }),
      truncated: trim.trimmed,
    };
  } catch (err) {
    // Any structural error → null (the worker treats clean_frame as non-fatal;
    // the serve path falls back to the fmp4patch path on a missing sidecar).
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cleanFrameBuilder] parse failed (returning null): ${msg.slice(0, 200)}`);
    return null;
  }
}
