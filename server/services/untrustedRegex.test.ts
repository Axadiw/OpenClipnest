import { describe, it, expect, afterAll } from 'vitest';
import {
  safeRegexExec,
  assertUntrustedRegexSafe,
  RegexTimeoutError,
  MAX_UNTRUSTED_INPUT,
  _shutdownRegexWorker,
} from './untrustedRegex.js';

afterAll(async () => {
  await _shutdownRegexWorker();
});

describe('safeRegexExec', () => {
  it('returns named groups for a safe matching regex', async () => {
    const r = await safeRegexExec('^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'i', 'Front_20260101120000.mp4');
    expect(r.matched).toBe(true);
    expect(r.groups).toMatchObject({ camera: 'Front', ts: '20260101120000', ext: 'mp4' });
  });

  it('returns matched=false for a safe non-matching regex', async () => {
    const r = await safeRegexExec('^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'i', 'not-a-camera-file.txt');
    expect(r.matched).toBe(false);
    expect(r.groups).toBeNull();
  });

  it('rejects with RegexTimeoutError on catastrophic backtracking', async () => {
    // (a+)+$ on a long run of "a" with a non-matching tail is the textbook
    // exponential-backtracking ReDoS; must be killed by the timeout.
    await expect(
      safeRegexExec('^(a+)+$', '', 'a'.repeat(60) + '!'),
    ).rejects.toBeInstanceOf(RegexTimeoutError);
  }, 10_000);

  it('short-circuits over-long input to no-match (length cap)', async () => {
    const r = await safeRegexExec('^.+$', '', 'x'.repeat(MAX_UNTRUSTED_INPUT + 1));
    expect(r.matched).toBe(false);
  });
});

describe('assertUntrustedRegexSafe', () => {
  it('passes a normal camera-profile regex', async () => {
    const reason = await assertUntrustedRegexSafe(
      '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4|jpg)$',
      'i',
    );
    expect(reason).toBeNull();
  });

  it('rejects a catastrophic profile-shaped regex', async () => {
    const reason = await assertUntrustedRegexSafe(
      '^(?<camera>([a-z]+)+)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      'i',
    );
    expect(reason).toMatch(/catastrophic|too slow/i);
  }, 10_000);

  it('rejects an invalid regex with a reason', async () => {
    const reason = await assertUntrustedRegexSafe('(unclosed', 'i');
    expect(reason).toMatch(/invalid regex/i);
  });
});
