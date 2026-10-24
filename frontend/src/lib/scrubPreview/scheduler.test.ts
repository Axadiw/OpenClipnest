import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createSettleScheduler } from './scheduler';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('createSettleScheduler', () => {
  let run: Mock<(t: number, signal: AbortSignal) => Promise<void>>;
  let resolvers: Array<() => void>;
  let s: ReturnType<typeof createSettleScheduler>;
  beforeEach(() => {
    resolvers = [];
    run = vi.fn(() => new Promise<void>((r) => { resolvers.push(r); }));
    s = createSettleScheduler({ run });
  });
  afterEach(() => { s.dispose(); });

  it('runs the first point at once, without waiting for the pointer to rest', () => {
    s.point(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(3);
  });

  it('a newer point never aborts the run in flight and never runs two at once', () => {
    s.point(1);
    const sig1 = run.mock.calls[0][1] as AbortSignal;
    s.point(5);
    expect(sig1.aborted).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.inFlight()).toBe(1);
  });

  it('a sweep of 20 points during a run yields exactly one follow-up, for the last point', async () => {
    s.point(0);
    for (let i = 1; i <= 20; i++) {
      s.point(i);
      expect(s.inFlight()).toBeLessThanOrEqual(1);
    }
    expect(run).toHaveBeenCalledTimes(1);
    resolvers[0](); await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toBe(20);
    resolvers[1](); await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(s.inFlight()).toBe(0);
  });

  it('a continuous sweep keeps producing runs, one after another', async () => {
    s.point(0);
    for (let step = 1; step <= 5; step++) {
      s.point(step * 10);
      resolvers[step - 1](); await flush();
      expect(run).toHaveBeenCalledTimes(step + 1);
      expect(run.mock.calls[step][0]).toBe(step * 10);
    }
  });

  it('pointing back at the running time drops the queued point', async () => {
    s.point(1);
    s.point(2);
    s.point(1);
    resolvers[0](); await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leave() aborts the run in flight and forgets the queued point', async () => {
    s.point(1);
    const sig = run.mock.calls[0][1] as AbortSignal;
    s.point(2);
    s.leave();
    expect(sig.aborted).toBe(true);
    expect(s.inFlight()).toBe(0);
    resolvers[0](); await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a run that throws synchronously does not wedge the scheduler', async () => {
    run.mockImplementationOnce(() => { throw new Error('boom'); });
    s.point(1);
    await flush();
    expect(s.inFlight()).toBe(0);
    s.point(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
