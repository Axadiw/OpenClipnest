/**
 * Minimal mp4 sample-table reader for the scrub-preview prefetcher: tells which byte
 * ranges of a faststart file hold the samples for a time window, and maps cached byte
 * ranges back to playable time. Pure functions over Uint8Array, no I/O.
 */
import { union, type ByteRange } from '../byteRanges';

export const MAX_MOOV_BYTES = 8 * 1024 * 1024;

export type Mp4Layout =
  | { kind: 'faststart'; moovStart: number; moovEnd: number }
  | { kind: 'fragmented' | 'unsupported' }
  | { kind: 'need-more'; bytesNeeded: number };

export type ByteRangeTimeline = { dts: Float64Array; start: Float64Array; end: Float64Array };

export interface SampleIndex {
  duration: number;
  pts: Float64Array;
  offset: Float64Array;
  size: Uint32Array;
  /** Sample indices of the video track's keyframes. */
  keyframes: Uint32Array;
  /** Every track's samples, sorted by byte offset (seconds, bytes). */
  trackSpans: ByteRangeTimeline;
}

// ---------------------------------------------------------------- box walking

interface Box {
  type: string;
  start: number;
  /** First byte after the box header. */
  body: number;
  end: number;
}

class ParseError extends Error {}

function fourcc(d: Uint8Array, p: number): string {
  return String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
}

/** Reads one box header at `pos`; `null` when the header itself does not fit before `limit`. */
function readHeader(d: Uint8Array, v: DataView, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  let size = v.getUint32(pos);
  const type = fourcc(d, pos + 4);
  let body = pos + 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = v.getUint32(pos + 8) * 4294967296 + v.getUint32(pos + 12);
    body = pos + 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < body - pos) throw new ParseError('bad box size');
  return { type, start: pos, body, end: pos + size };
}

function children(d: Uint8Array, v: DataView, box: Box): Box[] {
  if (box.end > d.length) throw new ParseError('truncated box');
  const out: Box[] = [];
  let pos = box.body;
  while (pos < box.end) {
    const b = readHeader(d, v, pos, box.end);
    if (!b || b.end > box.end) throw new ParseError('truncated child');
    out.push(b);
    pos = b.end;
  }
  return out;
}

function child(d: Uint8Array, v: DataView, box: Box, type: string): Box | undefined {
  return children(d, v, box).find((b) => b.type === type);
}

// ---------------------------------------------------------------- layout probe

export function probeLayout(head: Uint8Array): Mp4Layout {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 0;
  let sawFtyp = false;
  try {
    for (;;) {
      const b = readHeader(head, v, pos, head.length);
      if (!b) return { kind: 'need-more', bytesNeeded: pos + 16 };
      if (b.type === 'moof') return { kind: 'fragmented' };
      if (b.type === 'mdat') return { kind: 'unsupported' };
      if (b.type === 'moov') {
        if (!sawFtyp) return { kind: 'unsupported' };
        if (b.end - b.start > MAX_MOOV_BYTES) return { kind: 'unsupported' };
        if (b.end > head.length) return { kind: 'need-more', bytesNeeded: b.end };
        return child(head, v, b, 'mvex')
          ? { kind: 'fragmented' }
          : { kind: 'faststart', moovStart: b.start, moovEnd: b.end };
      }
      if (b.type === 'ftyp') sawFtyp = true;
      if (b.end <= pos) return { kind: 'unsupported' };
      pos = b.end;
      if (pos >= head.length) return { kind: 'need-more', bytesNeeded: pos + 16 };
    }
  } catch {
    return { kind: 'unsupported' };
  }
}

// ---------------------------------------------------------------- track parsing

interface Track {
  isVideo: boolean;
  /** Seconds, after the edit-list shift. */
  dts: Float64Array;
  pts: Float64Array;
  offset: Float64Array;
  size: Uint32Array;
  keyframes: Uint32Array;
  /** Duration of the last sample, seconds. */
  lastDelta: number;
}

/** Throws unless `count` entries of `entrySize` bytes fit in the box body after `at`. */
function need(v: DataView, box: Box, at: number, count: number, entrySize: number): void {
  if (!Number.isFinite(count) || at + count * entrySize > box.end || box.end > v.byteLength) {
    throw new ParseError('table overruns box');
  }
}

