import { describe, it, expect } from 'vitest';
import {
  cleanFrameLayout,
  cleanFrameMaxSrcEnd,
  payloadRangeToOriginalRanges,
  coalesceOriginalRanges,
  createGapSkipTransform,
} from './cleanFrameServe.js';

// Three runs with payload offsets:
//   run 0: srcOffset=1000, length=10 → payload [0, 9]
//   run 1: srcOffset=2000, length=10 → payload [10, 19]
//   run 2: srcOffset=5000, length=10 → payload [20, 29]
const THREE_RUNS = [
  { srcOffset: 1000, length: 10 },
  { srcOffset: 2000, length: 10 },
  { srcOffset: 5000, length: 10 },
];

describe('cleanFrameLayout', () => {
  it('sums prelude + mdatHeader + all run lengths', () => {
    const layout = cleanFrameLayout(100, 8, THREE_RUNS);
    expect(layout.preludeLen).toBe(100);
    expect(layout.mdatHeaderLen).toBe(8);
    // 30 bytes of payload total
    expect(layout.servedSize).toBe(100 + 8 + 30);
  });

  it('handles empty byteRanges', () => {
    const layout = cleanFrameLayout(41000, 8, []);
    expect(layout.servedSize).toBe(41008);
  });

  it('handles a 16-byte extended mdat header', () => {
    const layout = cleanFrameLayout(41000, 16, THREE_RUNS);
    expect(layout.servedSize).toBe(41000 + 16 + 30);
  });
});

describe('cleanFrameMaxSrcEnd', () => {
  it('returns the largest srcOffset+length across runs', () => {
    // run 2 ends at 5000+10 = 5010 — the highest original byte referenced.
    expect(cleanFrameMaxSrcEnd(THREE_RUNS)).toBe(5010);
  });

  it('is 0 for an empty sidecar', () => {
    expect(cleanFrameMaxSrcEnd([])).toBe(0);
  });

  it('flags a sidecar whose tail run points past a shrunken original (stale)', () => {
    // Original was reprocessed down to 4000 bytes, but the sidecar still
    // references bytes up to 5010 → maxSrcEnd > fileSize ⇒ stale ⇒ caller 503s
    // instead of serving an out-of-range tail (the nginx-502 symptom).
    const fileSize = 4000;
    expect(cleanFrameMaxSrcEnd(THREE_RUNS) > fileSize).toBe(true);
  });

  it('passes a sidecar that fits within the current original', () => {
    const fileSize = 6000;
    expect(cleanFrameMaxSrcEnd(THREE_RUNS) > fileSize).toBe(false);
  });
});

describe('payloadRangeToOriginalRanges', () => {
  it('maps a cross-run range [5, 14] → [{1005,1009},{2000,2004}]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 5, 14);
    expect(result).toEqual([
      { origStart: 1005, origEnd: 1009 },
      { origStart: 2000, origEnd: 2004 },
    ]);
  });

  it('maps the full range [0, 29] → all three full runs', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 0, 29);
    expect(result).toEqual([
      { origStart: 1000, origEnd: 1009 },
      { origStart: 2000, origEnd: 2009 },
      { origStart: 5000, origEnd: 5009 },
    ]);
  });

  it('maps a single-byte range [10, 10] → [{2000,2000}]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 10, 10);
    expect(result).toEqual([{ origStart: 2000, origEnd: 2000 }]);
  });

  it('maps a range entirely within the first run [2, 7]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 2, 7);
    expect(result).toEqual([{ origStart: 1002, origEnd: 1007 }]);
  });

  it('maps a range entirely within the last run [22, 27]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 22, 27);
    expect(result).toEqual([{ origStart: 5002, origEnd: 5007 }]);
  });

  it('maps a range spanning all three runs at their exact boundaries [0, 29]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 0, 29);
    expect(result).toHaveLength(3);
  });

  it('returns empty array when range is beyond all runs', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 30, 50);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty byteRanges', () => {
    const result = payloadRangeToOriginalRanges([], 0, 100);
    expect(result).toEqual([]);
  });

  it('handles a single run and full range', () => {
    const runs = [{ srcOffset: 9999, length: 5 }];
    const result = payloadRangeToOriginalRanges(runs, 0, 4);
    expect(result).toEqual([{ origStart: 9999, origEnd: 10003 }]);
  });

  it('handles a single run and partial range at the start', () => {
    const runs = [{ srcOffset: 9999, length: 5 }];
    const result = payloadRangeToOriginalRanges(runs, 0, 1);
    expect(result).toEqual([{ origStart: 9999, origEnd: 10000 }]);
  });

  it('maps the last byte of run 1 [9, 9]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 9, 9);
    expect(result).toEqual([{ origStart: 1009, origEnd: 1009 }]);
  });

  it('maps the last byte of run 2 [19, 19]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 19, 19);
    expect(result).toEqual([{ origStart: 2009, origEnd: 2009 }]);
  });

  it('maps a range that exactly spans runs 2 and 3 [10, 29]', () => {
    const result = payloadRangeToOriginalRanges(THREE_RUNS, 10, 29);
    expect(result).toEqual([
      { origStart: 2000, origEnd: 2009 },
      { origStart: 5000, origEnd: 5009 },
    ]);
  });
});

