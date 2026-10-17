import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { patchAudioStts, readHdlrType, fixAudioSampleDurations, fixVideoSampleDurations, AAC_FRAME_SAMPLES } from './audioStts.js';
import { readBoxHeader, findChildBox, readFlags } from './boxes.js';
import { box, fullBox, makeMvhd, makeTkhd, makeFtyp } from './__test-fixtures.js';

// ---------------------------------------------------------------------------
// Mini-builders for stts and hdlr used in these tests
// ---------------------------------------------------------------------------

/**
 * Build an stts full-box with the given entries.
 * Each entry: { sampleCount, sampleDelta }
 */
function makeStts(entries: Array<{ sampleCount: number; sampleDelta: number }>): Buffer {
  const payload = Buffer.alloc(4 + entries.length * 8);
  payload.writeUInt32BE(entries.length, 0);
  let p = 4;
  for (const e of entries) {
    payload.writeUInt32BE(e.sampleCount, p);
    payload.writeUInt32BE(e.sampleDelta, p + 4);
    p += 8;
  }
  return fullBox('stts', 0, 0, payload);
}

/**
 * Build a minimal stbl with just an stts inside.
 */
function makeStblWithStts(stts: Buffer): Buffer {
  return box('stbl', stts);
}

/**
 * Build a minimal minf containing vmhd + dinf + stbl.
 */
function makeMinf(vmhd: Buffer, stbl: Buffer): Buffer {
  // dinf with a minimal dref
  const drefPayload = Buffer.alloc(4 + 12); // entry_count=1 + one url box
  drefPayload.writeUInt32BE(1, 0);
  const urlPayload = Buffer.alloc(0);
  const urlBox = fullBox('url ', 0, 0x000001, urlPayload); // self-contained
  const dref = fullBox('dref', 0, 0, Buffer.concat([drefPayload.slice(0, 4), urlBox]));
  const dinf = box('dinf', dref);
  return box('minf', Buffer.concat([vmhd, dinf, stbl]));
}

/**
 * Build a hdlr box with the given handler type (e.g. 'soun', 'vide').
 */
function makeHdlr(handlerType: string): Buffer {
  // full-box payload: pre_defined(4) handler_type(4) reserved(12) name(variable)
  const payload = Buffer.alloc(4 + 4 + 12);
  payload.write('    ', 0, 'ascii'); // pre_defined = 0
  payload.write(handlerType.slice(0, 4).padEnd(4, ' '), 4, 'ascii');
  return fullBox('hdlr', 0, 0, payload);
}

/**
 * Build a well-formed mdhd v0 with a specific duration.
 */
function makeMdhdWithDuration(timescale: number, durationTicks: number): Buffer {
  // version=0: creation(4) modification(4) timescale(4) duration(4) + lang(2) + pre(2) = 20
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(durationTicks, 12);
  return fullBox('mdhd', 0, 0, payload);
}

/**
 * Build a complete trak box for a given handler type with the given stts entries.
 */
function makeTrak(opts: {
  trackId: number;
  handlerType: 'soun' | 'vide';
  mdhdTimescale: number;
  mdhdDurationTicks: number;
  sttsEntries: Array<{ sampleCount: number; sampleDelta: number }>;
}): Buffer {
  const tkhd = makeTkhd(opts.trackId);
  const mdhd = makeMdhdWithDuration(opts.mdhdTimescale, opts.mdhdDurationTicks);
  const hdlr = makeHdlr(opts.handlerType);
  const stts = makeStts(opts.sttsEntries);
  const stbl = makeStblWithStts(stts);
  const smhd = fullBox('smhd', 0, 0, Buffer.alloc(4));
  const vmhd = fullBox('vmhd', 0, 0, Buffer.alloc(8));
  const mediaHeader = opts.handlerType === 'soun' ? smhd : vmhd;
  const minf = makeMinf(mediaHeader, stbl);
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  return box('trak', Buffer.concat([tkhd, mdia]));
}

/**
 * Build a moov buffer containing the given trak boxes.
 */
function makeMoovFromTraks(traks: Buffer[]): Buffer {
  const mvhd = makeMvhd(1000, 0);
  return box('moov', Buffer.concat([mvhd, ...traks]));
}

/**
 * Read mdhd.duration from a moov buffer for a given trak (by index).
 */
