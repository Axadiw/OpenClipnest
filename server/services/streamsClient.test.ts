import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock infrastructure
// ---------------------------------------------------------------------------

const mockXadd = vi.fn();
const mockXpending = vi.fn();
const mockXrange = vi.fn();
const mockXack = vi.fn();
const mockXclaim = vi.fn();
const mockXgroup = vi.fn();
const mockXreadgroup = vi.fn();
const mockQuit = vi.fn();

// The consumer calls getRedis().duplicate() for its own connection, so the
// mock must return a redis-like object with a duplicate() that returns the
// same (or a sibling) mock — all ops on the dedicated connection go through
// the returned duplicate.
const makeMockRedis = () => ({
  xadd: (...a: unknown[]) => mockXadd(...a),
  xpending: (...a: unknown[]) => mockXpending(...a),
  xrange: (...a: unknown[]) => mockXrange(...a),
  xack: (...a: unknown[]) => mockXack(...a),
  xclaim: (...a: unknown[]) => mockXclaim(...a),
  xgroup: (...a: unknown[]) => mockXgroup(...a),
  xreadgroup: (...a: unknown[]) => mockXreadgroup(...a),
  quit: (...a: unknown[]) => mockQuit(...a),
  duplicate() { return this; },
});

vi.mock('../utils/redis.js', () => ({
  getRedis: () => makeMockRedis(),
}));

import { publishScanTrigger, STREAM_SCAN_TRIGGER, consume } from './streamsClient.js';

// ---------------------------------------------------------------------------
// reclaimStale — DLQ-less drop logging
// ---------------------------------------------------------------------------
//
// The consume() loop calls reclaimStale() every 7th iteration (sinceReclaim
// increments from 0; fires when sinceReclaim++ >= 6, i.e. on the 7th pass).
// We drive it by making xreadgroup return null (no new messages) so the loop
// cycles fast, then have xpending return a stale entry on the 7th call.
//
// Context: a root upload stuck at "Processing 1 file" because a dropped
// scan-trigger was silently discarded without any Sentry-visible log — the
// 24h full rescan was the only recovery path.

/**
 * Drive the consumer loop until reclaimStale has fired and completed.
 *
 * reclaimStale fires on the 7th iteration (sinceReclaim goes 0→6 then resets).
 * We let the loop run up to 9 xreadgroup calls — once call #9 arrives the loop
 * is past the reclaim point. We signal stop() without awaiting it inside the
 * mock (awaiting would cause a deadlock: stop() waits for the loop, the loop
 * waits for this very xreadgroup mock to return). The returned promise from
 * consumer.stop() is captured and awaited AFTER the mock returns null so the
 * loop observes `stopped === true` and exits cleanly.
 */
async function driveLoopUntilReclaim(consumer: import('./streamsClient.js').Consumer): Promise<void> {
  let calls = 0;
  let stopPromise: Promise<void> | undefined;
  mockXreadgroup.mockImplementation(async () => {
    calls++;
    if (calls >= 9 && !stopPromise) {
      // Kick stop() without awaiting — the loop must return from xreadgroup
      // first; awaiting here would deadlock.
      stopPromise = consumer.stop();
    }
    return null;
  });
  // Wait for the loop to idle long enough that reclaimStale has completed
  // and the stop signal has propagated.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  // Now await the stop promise so the loop is fully torn down.
  if (stopPromise) await stopPromise;
  // Self-verify: quit must have been called (consumer connection closed).
  expect(mockQuit).toHaveBeenCalled();
}

