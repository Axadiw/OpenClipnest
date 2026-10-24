import { subtract, type ByteRange } from '../byteRanges';
import { MAX_MOOV_BYTES, parseSampleIndex, probeLayout, windowBytes, type SampleIndex } from '../mp4/sampleTable';
import { prefetchRange } from '../scrubCache/client';
import { videoCacheKey } from '../../sw/videoRequest';

export const PREVIEW_AHEAD_SEC = 5;
const HEAD_BYTES = 64 * 1024;
/** Upper bound on Range requests per load: the worker may answer each with a short 206. */
const MAX_FETCHES = 16;

const memo = new Map<string, SampleIndex>();
/** Size of the representation each memoised index was read from (Content-Range total). */
const totals = new Map<string, number>();

/** Byte size of the file `loadSampleIndex` parsed for this URL, 0 when unknown. */
export function sampleIndexTotal(url: string): number {
  const key = videoCacheKey(url);
  return (key && totals.get(key)) || 0;
}

function responseTotal(res: Response, bodyLength: number): number {
  if (res.status === 200) return bodyLength;
  const m = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '');
  return m ? Number(m[1]) : 0;
}

/** Test hook: forgets every memoised index. */
export function clearSampleIndexMemo(): void {
  memo.clear();
  totals.clear();
}

/**
 * Reads the head of a clean-video URL (through the service worker, so the bytes are shared with
 * the player) and parses its sample index. The worker may answer a Range with fewer bytes than
 * asked, so this keeps requesting from the first missing byte. `null` for fragmented or
 * unsupported files, errors and aborts; only successes are memoised, per cache key.
 */
export async function loadSampleIndex(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SampleIndex | null> {
  const key = videoCacheKey(url);
  if (key) {
    const hit = memo.get(key);
    if (hit) return hit;
  }
  try {
    let buf = new Uint8Array(0);
    let want = HEAD_BYTES;
    for (let i = 0; i < MAX_FETCHES; i++) {
      if (signal.aborted) return null;
      const res = await fetchImpl(url, {
        headers: { Range: `bytes=${buf.length}-${want - 1}` },
        signal,
      });
      if (res.status !== 206 && res.status !== 200) return null;
      const body = new Uint8Array(await res.arrayBuffer());
      if (signal.aborted || body.length === 0) return null;
      if (res.status === 200) {
        buf = body; // the whole file, whatever we asked for
      } else {
        const next = new Uint8Array(buf.length + body.length);
        next.set(buf);
        next.set(body, buf.length);
        buf = next;
      }
      const layout = probeLayout(buf);
      if (layout.kind === 'faststart') {
        const ix = parseSampleIndex(buf.subarray(layout.moovStart, layout.moovEnd), layout.moovStart);
        if (ix && key) {
          memo.set(key, ix);
          totals.set(key, responseTotal(res, buf.length));
        }
        return ix;
      }
      if (layout.kind !== 'need-more') return null;
      if (layout.bytesNeeded > MAX_MOOV_BYTES) return null;
      if (res.status === 200) return null; // full body and still incomplete: truncated file
      want = Math.max(layout.bytesNeeded, buf.length + 1);
    }
    return null;
  } catch {
    return null;
  }
}

/** Prefetches the bytes needed to show the frame at `t` plus a short run-up, skipping what is cached. */
export async function prefetchWindow(
  url: string,
  ix: SampleIndex,
  t: number,
  cached: ByteRange[],
  signal: AbortSignal,
  aheadSec: number = PREVIEW_AHEAD_SEC,
): Promise<void> {
  const gaps = subtract([windowBytes(ix, t, aheadSec)], cached);
  for (const g of gaps) {
    if (signal.aborted) return;
    await prefetchRange(url, g, signal);
  }
}