function readMdhdDuration(moovBuf: Buffer, trakIndex: number): number {
  const moovHdr = readBoxHeader(moovBuf, 0)!;
  const moovDataStart = moovHdr.headerSize;
  const moovDataEnd = moovHdr.size;
  let p = moovDataStart;
  let trakCount = 0;
  while (p + 8 <= moovDataEnd) {
    const h = readBoxHeader(moovBuf, p)!;
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      if (trakCount === trakIndex) {
        const trakDataStart = p + h.headerSize;
        const trakDataEnd = p + h.size;
        const mdiaBox = findChildBox(moovBuf, trakDataStart, trakDataEnd, 'mdia')!;
        const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
        const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;
        const mdhdBox = findChildBox(moovBuf, mdiaStart, mdiaEnd, 'mdhd')!;
        const p0 = mdhdBox.offset + mdhdBox.header.headerSize;
        const { version } = readFlags(moovBuf, p0);
        let dp = p0 + 4;
        dp += version === 1 ? 16 : 8;
        dp += 4; // timescale
        return version === 1
          ? moovBuf.readUInt32BE(dp) * 0x100000000 + moovBuf.readUInt32BE(dp + 4)
          : moovBuf.readUInt32BE(dp);
      }
      trakCount++;
    }
    p += h.size;
  }
  throw new Error(`readMdhdDuration: trak ${trakIndex} not found`);
}

/**
 * Read the first stts entry's sample_delta for a given trak.
 */
function readFirstSttsDelta(moovBuf: Buffer, trakIndex: number): number {
  const moovHdr = readBoxHeader(moovBuf, 0)!;
  let p = moovHdr.headerSize;
  let trakCount = 0;
  while (p + 8 <= moovHdr.size) {
    const h = readBoxHeader(moovBuf, p)!;
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      if (trakCount === trakIndex) {
        const trakDataStart = p + h.headerSize;
        const trakDataEnd = p + h.size;
        const mdiaBox = findChildBox(moovBuf, trakDataStart, trakDataEnd, 'mdia')!;
        const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
        const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;
        const minfBox = findChildBox(moovBuf, mdiaStart, mdiaEnd, 'minf')!;
        const minfStart = minfBox.offset + minfBox.header.headerSize;
        const minfEnd = minfBox.offset + minfBox.header.size;
        const stblBox = findChildBox(moovBuf, minfStart, minfEnd, 'stbl')!;
        const stblStart = stblBox.offset + stblBox.header.headerSize;
        const stblEnd = stblBox.offset + stblBox.header.size;
        const sttsBox = findChildBox(moovBuf, stblStart, stblEnd, 'stts')!;
        const sttsPayload = sttsBox.offset + sttsBox.header.headerSize;
        // ver+flags(4) entry_count(4) sample_count(4) sample_delta(4)
        return moovBuf.readUInt32BE(sttsPayload + 4 + 4 + 4);
      }
      trakCount++;
    }
    p += h.size;
  }
  throw new Error(`readFirstSttsDelta: trak ${trakIndex} not found`);
}

/**
 * Read the stts entry_count for a given trak.
 */
function readSttsEntryCount(moovBuf: Buffer, trakIndex: number): number {
  const moovHdr = readBoxHeader(moovBuf, 0)!;
  let p = moovHdr.headerSize;
  let trakCount = 0;
  while (p + 8 <= moovHdr.size) {
    const h = readBoxHeader(moovBuf, p)!;
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      if (trakCount === trakIndex) {
        const trakDataStart = p + h.headerSize;
        const trakDataEnd = p + h.size;
        const mdiaBox = findChildBox(moovBuf, trakDataStart, trakDataEnd, 'mdia')!;
        const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
        const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;
        const minfBox = findChildBox(moovBuf, mdiaStart, mdiaEnd, 'minf')!;
        const minfStart = minfBox.offset + minfBox.header.headerSize;
        const minfEnd = minfBox.offset + minfBox.header.size;
        const stblBox = findChildBox(moovBuf, minfStart, minfEnd, 'stbl')!;
        const stblStart = stblBox.offset + stblBox.header.headerSize;
        const stblEnd = stblBox.offset + stblBox.header.size;
        const sttsBox = findChildBox(moovBuf, stblStart, stblEnd, 'stts')!;
        const sttsPayload = sttsBox.offset + sttsBox.header.headerSize;
        // ver+flags(4) entry_count(4)
        return moovBuf.readUInt32BE(sttsPayload + 4);
      }
      trakCount++;
    }
    p += h.size;
  }
  throw new Error(`readSttsEntryCount: trak ${trakIndex} not found`);
}

// ---------------------------------------------------------------------------
// Tests: readHdlrType
// ---------------------------------------------------------------------------