describe('coalesceOriginalRanges', () => {
  it('returns null for empty input', () => {
    expect(coalesceOriginalRanges([])).toBeNull();
  });

  it('single range → keep [{offset:0, length:len}]', () => {
    const result = coalesceOriginalRanges([{ origStart: 9999, origEnd: 10003 }]);
    expect(result).toEqual({
      spanStart: 9999,
      spanEnd: 10003,
      keep: [{ offset: 0, length: 5 }],
    });
  });

  it('two disjoint ranges → correct span + two keep segments', () => {
    const result = coalesceOriginalRanges([
      { origStart: 1005, origEnd: 1009 },
      { origStart: 2000, origEnd: 2004 },
    ]);
    expect(result).toEqual({
      spanStart: 1005,
      spanEnd: 2004,
      keep: [
        { offset: 0, length: 5 },
        { offset: 995, length: 5 },
      ],
    });
  });

  it('three disjoint ranges → correct span + three keep segments', () => {
    const origRanges = [
      { origStart: 1000, origEnd: 1009 },
      { origStart: 2000, origEnd: 2009 },
      { origStart: 5000, origEnd: 5009 },
    ];
    const result = coalesceOriginalRanges(origRanges);
    expect(result).not.toBeNull();
    expect(result!.spanStart).toBe(1000);
    expect(result!.spanEnd).toBe(5009);
    expect(result!.keep).toEqual([
      { offset: 0, length: 10 },
      { offset: 1000, length: 10 },
      { offset: 4000, length: 10 },
    ]);
  });

  it('property: Σ keep.length === Σ (origEnd - origStart + 1)', () => {
    const origRanges = [
      { origStart: 100, origEnd: 149 },  // length 50
      { origStart: 500, origEnd: 599 },  // length 100
      { origStart: 900, origEnd: 924 },  // length 25
    ];
    const result = coalesceOriginalRanges(origRanges)!;
    const keepSum = result.keep.reduce((acc, k) => acc + k.length, 0);
    const rangeSum = origRanges.reduce((acc, r) => acc + (r.origEnd - r.origStart + 1), 0);
    expect(keepSum).toBe(rangeSum);
    expect(keepSum).toBe(175);
  });
});

/** Collect all data events from a Transform/Readable into a single Buffer. */
function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Feed `buf` into a Transform in chunks of `chunkSize` bytes, return output. */
async function feedInChunks(
  transform: ReturnType<typeof createGapSkipTransform>,
  buf: Buffer,
  chunkSize: number,
): Promise<Buffer> {
  const out = collectStream(transform);
  for (let i = 0; i < buf.length; i += chunkSize) {
    transform.write(buf.subarray(i, i + chunkSize));
  }
  transform.end();
  return out;
}

describe('createGapSkipTransform', () => {
  // Reference span: 20 bytes, two keep segments:
  //   keep[0]: offset=2, length=5  → span bytes [2..6]
  //   keep[1]: offset=12, length=5 → span bytes [12..16]
  // Span buffer: 0x00..0x13 (20 bytes, values equal their index)
  const SPAN = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
  const KEEP = [
    { offset: 2, length: 5 },
    { offset: 12, length: 5 },
  ];
  // Expected output: span[2..6] + span[12..16]
  const EXPECTED = Buffer.concat([SPAN.subarray(2, 7), SPAN.subarray(12, 17)]);

  it('single large chunk → correct output', async () => {
    const t = createGapSkipTransform(KEEP);
    const result = await feedInChunks(t, SPAN, SPAN.length);
    expect(result).toEqual(EXPECTED);
  });

  it('1-byte chunks → correct output (every boundary)', async () => {
    const t = createGapSkipTransform(KEEP);
    const result = await feedInChunks(t, SPAN, 1);
    expect(result).toEqual(EXPECTED);
  });

  it('3-byte chunks → correct output (segment straddles chunk boundary)', async () => {
    const t = createGapSkipTransform(KEEP);
    const result = await feedInChunks(t, SPAN, 3);
    expect(result).toEqual(EXPECTED);
  });

  it('7-byte chunks → correct output', async () => {
    const t = createGapSkipTransform(KEEP);
    const result = await feedInChunks(t, SPAN, 7);
    expect(result).toEqual(EXPECTED);
  });

  it('keep covering the full span → passes all bytes through', async () => {
    const t = createGapSkipTransform([{ offset: 0, length: SPAN.length }]);
    const result = await feedInChunks(t, SPAN, 5);
    expect(result).toEqual(SPAN);
  });

  it('empty keep → emits nothing', async () => {
    const t = createGapSkipTransform([]);
    const result = await feedInChunks(t, SPAN, 5);
    expect(result.length).toBe(0);
  });

  it('single-byte keep in the middle → emits exactly that byte', async () => {
    const t = createGapSkipTransform([{ offset: 7, length: 1 }]);
    const result = await feedInChunks(t, SPAN, 3);
    expect(result).toEqual(SPAN.subarray(7, 8));
  });
});
