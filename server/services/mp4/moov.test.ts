import { describe, it, expect } from 'vitest';
import { inspectMoov, inspectFileDetailed } from './moov.js';
import { makeMoov, makeFtyp } from './__test-fixtures.js';
import { Buffer } from 'buffer';
import { story } from '../../testing/story.js';

describe('inspectMoov', () => {
  it('reads timescales and primary track', () => {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 90000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }, { id: 2, mdhdTimescale: 48000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3003 }],
    });
    const buf = Buffer.concat([ftyp, moov]);
    const { ftypSize, moov: m } = inspectMoov(buf);
    expect(ftypSize).toBe(ftyp.length);
    expect(m.primaryTrackId).toBe(1);
    expect(m.primaryTrackTimescale).toBe(90000);
    expect(m.trackTimescales.get(2)).toBe(48000);
    expect(m.hasMvex).toBe(true);
    expect(m.hasMehd).toBe(false);
    expect(m.trexDefaults.get(1)?.defaultSampleDuration).toBe(3003);
  });
});

describe('inspectFileDetailed', () => {
  it('returns ftyp + moov snapshot with no warnings on a well-formed buffer', (ctx) => {
    story(ctx, 'Tolerant inspector daje pełny snapshot dla diagnostyki admina — to czego mp4inspect.ts wcześniej dorabiał na własną rękę.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 90000,
      mvhdDuration: 180000,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
    });
    const buf = Buffer.concat([ftyp, moov]);
    const snap = inspectFileDetailed(buf);
    expect(snap.ftyp?.majorBrand).toBe('isom');
    expect(snap.moov?.mvhd?.type).toBe('mvhd');
    expect(snap.moov?.mvhd?.timescale).toBe(90000);
    expect(snap.moov?.mvhd?.durationTicks).toBe(180000);
    expect(snap.moov?.mvhd?.durationSeconds).toBe(2);
    expect(snap.moov?.traks).toHaveLength(1);
    expect(snap.moov?.traks[0].tkhd?.type).toBe('tkhd');
    expect(snap.moov?.traks[0].tkhd?.trackId).toBe(1);
    expect(snap.warnings).toEqual([]);
  });

  it('emits "no ftyp at offset 0" warning when buffer starts with non-ftyp data', () => {
    // 8 bytes resembling a box header with type 'skip' (a valid free-space box type),
    // size 8 (just the header). Note: this is NOT ftyp.
    const skipBox = Buffer.alloc(8);
    skipBox.writeUInt32BE(8, 0);
    skipBox.write('skip', 4, 'ascii');
    const snap = inspectFileDetailed(skipBox);
    expect(snap.warnings).toContain('no ftyp at offset 0');
    expect(snap.ftyp).toBeNull();
  });

  it('emits "no moov found" warning and returns moov=null for moov-at-end layout', () => {
    const buf = makeFtyp();
    const snap = inspectFileDetailed(buf);
    expect(snap.warnings).toContain('no moov found in inspect buffer (probably moov-at-end → class C)');
    expect(snap.moov).toBeNull();
  });

  it('emits truncation warning when declared moov size exceeds buffer', () => {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 90000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
    });
    const full = Buffer.concat([ftyp, moov]);
    // Cut 100 bytes off the end while keeping the moov's declared size intact.
    const truncated = full.subarray(0, full.length - 100);
    const snap = inspectFileDetailed(truncated);
    expect(snap.warnings.some(w =>
      w.startsWith('moov extends past inspect buffer') &&
      w.includes(`size=${moov.length}`)
    )).toBe(true);
    // Tolerant path: moov is still parsed (partial data ok).
    expect(snap.moov).not.toBeNull();
  });
});