describe('reclaimStale — message dropped without DLQ', () => {
  const STREAM = 'stream:scan-trigger';
  const GROUP = 'event-managers';
  const MSG_ID = '1234567890-1';

  beforeEach(() => {
    vi.resetAllMocks();
    // ensureGroup: throw BUSYGROUP so it doesn't fail the loop
    mockXgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));
    mockQuit.mockResolvedValue('OK');
    mockXack.mockResolvedValue(1);
    mockXrange.mockResolvedValue([[MSG_ID, ['userUuid', 'user-42', 's3Key', '2026/01/01/clip.mp4']]]);
    // xreadgroup returns null on most calls; overridden per test by driveLoopUntilReclaim
    mockXreadgroup.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('XACKs the entry and emits console.error with stream/id/DROPPED when no DLQ is configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Pending entry with 5 deliveries (> default maxDeliveries 3)
    mockXpending.mockResolvedValue([[MSG_ID, 'consumer-1', 45000, 5]]);

    const c = consume({
      stream: STREAM,
      group: GROUP,
      // No dlq option — this is the DLQ-less path being tested
      maxDeliveries: 3,
      blockMs: 0,
      handler: async () => {},
    });

    await driveLoopUntilReclaim(c);

    // Must XACK so the message leaves the PEL
    expect(mockXack).toHaveBeenCalledWith(STREAM, GROUP, MSG_ID);

    // Must log via console.error (Sentry-visible) with stream, id and "DROPPED"
    const errorCalls = errorSpy.mock.calls.flat().join(' ');
    expect(errorCalls).toContain(STREAM);
    expect(errorCalls).toContain(MSG_ID);
    expect(errorCalls).toContain('DROPPED');

    // Must NOT use console.warn for this path (warn is reserved for DLQ path)
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    // warnCalls may contain xreadgroup/reclaim-error warns; must not contain MSG_ID with DLQ wording
    expect(warnCalls).not.toContain('→ DLQ');

    // Must NOT write to any DLQ stream
    expect(mockXadd).not.toHaveBeenCalled();
  });

  it('still XACKs and logs DROPPED even when xrange throws (payload fetch failure)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockXpending.mockResolvedValue([[MSG_ID, 'consumer-1', 45000, 5]]);
    // Simulate xrange failure
    mockXrange.mockRejectedValue(new Error('xrange network failure'));

    const c = consume({
      stream: STREAM,
      group: GROUP,
      maxDeliveries: 3,
      blockMs: 0,
      handler: async () => {},
    });

    await driveLoopUntilReclaim(c);

    // XACK must still happen despite xrange failure
    expect(mockXack).toHaveBeenCalledWith(STREAM, GROUP, MSG_ID);

    // console.error must still fire with the drop markers
    const errorCalls = errorSpy.mock.calls.flat().join(' ');
    expect(errorCalls).toContain(STREAM);
    expect(errorCalls).toContain(MSG_ID);
    expect(errorCalls).toContain('DROPPED');

    // No DLQ write
    expect(mockXadd).not.toHaveBeenCalled();
  });
});

