// Scheduler — standalone entrypoint for single-host (docker compose) installs.
//
// The periodic maintenance jobs are one-shot scripts (redrive, audit, orphan
// sweep, OAuth sweep). On a cluster each runs as its own scheduled job; on a
// single host this process runs them on the same cadence. Each run is a fresh
// child process, so the code path is identical to the scheduled-job one and a
// crash or leak in a job can never take the scheduler down with it.
//
// Without these, a transient storage error leaves a recording unplayable
// forever (redrive is the retry path), retention and auto-delete never run
// (audit), and orphaned objects are never reclaimed (orphan sweep).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `.js` when running the compiled build, `.ts` under tsx in development.
const EXT = path.extname(fileURLToPath(import.meta.url));

export interface Job {
  name: string;
  /** Script path relative to this file, without extension. */
  script: string;
  everyMs: number;
  /** Delay before the first run, so jobs do not all fire at startup. */
  firstAfterMs: number;
  /** A run still going after this long is killed. */
  timeoutMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const JOBS: Job[] = [
  // Retry path of the ingest state machine: re-publish stuck sidecar/thumbnail
  // work, relink files, recompute stale playback readiness.
  { name: 'redrive', script: 'redrive-once', everyMs: MIN, firstAfterMs: 30_000, timeoutMs: 5 * MIN },
  // Storage reconcile, retention, auto-delete-oldest, stale multipart cleanup.
  { name: 'audit', script: 'audit-once', everyMs: 6 * HOUR, firstAfterMs: 5 * MIN, timeoutMs: 30 * MIN },
  // Detect (and after a grace period purge) objects no database row points at.
  { name: 'orphan-sweep', script: 'orphan-sweep-once', everyMs: 24 * HOUR, firstAfterMs: 20 * MIN, timeoutMs: 60 * MIN },
  // Expired OAuth (MCP) grants and device codes.
  { name: 'oauth-sweep', script: 'scripts/oauthSweep', everyMs: 10 * MIN, firstAfterMs: 2 * MIN, timeoutMs: 5 * MIN },
];

type Spawn = (job: Job) => Promise<number>;

const runScript: Spawn = (job) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, path.join(HERE, job.script + EXT)], {
      stdio: 'inherit',
      env: process.env,
    });
    const killer = setTimeout(() => {
      console.error(`scheduler: ${job.name} exceeded ${job.timeoutMs} ms — killing`);
      child.kill('SIGKILL');
    }, job.timeoutMs);
    child.on('exit', (code) => { clearTimeout(killer); resolve(code ?? 1); });
    child.on('error', (err) => { clearTimeout(killer); console.error(`scheduler: ${job.name} failed to start: ${err.message}`); resolve(1); });
  });

/**
 * Run `job` on its cadence, never overlapping with itself: a run that is still
 * going when the next tick arrives makes that tick a no-op. Returns a stop fn.
 */
export function schedule(job: Job, run: Spawn = runScript): () => void {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    const started = Date.now();
    try {
      const code = await run(job);
      const took = Date.now() - started;
      if (code === 0) console.log(`scheduler: ${job.name} ok in ${took} ms`);
      else console.error(`scheduler: ${job.name} exited ${code} after ${took} ms`);
    } finally {
      running = false;
    }
  };
  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), job.everyMs);
  }, job.firstAfterMs);
  return () => { stopped = true; clearTimeout(first); if (interval) clearInterval(interval); };
}

// Started only when executed as the entrypoint, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stops = JOBS.map((job) => schedule(job));
  console.log(`scheduler: ${JOBS.map((j) => j.name).join(', ')} scheduled`);
  const shutdown = (): void => { stops.forEach((stop) => stop()); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
