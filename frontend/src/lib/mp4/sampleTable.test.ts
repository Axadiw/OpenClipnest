// @vitest-environment node
/*
 * Fixtures (frontend/src/lib/mp4/__fixtures__), 64x36 @ 10 fps, 3 s, 30 video samples,
 * keyframe every 5 frames. libx264 was not available on the authoring machine, so the
 * hardware encoder was used; the brief's libx264 command yields the same layout.
 *
 *   COMMON=(-f lavfi -i testsrc=size=64x36:rate=10 -f lavfi -i sine=frequency=440:sample_rate=8000 -t 3
 *           -c:v h264_videotoolbox -g 5 -bf 0 -force_key_frames "expr:gte(t,n_forced*0.5)"
 *           -pix_fmt yuv420p -c:a aac -b:a 16k)
 *   ffmpeg -y "${COMMON[@]}" -movflags +faststart faststart-3s.mp4
 *   ffmpeg -y "${COMMON[@]}" -movflags frag_keyframe+empty_moov+default_base_moof fragmented-3s.mp4
 *   ffmpeg -y "${COMMON[@]}" moov-at-end-3s.mp4
 */
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { covers, union } from '../byteRanges';
import { keyframeAtOrBefore, parseSampleIndex, probeLayout, timeSegmentsForBytes, windowBytes } from './sampleTable';

const load = (n: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url)));
const fast = load('faststart-3s.mp4');
const frag = load('fragmented-3s.mp4');
const atEnd = load('moov-at-end-3s.mp4');

const layout = probeLayout(fast);
if (layout.kind !== 'faststart') throw new Error('fixture is not faststart');
const moovStart = layout.moovStart;
const moovBytes = fast.subarray(layout.moovStart, layout.moovEnd);
const ix = parseSampleIndex(moovBytes, moovStart)!;

describe('probeLayout', () => {
  it('probes layouts', () => {
    expect(probeLayout(fast).kind).toBe('faststart');
    expect(probeLayout(frag).kind).toBe('fragmented');
    expect(probeLayout(atEnd).kind).toBe('unsupported');
    const l = probeLayout(fast.subarray(0, 64));
    expect(l).toEqual({ kind: 'need-more', bytesNeeded: layout.moovEnd });
  });
  it('asks for more when even the box header is cut', () => {
    expect(probeLayout(fast.subarray(0, 4)).kind).toBe('need-more');
  });
});

describe('sample index', () => {
  it('indexes the video track', () => {
    expect(ix).not.toBeNull();
    expect(ix.pts.length).toBe(30);
    expect(Array.from(ix.keyframes)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(ix.duration).toBeCloseTo(3, 1);
    for (let i = 1; i < ix.pts.length; i++) expect(ix.pts[i]).toBeGreaterThan(ix.pts[i - 1]);
    for (let i = 0; i < ix.offset.length; i++) {
      expect(ix.offset[i]).toBeGreaterThan(layout.kind === 'faststart' ? layout.moovEnd : 0);
      expect(ix.offset[i] + ix.size[i]).toBeLessThanOrEqual(fast.length);
    }
    expect(ix.trackSpans.start.length).toBeGreaterThan(30); // audio included
  });
  it('finds the keyframe at or before t', () => {
    expect(ix.pts[keyframeAtOrBefore(ix, 1.25)]).toBeCloseTo(1.0, 3);
    expect(ix.pts[keyframeAtOrBefore(ix, 1.0)]).toBeCloseTo(1.0, 3);
    expect(keyframeAtOrBefore(ix, -1)).toBe(0);
    expect(keyframeAtOrBefore(ix, 99)).toBe(25);
  });
  it('window covers keyframe..t+ahead for every track', () => {
    const w = windowBytes(ix, 1.25, 0.5);
    for (let i = 10; i <= 17; i++) expect(covers([w], { start: ix.offset[i], end: ix.offset[i] + ix.size[i] })).toBe(true);
    expect(covers([w], { start: ix.offset[25], end: ix.offset[25] + ix.size[25] })).toBe(false);
  });
  it('window clamps at clip end', () => {
    const w = windowBytes(ix, 99, 5);
    expect(w.start).toBe(ix.offset[25]);
    expect(w.end).toBeGreaterThan(w.start);
    expect(w.end).toBeLessThanOrEqual(fast.length);
  });
  it('maps cached bytes back to time segments', () => {
    const a = windowBytes(ix, 0, 0.9), b = windowBytes(ix, 2.0, 0.9);
    const segs = timeSegmentsForBytes(ix, union([a], [b]));
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBeCloseTo(0, 3);
    expect(segs[1].start).toBeCloseTo(2.0, 3);
    expect(timeSegmentsForBytes(ix, [])).toEqual([]);
  });
  it('returns null on a truncated moov', () => {
    expect(parseSampleIndex(moovBytes.subarray(0, 200), moovStart)).toBeNull();
  });
  it('skips an empty version-1 edit and shifts by the next edit media_time', () => {
    // Replace the video track's v0 elst (28 bytes at moov+224) with a v1 elst:
    // [empty edit (media_time -1), edit with media_time 1024].
    const elstAt = 256 - moovStart; // trak 148 > edts 248 > elst 256, file offsets
    expect(String.fromCharCode(...moovBytes.subarray(elstAt + 4, elstAt + 8))).toBe('elst');
    const entry = (mtHi: number, mtLo: number) => {
      const b = new DataView(new ArrayBuffer(20));
      b.setUint32(8, mtHi); // segment_duration (0..8), then media_time
      b.setUint32(12, mtLo);
      return new Uint8Array(b.buffer);
    };
    const body = new Uint8Array(8 + 40);
    new DataView(body.buffer).setUint32(0, 0x01000000); // version 1
    new DataView(body.buffer).setUint32(4, 2);
    body.set(entry(0xffffffff, 0xffffffff), 8); // media_time = -1
    body.set(entry(0, 1024), 28);
    const elst = new Uint8Array(8 + body.length);
    new DataView(elst.buffer).setUint32(0, elst.length);
    elst.set([0x65, 0x6c, 0x73, 0x74], 4);
    elst.set(body, 8);
    const grow = elst.length - 28;
    const out = new Uint8Array(moovBytes.length + grow);
    out.set(moovBytes.subarray(0, elstAt), 0);
    out.set(elst, elstAt);
    out.set(moovBytes.subarray(elstAt + 28), elstAt + elst.length);
    const dv = new DataView(out.buffer);
    for (const at of [0, 148 - moovStart, 248 - moovStart]) dv.setUint32(at, dv.getUint32(at) + grow);
    const shifted = parseSampleIndex(out, moovStart - grow)!; // keep moov end where mdat expects it
    expect(shifted).not.toBeNull();
    // video mdhd timescale
    const mdhdAt = moovBytes.findIndex((_, i) => i > 148 - moovStart && String.fromCharCode(...moovBytes.subarray(i, i + 4)) === 'mdhd');
    const timescale = new DataView(moovBytes.buffer, moovBytes.byteOffset).getUint32(mdhdAt + 4 + 12);
    for (const i of [0, 7, 29]) expect(shifted.pts[i]).toBeCloseTo(ix.pts[i] - 1024 / timescale, 9);
  });
});