describe('reclaimStale — message dead-lettered WITH DLQ', () => {
  const STREAM = 'stream:thumbnail';
  const DLQ = 'stream:thumbnail-dlq';
  const GROUP = 'thumbnail-workers';
  const MSG_ID = '9876543210-0';

  beforeEach(() => {
    vi.resetAllMocks();
    mockXgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));
    mockQuit.mockResolvedValue('OK');
    mockXack.mockResolvedValue(1);
    mockXadd.mockResolvedValue('9876543210-1');
    mockXrange.mockResolvedValue([[MSG_ID, ['eventId', 'evt-99', 'ownerId', '7']]]);
    mockXreadgroup.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dead-letters via XADD to DLQ and uses console.warn (not console.error)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockXpending.mockResolvedValue([[MSG_ID, 'consumer-1', 45000, 5]]);

    const c = consume({
      stream: STREAM,
      group: GROUP,
      dlq: DLQ,
      maxDeliveries: 3,
      blockMs: 0,
      handler: async () => {},
    });

    await driveLoopUntilReclaim(c);

    // Must XACK
    expect(mockXack).toHaveBeenCalledWith(STREAM, GROUP, MSG_ID);

    // Must XADD to the DLQ stream — use the robust positional pattern
    // (same style as the publishScanTrigger tests in this file).
    expect(mockXadd).toHaveBeenCalledTimes(1);
    const xaddCall = mockXadd.mock.calls[0];
    // First arg is the stream name.
    expect(xaddCall[0]).toBe(DLQ);
    // Flat field list starts after the MAXLEN/~/maxLen/'*' envelope (positions 1-4).
    const xaddFields = xaddCall.slice(5);
    // Original payload fields must be present.
    expect(xaddFields).toContain('eventId');
    // DLQ envelope fields must be present.
    expect(xaddFields).toContain('originalId');
    expect(xaddFields).toContain(MSG_ID);
    expect(xaddFields).toContain('deadLetteredAt');

    // Must log via console.warn (DLQ path)
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).toContain(MSG_ID);

    // Must NOT log via console.error for a DLQ-covered entry
    // (xreadgroup is mocked to resolve null here — no loop errors expected)
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves entry in PEL (no xadd, no xack) and fires reclaim-error warn when xrange throws on DLQ path', async () => {
    // Fix 2: when xrange fails on a DLQ-configured consumer the error must
    // propagate — a DLQ entry without its payload is worthless, so we rethrow
    // and let the loop-level reclaim-error handler emit a console.warn, keeping
    // the entry in the PEL for a retry once xrange recovers.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockXpending.mockResolvedValue([[MSG_ID, 'consumer-1', 45000, 5]]);
    mockXrange.mockRejectedValue(new Error('xrange network failure'));

    const c = consume({
      stream: STREAM,
      group: GROUP,
      dlq: DLQ,
      maxDeliveries: 3,
      blockMs: 0,
      handler: async () => {},
    });

    await driveLoopUntilReclaim(c);

    // No XADD — entry must NOT be dead-lettered with empty fields.
    expect(mockXadd).not.toHaveBeenCalled();
    // No XACK — entry must stay in PEL for a retry.
    expect(mockXack).not.toHaveBeenCalled();

    // The loop-level reclaim-error handler must have fired a console.warn
    // (see `streams: reclaim error on <stream>:` in the source).
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).toContain('reclaim error');
    expect(warnCalls).toContain(STREAM);

    // Must NOT emit console.error (that's the DLQ-less drop path).
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// publishScanTrigger
// ---------------------------------------------------------------------------

describe('publishScanTrigger', () => {
  beforeEach(() => {
    mockXadd.mockReset();
    mockXadd.mockResolvedValue('1234567890-0');
  });

  it('XADDs to stream:scan-trigger with userUuid + s3Key fields', async () => {
    await publishScanTrigger('user-abc', 'user-abc/2026/05/26/Foo_00_TS.mp4');

    expect(mockXadd).toHaveBeenCalledTimes(1);
    const call = mockXadd.mock.calls[0];
    // Signature: xadd(stream, 'MAXLEN', '~', maxLen, '*', ...fields)
    expect(call[0]).toBe(STREAM_SCAN_TRIGGER);
    expect(call[1]).toBe('MAXLEN');
    expect(call[2]).toBe('~');
    // The flat field list lives at positions 5+ (after `*`).
    const fields = call.slice(5);
    expect(fields).toContain('userUuid');
    expect(fields).toContain('user-abc');
    expect(fields).toContain('s3Key');
    expect(fields).toContain('user-abc/2026/05/26/Foo_00_TS.mp4');
  });

  it('accepts empty s3Key (forceFull semantics, used by wipe-user-content)', async () => {
    await publishScanTrigger('user-abc', '');

    expect(mockXadd).toHaveBeenCalledTimes(1);
    const fields = mockXadd.mock.calls[0].slice(5);
    const s3KeyIdx = fields.indexOf('s3Key');
    expect(s3KeyIdx).toBeGreaterThanOrEqual(0);
    expect(fields[s3KeyIdx + 1]).toBe('');
  });
});
