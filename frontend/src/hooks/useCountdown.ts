import { useCallback, useEffect, useState } from 'react';

export interface Countdown {
  /** Whole seconds left, 0 when idle. */
  remaining: number;
  /** True while a countdown is running (remaining > 0). */
  active: boolean;
  /**
   * (Re)start the countdown. Coalesces with any running countdown by taking
   * the larger value — so multiple parallel 429s (one CMD+R fans out into
   * several API calls) collapse into a single, longest timer and a later
   * shorter `Retry-After` never truncates a longer wait. Non-positive or
   * non-finite values are ignored (e.g. a missing/garbled `Retry-After`).
   */
  start: (seconds: number) => void;
}

export function useCountdown(): Countdown {
  const [remaining, setRemaining] = useState(0);

  const start = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setRemaining((prev) => Math.max(prev, Math.ceil(seconds)));
  }, []);

  const active = remaining > 0;

  useEffect(() => {
    if (!active) return;
    // Depend on `active` (the boolean), not `remaining` — recreating the
    // interval on every tick would reset the 1s phase and drift. The
    // functional update keeps the closure fresh, so a single interval ticks
    // the whole way down; it's torn down once `active` flips false at zero.
    const id = window.setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return { remaining, active, start };
}
