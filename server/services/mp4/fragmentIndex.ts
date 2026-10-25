import { Buffer } from 'buffer';
import {
  readBoxHeader,
  findChildBox,
  parseTfhd,
  parseTrun,
  parseTfdt,
  type BoxHeader,
} from './boxes.js';
import { inspectMoov, type MoovInfo } from './moov.js';

export type RangeFetcher = (start: number, end: number) => Promise<Buffer>;

export interface FragmentRef {
  /** absolute byte offset of moof in the original file */
  moofFileOffset: number;
  /** byte size of the moof box including its 8-byte header */
  moofSize: number;
  /** byte size of the mdat box including its 8-byte header */
  mdatSize: number;
  /** cumulative decode time at fragment start, in primary-track timescale */
  decodeTime: number;
  /** duration of this fragment in primary-track timescale (PRIMARY track only) */
  duration: number;
  /** number of samples in this fragment for the primary track */
  sampleCount: number;
  /**
   * Per-track duration of this fragment, each entry expressed in that
   * track's OWN mdhd timescale (no cross-track scaling). Length matches
   * `MoovInfo.trackCount` when populated. Populated when the parser
   * receives `trackTimescales`; older callers / unit-test paths that
   * pass undefined still get a single-track FragmentRef equivalent to
   * the v0.10.209 shape. Drives the v6 sidecar trailer and the dual-sidx
   * serve path (one sidx per track, each indexing this track's per-
   * fragment durations in its own timescale).
   */
  perTrackDurationTicks?: Array<{ trackId: number; ticks: number }>;
}

export interface IndexResult {
  ftypSize: number;
  moov: MoovInfo;
  fragments: FragmentRef[];
  /** total declared duration in primary-track timescale */
  totalTrackDuration: number;
  /** byte offset where mdat span begins (right after moov) */
  mdatSpanStart: number;
  /** byte offset where mdat span ends (file size for class A) */
  mdatSpanEnd: number;
}

// moof header parsing → fragment metadata

/**
 * Parse one moof box header (and the immediately-following mdat header) at
 * the given absolute file offset. Returns the fragment ref or `null` if the
 * buffer doesn't contain enough bytes.
 *
 * `bufferFileOffset` is the absolute position in the file that `buf[0]`
 * represents — caller may pass a window slice rather than the entire file.
 */
