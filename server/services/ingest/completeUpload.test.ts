import { describe, it, expect } from 'vitest';
import { dualViewRecordingsMatch } from '../scanner/eventBuilder.js';

describe('dualViewRecordingsMatch (ingest reuse)', () => {
  it('matches a zoom file 14s after a wide file with unknown durations (30s fallback)', () => {
    const wide = Date.UTC(2026, 5, 12, 12, 19, 35);
    const zoom = Date.UTC(2026, 5, 12, 12, 19, 49);
    expect(dualViewRecordingsMatch(wide, undefined, zoom, undefined)).toBe(true);
  });
  it('rejects 45s apart with unknown durations', () => {
    const a = Date.UTC(2026, 5, 12, 12, 0, 0);
    expect(dualViewRecordingsMatch(a, undefined, a + 45_000, undefined)).toBe(false);
  });
});
