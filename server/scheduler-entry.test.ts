import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { story } from './testing/story.js';
import { schedule, JOBS, type Job } from './scheduler-entry.js';

const job: Job = { name: 't', script: 'x', everyMs: 1000, firstAfterMs: 100, timeoutMs: 5000 };

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scheduler', () => {
  it('runs a job after its first delay and then on its cadence', async () => {
    const run = vi.fn(async () => 0);
    const stop = schedule(job, run);
    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('never overlaps a job with itself', async (ctx) => {
    story(ctx, 'Gdy poprzedni przebieg jeszcze trwa, kolejny tick jest pomijany — dwa audyty naraz walczyłyby o te same pliki.');
    let finish: (code: number) => void = () => {};
    const run = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const stop = schedule(job, run);
    await vi.advanceTimersByTimeAsync(100 + 5000);
    expect(run).toHaveBeenCalledTimes(1);
    finish(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('covers every maintenance job the single-host install needs', () => {
    expect(JOBS.map((j) => j.name).sort()).toEqual(['audit', 'oauth-sweep', 'orphan-sweep', 'redrive']);
  });
});