function parseTrack(d: Uint8Array, v: DataView, trak: Box): Track | null {
  const mdia = child(d, v, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = child(d, v, mdia, 'hdlr');
  const mdhd = child(d, v, mdia, 'mdhd');
  const minf = child(d, v, mdia, 'minf');
  const stbl = minf && child(d, v, minf, 'stbl');
  if (!hdlr || !mdhd || !stbl) throw new ParseError('missing box');
  const isVideo = fourcc(d, hdlr.body + 8) === 'vide';

  const mdhdVer = d[mdhd.body];
  const timescale = v.getUint32(mdhd.body + (mdhdVer === 1 ? 20 : 12));
  if (timescale === 0) throw new ParseError('timescale 0');

  const sb = new Map(children(d, v, stbl).map((b) => [b.type, b]));
  const stts = sb.get('stts');
  const stsc = sb.get('stsc');
  const stsz = sb.get('stsz');
  const stco = sb.get('stco') ?? sb.get('co64');
  if (!stts || !stsc || !stsz || !stco) throw new ParseError('missing table');

  // sample sizes
  const uniform = v.getUint32(stsz.body + 4);
  const n = v.getUint32(stsz.body + 8);
  const size = new Uint32Array(n);
  if (uniform === 0) {
    need(v, stsz, stsz.body + 12, n, 4);
    for (let i = 0; i < n; i++) size[i] = v.getUint32(stsz.body + 12 + i * 4);
  } else {
    size.fill(uniform);
  }

  // decode times
  const sttsCount = v.getUint32(stts.body + 4);
  need(v, stts, stts.body + 8, sttsCount, 8);
  const dtsTicks = new Float64Array(n);
  let t = 0;
  let idx = 0;
  let lastDeltaTicks = 0;
  for (let e = 0; e < sttsCount; e++) {
    const cnt = v.getUint32(stts.body + 8 + e * 8);
    const delta = v.getUint32(stts.body + 12 + e * 8);
    if (idx + cnt > n) throw new ParseError('stts overruns stsz');
    for (let k = 0; k < cnt; k++) {
      dtsTicks[idx++] = t;
      t += delta;
    }
    if (cnt > 0) lastDeltaTicks = delta;
  }
  if (idx !== n) throw new ParseError('stts/stsz mismatch');

  // composition offsets
  const ctsTicks = new Float64Array(dtsTicks);
  const ctts = sb.get('ctts');
  if (ctts) {
    const c = v.getUint32(ctts.body + 4);
    need(v, ctts, ctts.body + 8, c, 8);
    let i = 0;
    for (let e = 0; e < c; e++) {
      const cnt = v.getUint32(ctts.body + 8 + e * 8);
      const off = v.getInt32(ctts.body + 12 + e * 8);
      if (i + cnt > n) throw new ParseError('ctts overruns');
      for (let k = 0; k < cnt; k++) ctsTicks[i++] += off;
    }
  }

  // edit list: first non-empty edit's media_time
  let mediaTime = 0;
  const edts = child(d, v, trak, 'edts');
  const elst = edts && child(d, v, edts, 'elst');
  if (elst) {
    const ver = d[elst.body];
    const c = v.getUint32(elst.body + 4);
    const esz = ver === 1 ? 20 : 12;
    need(v, elst, elst.body + 8, c, esz);
    for (let e = 0; e < c; e++) {
      const p = elst.body + 8 + e * esz;
      const mt = ver === 1 ? v.getInt32(p + 8) * 4294967296 + v.getUint32(p + 12) : v.getInt32(p + 4);
      if (mt >= 0) {
        mediaTime = mt;
        break;
      }
    }
  }

  // chunk offsets + sample-to-chunk
  const is64 = stco.type === 'co64';
  const chunks = v.getUint32(stco.body + 4);
  need(v, stco, stco.body + 8, chunks, is64 ? 8 : 4);
  const stscCount = v.getUint32(stsc.body + 4);
  need(v, stsc, stsc.body + 8, stscCount, 12);
  const offset = new Float64Array(n);
  let s = 0;
  for (let e = 0; e < stscCount; e++) {
    const first = v.getUint32(stsc.body + 8 + e * 12);
    const per = v.getUint32(stsc.body + 12 + e * 12);
    const next = e + 1 < stscCount ? v.getUint32(stsc.body + 8 + (e + 1) * 12) : chunks + 1;
    if (first < 1 || next < first || next > chunks + 1) throw new ParseError('bad stsc');
    for (let ch = first; ch < next; ch++) {
      let pos = is64
        ? v.getUint32(stco.body + 8 + (ch - 1) * 8) * 4294967296 + v.getUint32(stco.body + 12 + (ch - 1) * 8)
        : v.getUint32(stco.body + 8 + (ch - 1) * 4);
      for (let k = 0; k < per; k++) {
        if (s >= n) throw new ParseError('stsc overruns stsz');
        offset[s] = pos;
        pos += size[s];
        s++;
      }
    }
  }
  if (s !== n) throw new ParseError('stsc/stsz mismatch');

  // sync samples
  let keyframes: Uint32Array;
  const stss = sb.get('stss');
  if (stss) {
    const c = v.getUint32(stss.body + 4);
    need(v, stss, stss.body + 8, c, 4);
    keyframes = new Uint32Array(c);
    for (let i = 0; i < c; i++) {
      const k = v.getUint32(stss.body + 8 + i * 4) - 1;
      if (k < 0 || k >= n) throw new ParseError('bad stss');
      keyframes[i] = k;
    }
  } else {
    keyframes = new Uint32Array(n);
    for (let i = 0; i < n; i++) keyframes[i] = i;
  }

  const dts = new Float64Array(n);
  const pts = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dts[i] = (dtsTicks[i] - mediaTime) / timescale;
    pts[i] = (ctsTicks[i] - mediaTime) / timescale;
  }
  return { isVideo, dts, pts, offset, size, keyframes, lastDelta: lastDeltaTicks / timescale };
}

