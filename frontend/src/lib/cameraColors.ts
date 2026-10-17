/**
 * Deterministic per-camera colour — a PURE FUNCTION of the camera NAME.
 *
 * Each camera's colour depends ONLY on its own name (three independent djb2
 * hashes, seeds 5381 / 7919 / 104729), never on the rest of the set. This is
 * the single source of truth shared byte-for-byte with iOS / macOS / tvOS /
 * Windows / Android (`CameraPalette.{swift,cs,kt}`).
 *
 * Stability properties:
 *   - A camera keeps the exact same colour everywhere and across sessions.
 *   - Adding or removing a camera NEVER changes any other camera's colour.
 *   - hue = djb2(name, 5381) mod 360; saturation cycles 58/65/72 via
 *     djb2(name, 7919) mod 3; lightness alternates 46/58 via
 *     djb2(name, 104729) mod 2 — enough variation to keep dense 30–50 camera
 *     timelines legible, all combos ≥46% light / ≥58% sat for solid contrast
 *     on the white timeline and the dark admin storage bars alike.
 */

/** 32-bit djb2 over the name's UTF-16 code units (`|0` = wrap to int32). */
function djb2(name: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return h;
}

const mod = (x: number, n: number): number => ((x % n) + n) % n;

/** The canonical colour for a single camera name. */
export function colorForCamera(name: string): string {
  const hue = mod(djb2(name, 5381), 360);
  const sat = 58 + mod(djb2(name, 7919), 3) * 7; // 58 / 65 / 72
  const light = 46 + mod(djb2(name, 104729), 2) * 12; // 46 / 58
  return `hsl(${hue.toFixed(1)}deg ${sat}% ${light}%)`;
}

/** Convenience: a name→colour map for a set of cameras (each independent). */
export function paletteForCameras(cameras: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cam of new Set(cameras)) map.set(cam, colorForCamera(cam));
  return map;
}