export function parseMoofAndMdatHeaders(
  buf: Buffer,
  moofOffsetInBuf: number,
  primaryTrackId: number,
  trexDefaults: Map<number, { defaultSampleDuration: number; defaultSampleSize: number }>,
  cumulativeDecodeTime: number,
  trackTimescales?: Map<number, number>,
): { fragment: FragmentRef; nextOffsetInBuf: number } | null {
  const moofHdr = readBoxHeader(buf, moofOffsetInBuf);
  if (!moofHdr || moofHdr.type !== 'moof') return null;
  const moofEnd = moofOffsetInBuf + moofHdr.size;
  if (moofEnd > buf.length) return null;

  // Walk ALL traf children inside moof. We need the primary traf for the
  // canonical decodeTime/duration/sampleCount FragmentRef fields, plus
  // every OTHER traf so we can record each track's own per-fragment duration
  // (Reolink dual-track fmp4 — video traf is ~2.4s but audio traf is ~2.6s).
  // Those per-track durations drive the v6 sidecar trailer and the dual-sidx
  // serve path (one sidx per track, each in its own timescale).
  const moofDataStart = moofOffsetInBuf + moofHdr.headerSize;
  const allTrafs: { offset: number; header: BoxHeader; trackId: number }[] = [];
  let q = moofDataStart;
  while (q + 8 <= moofEnd) {
    const h = readBoxHeader(buf, q);
    if (!h || h.size <= 0) break;
    if (h.type === 'traf') {
      const trafDataStart = q + h.headerSize;
      const trafDataEnd = q + h.size;
      const tfhdBox = findChildBox(buf, trafDataStart, trafDataEnd, 'tfhd');
      if (tfhdBox) {
        const tfhd = parseTfhd(buf, tfhdBox.offset, tfhdBox.header.headerSize);
        allTrafs.push({ offset: q, header: h, trackId: tfhd.trackId });
      }
    }
    q += h.size;
  }

  const primaryTraf = allTrafs.find(t => t.trackId === primaryTrackId) || null;

  if (!primaryTraf) {
    // No primary-track traf in this moof — should not happen for Reolink.
    // Return zero-duration fragment so the index is contiguous.
    const mdatHdr = readBoxHeader(buf, moofEnd);
    if (!mdatHdr || mdatHdr.type !== 'mdat') return null;
    return {
      fragment: {
        moofFileOffset: moofOffsetInBuf,
        moofSize: moofHdr.size,
        mdatSize: mdatHdr.size,
        decodeTime: cumulativeDecodeTime,
        duration: 0,
        sampleCount: 0,
        perTrackDurationTicks: trackTimescales ? [] : undefined,
      },
      nextOffsetInBuf: moofEnd + mdatHdr.size,
    };
  }

  /**
   * Sum trun.sampleDuration across every trun inside this traf, falling
   * back to tfhd default and then trex default (per spec). Returns the
   * total in the TRAF'S OWN timescale ticks — caller scales if needed.
   */
  const trafTotalDuration = (
    trafOffset: number,
    trafHeader: BoxHeader,
    trafTrackId: number,
  ): { duration: number; sampleCount: number } => {
    const tDataStart = trafOffset + trafHeader.headerSize;
    const tDataEnd = trafOffset + trafHeader.size;
    const tfhdBoxLocal = findChildBox(buf, tDataStart, tDataEnd, 'tfhd');
    if (!tfhdBoxLocal) {
      throw new Error(`trafTotalDuration: traf at ${trafOffset} has no tfhd box`);
    }
    const tfhdLocal = parseTfhd(buf, tfhdBoxLocal.offset, tfhdBoxLocal.header.headerSize);
    let sumDur = 0;
    let sumSamples = 0;
    let r = tDataStart;
    while (r + 8 <= tDataEnd) {
      const h = readBoxHeader(buf, r);
      if (!h || h.size <= 0) break;
      if (h.type === 'trun') {
        const trun = parseTrun(buf, r, h.headerSize);
        sumSamples += trun.sampleCount;
        if (trun.hasSampleDurations) {
          sumDur += trun.totalSampleDuration;
        } else {
          const def =
            tfhdLocal.defaultSampleDuration ??
            trexDefaults.get(trafTrackId)?.defaultSampleDuration ??
            0;
          sumDur += def * trun.sampleCount;
        }
      }
      r += h.size;
    }
    return { duration: sumDur, sampleCount: sumSamples };
  };

  const trafDataStart = primaryTraf.offset + primaryTraf.header.headerSize;
  const trafDataEnd = primaryTraf.offset + primaryTraf.header.size;

  const tfdtBox = findChildBox(buf, trafDataStart, trafDataEnd, 'tfdt');
  let decodeTime = cumulativeDecodeTime;
  if (tfdtBox) {
    decodeTime = parseTfdt(buf, tfdtBox.offset, tfdtBox.header.headerSize)
      .baseMediaDecodeTime;
  }

  const primary = trafTotalDuration(primaryTraf.offset, primaryTraf.header, primaryTraf.trackId);
  const duration = primary.duration;
  const sampleCount = primary.sampleCount;

  // Record per-track durations in each track's OWN timescale (drives the v6
  // sidecar trailer and the dual-sidx serve path). When trackTimescales isn't
  // provided (older callers / unit-test paths) we emit a single-track
  // FragmentRef with no extra per-track data — pre-v6 behaviour, no regression.
  let perTrackDurationTicks: Array<{ trackId: number; ticks: number }> | undefined;
  if (trackTimescales) {
    perTrackDurationTicks = [{ trackId: primaryTrackId, ticks: duration }];
    const primaryTs = trackTimescales.get(primaryTrackId);
    if (primaryTs && primaryTs > 0) {
      for (const t of allTrafs) {
        if (t.trackId === primaryTrackId) continue;
        const ts = trackTimescales.get(t.trackId);
        if (!ts || ts <= 0) continue;
        const otherDur = trafTotalDuration(t.offset, t.header, t.trackId).duration;
        perTrackDurationTicks.push({ trackId: t.trackId, ticks: otherDur });
      }
    }
  }

  // Following box must be mdat
  const mdatHdr = readBoxHeader(buf, moofEnd);
  if (!mdatHdr || mdatHdr.type !== 'mdat') return null;

  return {
    fragment: {
      moofFileOffset: moofOffsetInBuf,
      moofSize: moofHdr.size,
      mdatSize: mdatHdr.size,
      decodeTime,
      duration,
      sampleCount,
      perTrackDurationTicks,
    },
    nextOffsetInBuf: moofEnd + mdatHdr.size,
  };
}

// Indexing — walks moof+mdat pairs across the whole file

// Upper bound for a single Reolink fragment's `trun` duration before we treat
// it as bit-flipped garbage. Real Reolink chunks are ~2 s; we leave a 15×
// headroom so that genuinely long fragments stay valid while clearly corrupt
// ones (observed prod: 28_635 s in a single fragment) get caught.
const MAX_REASONABLE_FRAGMENT_SECONDS = 30;

