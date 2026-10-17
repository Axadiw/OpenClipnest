export interface GridSample {
  durationTicks: number;     // DTS delta (from trun, may be VFR)
  compositionOffset: number; // signed ctts offset; 0 if none
}

/** Sorted ascending presentation times in SECONDS for one track. */
export function buildFrameGrid(samples: GridSample[], timescale: number): number[] {
  if (samples.length === 0 || timescale <= 0) return [];
  const pts: number[] = [];
  let dts = 0;
  for (const s of samples) {
    pts.push((dts + s.compositionOffset) / timescale);
    dts += s.durationTicks;
  }
  pts.sort((a, b) => a - b);
  return pts;
}
