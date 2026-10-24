/**
 * Paces scrub-bar pointer movement so the preview follows the pointer without piling up work:
 * at most one run is in flight, and a point arriving while one runs is remembered as `next`
 * (only the latest is kept) and starts as soon as the current run finishes. A newer point never
 * aborts the run in flight, so during a sweep frames keep arriving instead of each one being
 * cancelled before it paints; `leave()` aborts it.
 *
 * Nothing waits for the pointer to rest: the first point starts at once.
 */
export interface SettleScheduler {
  point(t: number): void;
  leave(): void;
  dispose(): void;
  inFlight(): number;
}

export function createSettleScheduler(opts: {
  run: (t: number, signal: AbortSignal) => Promise<void>;
}): SettleScheduler {
  let current: { t: number; ctrl: AbortController } | null = null;
  /** The latest time pointed at while a run was in flight. */
  let next: number | null = null;

  const abortCurrent = () => {
    current?.ctrl.abort();
    current = null;
  };
  const start = (t: number) => {
    const ctrl = new AbortController();
    const mine = { t, ctrl };
    current = mine;
    let p: Promise<void>;
    try { p = opts.run(t, ctrl.signal); } catch { p = Promise.resolve(); }
    const done = () => {
      if (current !== mine) return;
      current = null;
      if (next !== null) {
        const t2 = next;
        next = null;
        start(t2);
      }
    };
    p.then(done, done);
  };

  return {
    point(t) {
      if (current) {
        next = current.t === t ? null : t;
        return;
      }
      next = null;
      start(t);
    },
    leave() { next = null; abortCurrent(); },
    dispose() { next = null; abortCurrent(); },
    inFlight: () => (current ? 1 : 0),
  };
}