// Hard ceiling on the number of fragments we will index from a single file.
//
// Every indexed fragment retains a small `FragmentRef` object in memory. A
// crafted or corrupt file built from minimal `[moof][mdat]` atom pairs (a
// header-only moof + header-only mdat is just 16 bytes) lets an attacker pack
// ~67M fragment boundaries into a 1 GB upload. At ~150 B of retained JS-object
// overhead per FragmentRef that is ~10 GB of heap — an OOM that takes the whole
// thumbnail-worker pod (4 GiB limit) down and kills every other user's job
// running on it.
//
// Sizing: legit fmp4 recordings use ~2 s fragments. Even a pathologically long
// single-file continuous recording of 24 h at a high 1 fragment/second rate is
// only ~86_400 fragments. 500_000 leaves ~5.7× headroom over that extreme
// (≈11.5 days of continuous 2 s fragments — no real camera file gets close),
// while capping retained FragmentRefs at ~500k × ~150 B ≈ 75 MB, comfortably
// inside the pod budget. Exceeding it means the file is corrupt / hostile, so
// we fail closed with a throw the caller already treats as an unprocessable
// file (same as the other `indexFragmentedMp4` throws) rather than continuing
// to allocate.
export const MAX_FRAGMENTS = 500_000;

/**
 * Build the full fragment index from a fragmented MP4. The file is read
 * lazily through `fetchRange` so we never buffer the whole thing in memory.
 *
 * The strategy:
 *   1. We already have the head buffer (≥ moov + first moof+mdat).
 *   2. After processing each moof+mdat pair, we know the start offset of the
 *      next moof. Fetch ~16 KB starting there (covers any reasonable moof
 *      header + small enough that worst case is `30 × 16 KB = 480 KB` extra
 *      transfer for a 120-fragment file).
 *   3. Repeat until we reach `fileSize`.
 *
 * Returns the moov info, fragment list, and total duration in primary-track
 * timescale (sum of fragment durations). Truncates the walk at the first
 * fragment whose `trun` reports an absurd duration (>30 s) — see the inline
 * comment in the loop for the rationale.
 */