/**
 * Builds the index from a complete `moov` box (header included). Uses the first video
 * track for pts/offset/size/keyframes; `trackSpans` covers every track. Returns null for
 * anything malformed. `moovFileOffset` is where `moov` starts in the file: a sample that
 * claims to live inside the moov itself marks a corrupt table.
 */
export function parseSampleIndex(moov: Uint8Array, moovFileOffset: number): SampleIndex | null {
  try {
    const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    const root = readHeader(moov, v, 0, moov.length);
    if (!root || root.type !== 'moov' || root.end > moov.length) return null;
    const tracks: Track[] = [];
    for (const b of children(moov, v, root)) {
      if (b.type !== 'trak') continue;
      const t = parseTrack(moov, v, b);
      if (t) tracks.push(t);
    }
    const video = tracks.find((t) => t.isVideo);
    if (!video || video.pts.length === 0) return null;

    const moovEnd = moovFileOffset + moov.length;
    let total = 0;
    for (const t of tracks) {
      total += t.offset.length;
      for (let i = 0; i < t.offset.length; i++) {
        const o = t.offset[i];
        if (o < moovEnd && o + t.size[i] > moovFileOffset) return null;
      }
    }

    // all tracks, sorted by byte offset
    const order = new Uint32Array(total);
    const trackOf = new Uint8Array(total);
    const sampleOf = new Uint32Array(total);
    let k = 0;
    tracks.forEach((t, ti) => {
      for (let i = 0; i < t.offset.length; i++, k++) {
        trackOf[k] = ti;
        sampleOf[k] = i;
        order[k] = k;
      }
    });
    const offs = (j: number) => tracks[trackOf[j]].offset[sampleOf[j]];
    const sorted = Array.from(order).sort((a, b) => offs(a) - offs(b));
    const spans: ByteRangeTimeline = {
      dts: new Float64Array(total),
      start: new Float64Array(total),
      end: new Float64Array(total),
    };
    sorted.forEach((j, r) => {
      const t = tracks[trackOf[j]];
      const i = sampleOf[j];
      spans.dts[r] = t.dts[i];
      spans.start[r] = t.offset[i];
      spans.end[r] = t.offset[i] + t.size[i];
    });

    let duration = 0;
    for (let i = 0; i < video.pts.length; i++) {
      const next = i + 1 < video.pts.length ? video.pts[i + 1] - video.pts[i] : video.lastDelta;
      duration = Math.max(duration, video.pts[i] + (next > 0 ? next : video.lastDelta));
    }
    return {
      duration,
      pts: video.pts,
      offset: video.offset,
      size: video.size,
      keyframes: video.keyframes,
      trackSpans: spans,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- queries

const EPS = 1e-9;

/** Sample index of the last keyframe with pts <= t (0 when t precedes the first). */
export function keyframeAtOrBefore(ix: SampleIndex, t: number): number {
  const kf = ix.keyframes;
  if (kf.length === 0) return 0;
  let lo = 0;
  let hi = kf.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ix.pts[kf[mid]] <= t + EPS) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans < 0 ? 0 : kf[ans];
}

/** Bytes to fetch to play from the keyframe at/before `t` up to `t + aheadSec`, all tracks. */
export function windowBytes(ix: SampleIndex, t: number, aheadSec: number): ByteRange {
  const k = keyframeAtOrBefore(ix, t);
  const lo = ix.pts[k] - EPS;
  const hi = Math.min(t + aheadSec, ix.duration) + EPS;
  const { dts, start, end } = ix.trackSpans;
  let s = ix.offset[k];
  let e = ix.offset[k] + ix.size[k];
  for (let i = 0; i < dts.length; i++) {
    if (dts[i] >= lo && dts[i] <= hi) {
      if (start[i] < s) s = start[i];
      if (end[i] > e) e = end[i];
    }
  }
  return { start: s, end: e };
}

/** Maximal runs of consecutive video samples whose bytes are fully cached, in seconds. */
export function timeSegmentsForBytes(
  ix: SampleIndex,
  cached: readonly ByteRange[],
): { start: number; end: number }[] {
  const set = union(cached, []);
  const out: { start: number; end: number }[] = [];
  if (set.length === 0) return out;
  const n = ix.pts.length;
  const isCovered = (a: number, b: number): boolean => {
    let lo = 0;
    let hi = set.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (set[mid].end <= a) lo = mid + 1;
      else if (set[mid].start > a) hi = mid - 1;
      else return set[mid].end >= b;
    }
    return false;
  };
  const dur = (i: number) => {
    const d = i + 1 < n ? ix.pts[i + 1] - ix.pts[i] : ix.duration - ix.pts[i];
    return d > 0 ? d : 0;
  };
  let first = -1;
  for (let i = 0; i <= n; i++) {
    const ok = i < n && isCovered(ix.offset[i], ix.offset[i] + ix.size[i]);
    if (ok && first < 0) first = i;
    if (!ok && first >= 0) {
      const last = i - 1;
      out.push({ start: ix.pts[first], end: ix.pts[last] + dur(last) });
      first = -1;
    }
  }
  return out;
}
