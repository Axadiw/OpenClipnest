import { describe, test, expect } from 'vitest';
import { barClickSeekSec, isSameClipSeek, isMacPlatform, LONG_PRESS_MS } from './timelineSeek';

describe('barClickSeekSec', () => {
  // Bar drawn from x=100 to x=300 (200 px) for a 30 s clip.
  const LEFT = 100;
  const WIDTH = 200;
  const CLIP = 30;

  test('a plain click always plays from the start, wherever it lands', () => {
    expect(barClickSeekSec(100, LEFT, WIDTH, CLIP, false)).toBe(0);
    expect(barClickSeekSec(200, LEFT, WIDTH, CLIP, false)).toBe(0);
    expect(barClickSeekSec(299, LEFT, WIDTH, CLIP, false)).toBe(0);
  });

  test('a precise click maps proportionally onto the clip', () => {
    expect(barClickSeekSec(200, LEFT, WIDTH, CLIP, true)).toBeCloseTo(15, 6);
    expect(barClickSeekSec(150, LEFT, WIDTH, CLIP, true)).toBeCloseTo(7.5, 6);
    expect(barClickSeekSec(100, LEFT, WIDTH, CLIP, true)).toBe(0);
  });

  test('a precise click at/after the bar end clamps 0.25 s inside the clip', () => {
    expect(barClickSeekSec(300, LEFT, WIDTH, CLIP, true)).toBeCloseTo(29.75, 6);
    expect(barClickSeekSec(400, LEFT, WIDTH, CLIP, true)).toBeCloseTo(29.75, 6);
  });

  test('a precise click left of the bar clamps to 0', () => {
    expect(barClickSeekSec(50, LEFT, WIDTH, CLIP, true)).toBe(0);
  });

  test('a zero-width (unmeasured) bar or an empty clip falls back to 0', () => {
    expect(barClickSeekSec(200, LEFT, 0, CLIP, true)).toBe(0);
    expect(barClickSeekSec(200, LEFT, -5, CLIP, true)).toBe(0);
    expect(barClickSeekSec(200, LEFT, WIDTH, 0, true)).toBe(0);
    expect(barClickSeekSec(200, LEFT, WIDTH, 0.1, true)).toBe(0);
  });

  test('non-finite input never leaks NaN into the player', () => {
    expect(barClickSeekSec(Number.NaN, LEFT, WIDTH, CLIP, true)).toBe(0);
    expect(barClickSeekSec(200, LEFT, WIDTH, Number.NaN, true)).toBe(0);
  });
});

describe('isSameClipSeek', () => {
  const cur = { eventId: 'ev1', view: '00', seekSec: undefined as number | undefined };

  test('same clip + view + start → restart in place', () => {
    expect(isSameClipSeek(cur, 'ev1', '00', 0)).toBe(true);
  });

  test('compares seeks rounded to whole seconds', () => {
    expect(isSameClipSeek({ ...cur, seekSec: 15.2 }, 'ev1', '00', 14.9)).toBe(true);
    expect(isSameClipSeek({ ...cur, seekSec: 15.2 }, 'ev1', '00', 0)).toBe(false);
  });

  test('another clip, another view or nothing playing → open normally', () => {
    expect(isSameClipSeek(cur, 'ev2', '00', 0)).toBe(false);
    expect(isSameClipSeek(cur, 'ev1', '01', 0)).toBe(false);
    expect(isSameClipSeek(null, 'ev1', '00', 0)).toBe(false);
  });
});

describe('isMacPlatform', () => {
  test('recognises both userAgentData and legacy navigator.platform spellings', () => {
    expect(isMacPlatform('macOS')).toBe(true);
    expect(isMacPlatform('MacIntel')).toBe(true);
  });

  test('everything else uses Ctrl', () => {
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(isMacPlatform('')).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });
});

test('long-press threshold is the platform-conventional 500 ms', () => {
  expect(LONG_PRESS_MS).toBe(500);
});
