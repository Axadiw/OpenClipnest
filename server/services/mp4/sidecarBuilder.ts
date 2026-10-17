import { Buffer } from 'buffer';
import { classifyHead, type ClassificationResult } from './classify.js';
import { indexFragmentedMp4, type RangeFetcher, type IndexResult } from './fragmentIndex.js';
import { buildPatchedMoov } from './moovPatch.js';
import { buildMfra } from './seekTables.js';
import { buildSidecar, type PerTrackDurations } from './sidecar.js';
import { frameRateFromSampleCounts } from './frameRate.js';

/**
 * True average fps for an indexed fragmented file.
 * DRY helper shared by the sidecar build path and the backfill reconciler so
 * both compute fps the same way (real sample counts from fragments, not the
 * nominal trex.default_sample_duration which is ~10× too high on Reolink VFR).
 *
 * @returns fps, or null if undeterminable (zero timescale / no samples / fps > MAX).
 */
export function frameRateFromIndex(index: IndexResult): number | null {
  if (index.moov.primaryTrackTimescale <= 0) return null;
  const totalSeconds = index.totalTrackDuration / index.moov.primaryTrackTimescale;
  const totalSamples = index.fragments.reduce((sum, f) => sum + f.sampleCount, 0);
  return frameRateFromSampleCounts(totalSamples, totalSeconds);
}

// Top-level helper: build sidecar from a fragmented MP4

/**
 * One-shot helper: given the head buffer + file size + fetcher, classify the
 * file and build a sidecar (or return `null` if no sidecar is needed).
 *
 * Caller should:
 *   - if classification is A: write `result.sidecar` to S3 and mark
 *     processing_state = 'ready'.
 *   - if classification is B/C: skip sidecar, mark ready immediately.
 *   - if classification is D: tombstone with reason.
 *   - if classification is E: tombstone with reason.
 */
export async function buildSidecarForFile(
  headBuf: Buffer,
  fileSize: number,
  fetchRange: RangeFetcher,
): Promise<{
  classification: ClassificationResult;
  sidecar: Buffer | null;
  /** present for class A — useful for caller's logging / DB metadata */
  totalDurationSeconds?: number;
  /** true average fps from real sample counts; null = unknown */
  frameRate?: number | null;
}> {
  const cls = classifyHead(headBuf);
  if (cls.class !== 'A') {
    return { classification: cls, sidecar: null };
  }

  const index = await indexFragmentedMp4(headBuf, fileSize, fetchRange);
  const totalSeconds =
    index.totalTrackDuration / index.moov.primaryTrackTimescale;

  const origMoov = headBuf.slice(
    index.moov.moovFileOffset,
    index.moov.moovFileOffset + index.moov.moovSize,
  );
  const patchedMoov = buildPatchedMoov(origMoov, index.moov, totalSeconds);
  const ftyp = headBuf.slice(0, index.ftypSize);
  const prelude = Buffer.concat([ftyp, patchedMoov]);

  // moov size is unchanged by the patch (durations are written in-place into
  // existing fields). Moof file offsets in the served stream therefore match
  // the original file exactly — no shift, so `tfhd.base_data_offset` values
  // inside each moof remain valid.
  const moofFileOffsetShift = 0;

  const mfra = buildMfra(
    index.fragments,
    index.moov.primaryTrackId,
    moofFileOffsetShift,
  );

  const durationMs = Math.max(0, Math.round(totalSeconds * 1000));
  // V6 sidecar trailer: per-track per-fragment durations in each track's own
  // mdhd timescale. Drives the dual-sidx serve path (one sidx per track),
  // which is what unlocks Chrome's <1s cold start on multi-track Reolink fmp4.
  // (This replaced the retired v5 single-table trailer, which broke playback
  // four times — v0.10.201/202/204/208 — because a single sidx can only carry
  // one track's timeline.)
  const fragCount = index.fragments.length;
  const trackIds = new Set<number>();
  for (const f of index.fragments) {
    if (!f.perTrackDurationTicks) continue;
    for (const t of f.perTrackDurationTicks) trackIds.add(t.trackId);
  }
  let perTrack: PerTrackDurations[] | undefined;
  if (fragCount > 0 && trackIds.size > 0) {
    perTrack = [];
    for (const trackId of trackIds) {
      const timescale = index.moov.trackTimescales.get(trackId);
      if (!timescale || timescale <= 0) continue;
      const perFragmentTicks: number[] = [];
      for (const f of index.fragments) {
        const entry = f.perTrackDurationTicks?.find(t => t.trackId === trackId);
        perFragmentTicks.push(Math.max(0, entry ? entry.ticks : 0));
      }
      perTrack.push({ trackId, timescale, perFragmentTicks });
    }
    if (perTrack.length === 0) perTrack = undefined;
  }
  const sidecar = buildSidecar(prelude, mfra, durationMs, perTrack);

  const frameRate = frameRateFromIndex(index);

  return { classification: cls, sidecar, totalDurationSeconds: totalSeconds, frameRate };
}