export async function indexFragmentedMp4(
  headBuf: Buffer,
  fileSize: number,
  fetchRange: RangeFetcher,
  maxFragments: number = MAX_FRAGMENTS,
): Promise<IndexResult> {
  const { ftypSize, moov } = inspectMoov(headBuf);

  if (!moov.hasMvex) {
    throw new Error('indexFragmentedMp4: file is not fragmented (no mvex in moov)');
  }

  // The corrupt-fragment guard below validates each fragment's duration in
  // SECONDS by dividing its tick count by the primary track timescale. A zero
  // or NaN timescale makes that division 0/NaN — so EVERY fragment would slip
  // past the `> 30 s` check no matter how absurd its tick count, and a file of
  // zero-tick fragments would accumulate unbounded. A non-positive / non-finite
  // primary timescale means the whole file's timing is unusable, so fail closed.
  if (!Number.isFinite(moov.primaryTrackTimescale) || moov.primaryTrackTimescale <= 0) {
    throw new Error(
      `indexFragmentedMp4: invalid primary track timescale (${moov.primaryTrackTimescale}) — cannot validate fragment durations`,
    );
  }

  const fragments: FragmentRef[] = [];
  let cumulativeDecodeTime = 0;
  let totalDuration = 0;
  const mdatSpanStart = ftypSize + moov.moovSize;

  // Start scanning from after moov.
  let cursorFileOffset = mdatSpanStart;

  // We can read fragments from headBuf as long as they're within it.
  // Once we pass headBuf's range, fetch additional chunks.
  while (cursorFileOffset < fileSize) {
    // Hard fragment-count ceiling (see MAX_FRAGMENTS). A crafted file of
    // minimal `[moof][mdat]` atoms would otherwise pack tens of millions of
    // FragmentRefs into memory and OOM the pod. Fail closed — the caller treats
    // this like any other unprocessable-file throw.
    if (fragments.length >= maxFragments) {
      throw new Error(
        `indexFragmentedMp4: fragment count exceeded MAX_FRAGMENTS (${maxFragments}) ` +
        `at file offset ${cursorFileOffset} — refusing to index a likely corrupt/hostile file`,
      );
    }

    let buf: Buffer;
    let bufFileOffset: number;
    if (cursorFileOffset + 16 <= headBuf.length) {
      buf = headBuf;
      bufFileOffset = 0;
    } else {
      // Fetch a chunk starting at cursor; small enough that moof+mdat headers
      // fit comfortably (mdat header is just 8 or 16 bytes; we don't read
      // mdat payload).
      const fetchEnd = Math.min(cursorFileOffset + 16384, fileSize);
      buf = await fetchRange(cursorFileOffset, fetchEnd - 1);
      bufFileOffset = cursorFileOffset;
    }

    const offsetInBuf = cursorFileOffset - bufFileOffset;
    const moofHdr = readBoxHeader(buf, offsetInBuf);
    if (!moofHdr) break;

    // A trailing fragment index (ffmpeg writes one, and so does a clip
    // downloaded from us) ends the fragments: stop here and leave it out of the
    // span, since the sidecar carries its own mfra. Only after a fragment —
    // an mfra in place of the first one is still a broken file.
    if (moofHdr.type === 'mfra' && fragments.length > 0) break;

    if (moofHdr.type !== 'moof') {
      throw new Error(
        `indexFragmentedMp4: expected moof at file offset ${cursorFileOffset}, got "${moofHdr.type}"`,
      );
    }

    // Need both moof + the 8-byte mdat header in buf
    const requiredEndInBuf = offsetInBuf + moofHdr.size + 16; // +16 covers 8B mdat header + 8B largesize safety
    if (requiredEndInBuf > buf.length) {
      // Refetch with enough bytes (moof + mdat header)
      const fetchEnd = Math.min(cursorFileOffset + moofHdr.size + 32, fileSize);
      buf = await fetchRange(cursorFileOffset, fetchEnd - 1);
      bufFileOffset = cursorFileOffset;
    }

    const parsed = parseMoofAndMdatHeaders(
      buf,
      cursorFileOffset - bufFileOffset,
      moov.primaryTrackId,
      moov.trexDefaults,
      cumulativeDecodeTime,
      moov.trackTimescales,
    );
    if (!parsed) {
      throw new Error(
        `indexFragmentedMp4: failed to parse moof+mdat at offset ${cursorFileOffset}`,
      );
    }

    // Adjust file offset for the fragment ref (parser used buffer-relative)
    const fragment: FragmentRef = {
      ...parsed.fragment,
      moofFileOffset: cursorFileOffset,
    };

    // Corrupt-fragment guard. Reolink cameras occasionally write a bit-flipped
    // sample_duration into trun (observed on prod: a single fragment reporting
    // ~4.3 × 10^9 ticks at ts=150000 ≈ 8 h, vs the expected ~300_000 ticks ≈
    // 2 s). The bogus duration propagates to the next fragment's tfdt
    // (camera computes it as prev_decode + prev_duration), so every fragment
    // AFTER the outlier carries cascading-corrupted decode times. Trusting any
    // of those poisons sidecar.totalDurationSeconds → events.duration → an 8 h
    // bar in the timeline + player stuck in seekPending. Truncate the walk at
    // the first outlier; downstream callers see a shorter-but-coherent
    // fragment list. The cutoff is 30 s — Reolink chunks are ~2 s, anything
    // past 30 s is corruption, not a long-fragment edge case.
    // Zero- (or negative / NaN) duration fragments are corrupt, not legit. A
    // header-only moof carries no primary traf → parseMoofAndMdatHeaders returns
    // a zero-duration ref; a file built entirely from such atoms would sail past
    // the `> 30 s` outlier check (0 is never > 30) and accumulate unbounded.
    // Treat the first one as the corruption boundary and truncate, exactly like
    // the over-long outlier below.
    if (!(fragment.duration > 0)) {
      console.warn(
        `indexFragmentedMp4: truncating at zero-/invalid-duration fragment ` +
        `(offset=${cursorFileOffset}, duration=${fragment.duration} ticks). ` +
        `${fragments.length} healthy fragments kept; ` +
        `remaining file bytes (${fileSize - cursorFileOffset}) discarded.`,
      );
      break;
    }

    const fragmentSec = fragment.duration / moov.primaryTrackTimescale;
    if (fragmentSec > MAX_REASONABLE_FRAGMENT_SECONDS) {
      console.warn(
        `indexFragmentedMp4: truncating at corrupt fragment ` +
        `(offset=${cursorFileOffset}, duration=${fragment.duration} ticks, ` +
        `~${fragmentSec.toFixed(1)} s @ ts=${moov.primaryTrackTimescale}). ` +
        `${fragments.length} healthy fragments kept; ` +
        `remaining file bytes (${fileSize - cursorFileOffset}) discarded.`,
      );
      break;
    }

    fragments.push(fragment);
    totalDuration = Math.max(
      totalDuration,
      fragment.decodeTime + fragment.duration,
    );
    cumulativeDecodeTime = fragment.decodeTime + fragment.duration;

    cursorFileOffset += fragment.moofSize + fragment.mdatSize;
  }

  return {
    ftypSize,
    moov,
    fragments,
    totalTrackDuration: totalDuration,
    mdatSpanStart,
    mdatSpanEnd: cursorFileOffset,
  };
}
