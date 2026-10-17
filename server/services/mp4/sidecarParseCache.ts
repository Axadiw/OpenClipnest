import { Buffer } from 'buffer';
import { parseAllSamples, type ParsedFragmentedFile } from './classicMoovBuilder.js';
import type { RangeFetcher } from './fragmentIndex.js';

/**
 * Memoizes ONE `parseAllSamples` walk of a fragmented MP4 so the sidecar builders
 * that derive from the sample table — `.clean_frame` and `.frames` — share a
 * single parse per file instead of each re-walking the moof chain.
 *
 * This is the single source of truth that keeps the two artifacts in sync: when
 * the grid the web steps on and the sample table the iOS clean MP4 seeks on come
 * from the SAME parse, they cannot drift. Separate parses are exactly how the
 * fps×10 and all-keyframe-stss bugs slipped in. The underlying RangeFetcher
 * already dedups S3 GETs (cachingFetcher); this dedups the CPU-bound parse on top.
 *
 * Per-file: the worker creates one cache and discards it after the file's
 * sidecars are built — no cross-file state. `null` (unparseable) is memoized too,
 * so a give-up file isn't re-walked by the second builder.
 */
export class SidecarParseCache {
  private parsed: ParsedFragmentedFile | null | undefined;

  async getOrParse(
    headBuf: Buffer,
    fileSize: number,
    fetchRange: RangeFetcher,
  ): Promise<ParsedFragmentedFile | null> {
    if (this.parsed !== undefined) return this.parsed;
    this.parsed = (await parseAllSamples(headBuf, fileSize, fetchRange)) ?? null;
    return this.parsed;
  }
}