describe('readHdlrType', () => {
  it('returns "soun" for an audio hdlr box', () => {
    const hdlr = makeHdlr('soun');
    expect(readHdlrType(hdlr)).toBe('soun');
  });

  it('returns "vide" for a video hdlr box', () => {
    const hdlr = makeHdlr('vide');
    expect(readHdlrType(hdlr)).toBe('vide');
  });

  it('returns "" for a non-hdlr box', () => {
    const notHdlr = box('stts', Buffer.alloc(0));
    expect(readHdlrType(notHdlr)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: fixAudioSampleDurations
// ---------------------------------------------------------------------------

describe('fixAudioSampleDurations', () => {
  it('returns same reference when not audio', () => {
    const durations = [0, 0, 0];
    const result = fixAudioSampleDurations(durations, false);
    expect(result).toBe(durations); // same reference
  });

  it('returns same reference for audio with all non-zero durations', () => {
    const durations = [1024, 1024, 1024];
    const result = fixAudioSampleDurations(durations, true);
    expect(result).toBe(durations);
  });

  it('returns same reference for audio with mixed zero/non-zero durations', () => {
    const durations = [0, 1024, 0];
    const result = fixAudioSampleDurations(durations, true);
    expect(result).toBe(durations); // mixed — not all zero, so no fix
  });

  it('returns corrected array when audio and all durations are 0', () => {
    const durations = [0, 0, 0, 0];
    const result = fixAudioSampleDurations(durations, true);
    expect(result).not.toBe(durations); // new reference
    expect(result).toEqual([AAC_FRAME_SAMPLES, AAC_FRAME_SAMPLES, AAC_FRAME_SAMPLES, AAC_FRAME_SAMPLES]);
  });

  it('handles empty duration array for audio', () => {
    const result = fixAudioSampleDurations([], true);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: fixVideoSampleDurations (32-bit underflow guard)
// ---------------------------------------------------------------------------

describe('fixVideoSampleDurations', () => {
  it('returns same reference when not video', () => {
    const durations = [0xfffffffe, 10000, 10000];
    expect(fixVideoSampleDurations(durations, false)).toBe(durations);
  });

  it('returns same reference for video with all plausible durations', () => {
    const durations = [10000, 10050, 9950, 10000];
    expect(fixVideoSampleDurations(durations, true)).toBe(durations);
  });

  it('replaces a single 2^32-style underflow with the track median', () => {
    // Real-world shape: 2018 normal frames + one 2^32 - 10350 sample.
    const UNDERFLOW = 0x100000000 - 10350; // 4_294_956_946
    const durations = [3750, 10950, 8400, 10350, UNDERFLOW, 10050, 9990];
    const result = fixVideoSampleDurations(durations, true);
    expect(result).not.toBe(durations);
    // median of the plausible [3750,8400,9990,10050,10350,10950] (sorted) → index 3 = 10050
    const plausible = [3750, 8400, 9990, 10050, 10350, 10950];
    const median = plausible[Math.floor(plausible.length / 2)];
    expect(result[4]).toBe(median);
    // every other sample is untouched
    expect(result.filter((_, i) => i !== 4)).toEqual([3750, 10950, 8400, 10350, 10050, 9990]);
    // total no longer astronomically inflated
    expect(result.reduce((a, b) => a + b, 0)).toBeLessThan(0x80000000);
  });

  it('replaces multiple underflow samples', () => {
    const durations = [10000, 0xffffffff, 10000, 0x90000000, 10000];
    const result = fixVideoSampleDurations(durations, true);
    expect(result).toEqual([10000, 10000, 10000, 10000, 10000]);
  });

  it('leaves a large-but-plausible VFR gap (< 2^31) untouched', () => {
    const durations = [10000, 1_500_000, 10000]; // 10s gap @ 150kHz — legit
    expect(fixVideoSampleDurations(durations, true)).toBe(durations);
  });

  it('handles empty array for video', () => {
    expect(fixVideoSampleDurations([], true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: patchAudioStts
// ---------------------------------------------------------------------------

describe('patchAudioStts', () => {
  it('patches audio trak with stts sample_delta=0 → delta=1024, updates mdhd.duration', () => {
    const audioTrak = makeTrak({
      trackId: 2,
      handlerType: 'soun',
      mdhdTimescale: 16000,
      mdhdDurationTicks: 0, // broken: should be totalSamples * 1024
      sttsEntries: [{ sampleCount: 100, sampleDelta: 0 }], // Reolink bug
    });
    const moovBuf = makeMoovFromTraks([audioTrak]);

    const patched = patchAudioStts(moovBuf);

    // Must return a new buffer (fix was applied)
    expect(patched).not.toBe(moovBuf);
    // Must be same size (in-place patch, no structural change)
    expect(patched.length).toBe(moovBuf.length);
    // stts entry_count still 1
    expect(readSttsEntryCount(patched, 0)).toBe(1);
    // sample_delta should be 1024
    expect(readFirstSttsDelta(patched, 0)).toBe(AAC_FRAME_SAMPLES);
    // mdhd.duration = 100 samples * 1024 = 102400
    expect(readMdhdDuration(patched, 0)).toBe(100 * AAC_FRAME_SAMPLES);
  });

  it('patches audio trak with multiple stts entries all having delta=0', () => {
    // Multiple stts entries where all deltas are 0
    const audioTrak = makeTrak({
      trackId: 2,
      handlerType: 'soun',
      mdhdTimescale: 16000,
      mdhdDurationTicks: 0,
      sttsEntries: [
        { sampleCount: 50, sampleDelta: 0 },
        { sampleCount: 50, sampleDelta: 0 },
      ],
    });
    const moovBuf = makeMoovFromTraks([audioTrak]);

    const patched = patchAudioStts(moovBuf);

    expect(patched).not.toBe(moovBuf);
    expect(patched.length).toBe(moovBuf.length);
    // After patch: entry_count=1 with totalSamples=100, delta=1024
    expect(readSttsEntryCount(patched, 0)).toBe(1);
    expect(readFirstSttsDelta(patched, 0)).toBe(AAC_FRAME_SAMPLES);
    expect(readMdhdDuration(patched, 0)).toBe(100 * AAC_FRAME_SAMPLES);
  });

  it('does not patch video-only moov — returns same reference', () => {
    const videoTrak = makeTrak({
      trackId: 1,
      handlerType: 'vide',
      mdhdTimescale: 90000,
      mdhdDurationTicks: 0,
      sttsEntries: [{ sampleCount: 300, sampleDelta: 0 }],
    });
    const moovBuf = makeMoovFromTraks([videoTrak]);

    const patched = patchAudioStts(moovBuf);

    // Video track stts=0 is NOT patched by patchAudioStts (audio-only fix)
    expect(patched).toBe(moovBuf);
  });

  it('does not patch audio trak with correct non-zero delta — returns same reference', () => {
    const audioTrak = makeTrak({
      trackId: 2,
      handlerType: 'soun',
      mdhdTimescale: 16000,
      mdhdDurationTicks: 16384,
      sttsEntries: [{ sampleCount: 16, sampleDelta: AAC_FRAME_SAMPLES }],
    });
    const moovBuf = makeMoovFromTraks([audioTrak]);

    const patched = patchAudioStts(moovBuf);

    expect(patched).toBe(moovBuf); // no fix needed
  });

  it('patches audio trak but leaves video trak unchanged in a two-track moov', () => {
    const videoTrak = makeTrak({
      trackId: 1,
      handlerType: 'vide',
      mdhdTimescale: 90000,
      mdhdDurationTicks: 9000,
      sttsEntries: [{ sampleCount: 300, sampleDelta: 300 }],
    });
    const audioTrak = makeTrak({
      trackId: 2,
      handlerType: 'soun',
      mdhdTimescale: 16000,
      mdhdDurationTicks: 0,
      sttsEntries: [{ sampleCount: 100, sampleDelta: 0 }],
    });
    const moovBuf = makeMoovFromTraks([videoTrak, audioTrak]);

    const patched = patchAudioStts(moovBuf);

    expect(patched).not.toBe(moovBuf);
    // Video trak (index 0): delta unchanged (300)
    expect(readFirstSttsDelta(patched, 0)).toBe(300);
    // Audio trak (index 1): delta patched to 1024
    expect(readFirstSttsDelta(patched, 1)).toBe(AAC_FRAME_SAMPLES);
    // Audio mdhd.duration patched
    expect(readMdhdDuration(patched, 1)).toBe(100 * AAC_FRAME_SAMPLES);
    // Video mdhd.duration unchanged
    expect(readMdhdDuration(patched, 0)).toBe(9000);
  });

  it('returns same reference for a buffer not starting with moov', () => {
    const notMoov = makeFtyp();
    const result = patchAudioStts(notMoov);
    expect(result).toBe(notMoov);
  });

  it('original buffer is not mutated (defensive copy)', () => {
    const audioTrak = makeTrak({
      trackId: 2,
      handlerType: 'soun',
      mdhdTimescale: 16000,
      mdhdDurationTicks: 0,
      sttsEntries: [{ sampleCount: 100, sampleDelta: 0 }],
    });
    const moovBuf = makeMoovFromTraks([audioTrak]);
    const originalCopy = Buffer.from(moovBuf);

    const patched = patchAudioStts(moovBuf);

    // patched is a different buffer
    expect(patched).not.toBe(moovBuf);
    // original is unchanged
    expect(moovBuf.equals(originalCopy)).toBe(true);
    // patched differs from original at the stts delta
    expect(patched.equals(originalCopy)).toBe(false);
  });
});
