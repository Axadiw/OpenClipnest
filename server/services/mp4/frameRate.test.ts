import { describe, it, expect } from 'vitest';
import { frameRateFromTrex, frameRateFromStts, frameRateFromSampleCounts } from './frameRate.js';

// Helper to build a minimal MP4 box: [size(4)] [type(4)] [payload]
function box(type: string, payload: Buffer): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(payload.length + 8, 0);
  b.write(type, 4, 'ascii');
  return Buffer.concat([b, payload]);
}

describe('frameRateFromTrex', () => {
  it('derives fps from default_sample_duration', () => {
    // trex: version/flags(4) trackId(4) descIdx(4) defDur(4) defSize(4) defFlags(4)
    const p = Buffer.alloc(24);
    p.writeUInt32BE(1, 4);     // track_id = 1
    p.writeUInt32BE(3000, 12); // default_sample_duration
    const moov = box('moov', box('mvex', box('trex', p)));
    expect(frameRateFromTrex(moov, 1, 90000)).toBeCloseTo(30, 3); // 90000/3000
  });

  it('returns null when default duration is 0', () => {
    const p = Buffer.alloc(24); p.writeUInt32BE(1, 4);
    // defDur stays 0 (default)
    const moov = box('moov', box('mvex', box('trex', p)));
    expect(frameRateFromTrex(moov, 1, 90000)).toBeNull();
  });

  it('returns null when trackId does not match', () => {
    const p = Buffer.alloc(24);
    p.writeUInt32BE(2, 4);     // track_id = 2
    p.writeUInt32BE(3000, 12); // default_sample_duration
    const moov = box('moov', box('mvex', box('trex', p)));
    expect(frameRateFromTrex(moov, 1, 90000)).toBeNull();
  });

  it('picks the right trex when multiple are present', () => {
    const p1 = Buffer.alloc(24);
    p1.writeUInt32BE(1, 4);
    p1.writeUInt32BE(16000, 12); // audio track – 16000/16000 = 1 fps (nonsense but testable)
    const p2 = Buffer.alloc(24);
    p2.writeUInt32BE(2, 4);
    p2.writeUInt32BE(3000, 12); // video track – 90000/3000 = 30 fps
    const mvexPayload = Buffer.concat([box('trex', p1), box('trex', p2)]);
    const moov = box('moov', box('mvex', mvexPayload));
    expect(frameRateFromTrex(moov, 2, 90000)).toBeCloseTo(30, 3);
  });

  it('clamps fps > 240 to null', () => {
    const p = Buffer.alloc(24);
    p.writeUInt32BE(1, 4);
    p.writeUInt32BE(1, 12); // defDur=1 → 90000/1 = 90000 fps
    const moov = box('moov', box('mvex', box('trex', p)));
    expect(frameRateFromTrex(moov, 1, 90000)).toBeNull();
  });
});

describe('frameRateFromStts', () => {
  it('uses the dominant delta (>=90% of samples)', () => {
    // stts payload: version/flags(4) count(4) then [sampleCount(4), delta(4)] pairs
    const p = Buffer.alloc(4 + 4 + 16);
    p.writeUInt32BE(2, 4);
    p.writeUInt32BE(500, 8);  p.writeUInt32BE(3600, 12); // 500 samples @ 3600 ticks = 25fps at 90000
    p.writeUInt32BE(1, 16);   p.writeUInt32BE(7200, 20); // 1 trailing long sample
    expect(frameRateFromStts(box('stts', p), 90000)).toBeCloseTo(25, 3);
  });

  it('returns null with no dominant delta (VFR)', () => {
    const p = Buffer.alloc(4 + 4 + 16);
    p.writeUInt32BE(2, 4);
    p.writeUInt32BE(100, 8); p.writeUInt32BE(3000, 12);
    p.writeUInt32BE(100, 16); p.writeUInt32BE(6000, 20);
    expect(frameRateFromStts(box('stts', p), 90000)).toBeNull();
  });

  it('returns null when stts has no entries', () => {
    const p = Buffer.alloc(8);
    p.writeUInt32BE(0, 4); // entry_count = 0
    expect(frameRateFromStts(box('stts', p), 90000)).toBeNull();
  });

  it('returns null when dominant delta is 0', () => {
    const p = Buffer.alloc(4 + 4 + 8);
    p.writeUInt32BE(1, 4);
    p.writeUInt32BE(100, 8); p.writeUInt32BE(0, 12); // delta=0
    expect(frameRateFromStts(box('stts', p), 90000)).toBeNull();
  });

  it('returns null when fps > 240', () => {
    const p = Buffer.alloc(4 + 4 + 8);
    p.writeUInt32BE(1, 4);
    p.writeUInt32BE(100, 8); p.writeUInt32BE(1, 12); // delta=1 → 90000 fps
    expect(frameRateFromStts(box('stts', p), 90000)).toBeNull();
  });

  it('handles a single-entry stts (all samples same delta)', () => {
    const p = Buffer.alloc(4 + 4 + 8);
    p.writeUInt32BE(1, 4);
    p.writeUInt32BE(1000, 8); p.writeUInt32BE(3600, 12); // 1000 samples @ 3600 → 25fps
    expect(frameRateFromStts(box('stts', p), 90000)).toBeCloseTo(25, 3);
  });
});

describe('frameRateFromSampleCounts', () => {
  it('returns the true average fps (samples / seconds)', () => {
    // 430 video samples over 30.0 s ≈ 14.33 fps (the real VFR case; trex would say ~150)
    expect(frameRateFromSampleCounts(430, 30)).toBeCloseTo(430 / 30, 5);
  });
  it('returns null for zero samples or non-positive duration', () => {
    expect(frameRateFromSampleCounts(0, 30)).toBeNull();
    expect(frameRateFromSampleCounts(430, 0)).toBeNull();
    expect(frameRateFromSampleCounts(430, -1)).toBeNull();
  });
  it('returns null when the computed fps exceeds the parser-artefact cap (240)', () => {
    expect(frameRateFromSampleCounts(3000, 1)).toBeNull(); // 3000 fps → artefact
  });
});
