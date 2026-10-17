/**
 * Run UNTRUSTED, user-authored regexes (custom camera profiles) against
 * adversary-controlled input without letting catastrophic backtracking (ReDoS)
 * freeze the single-threaded event loop.
 *
 * Node's RegExp engine is backtracking-based and a synchronous `.exec()` cannot
 * be interrupted, so a pattern like `(a+)+$` on a non-matching input pegs the
 * CPU for hours. We therefore run every untrusted match inside a reusable
 * worker thread guarded by a hard wall-clock timeout: if the worker doesn't
 * answer in time we terminate it (killing the stuck match), reject with
 * RegexTimeoutError, and respawn a fresh worker for the next job. Built-in,
 * hardcoded profiles are trusted and never come through here.
 *
 * Jobs are serialized through a single worker (one in-flight match at a time),
 * which is all the scanner and the /camera-profiles/test endpoint need.
 */
import { Worker } from 'node:worker_threads';

export class RegexTimeoutError extends Error {
  constructor(msg = 'regex execution timed out') {
    super(msg);
    this.name = 'RegexTimeoutError';
  }
}

/** Hard cap on the input length handed to an untrusted regex. Real camera
 *  basenames are well under 256 chars; anything longer is rejected outright
 *  (no match) so input size can't amplify backtracking. */
export const MAX_UNTRUSTED_INPUT = 1024;

// 500ms gives safe regexes ample headroom for worker round-trip + spawn latency
// even under heavy CPU contention (avoids false-timeout flakes), while still
// killing catastrophic backtracking instantly — a pathological pattern like
// (a+)+$ on a few dozen chars runs for seconds-to-hours, never near this bound.
const TIMEOUT_MS = Math.max(20, Number(process.env.UNTRUSTED_REGEX_TIMEOUT_MS) || 500);

// CommonJS worker body (Node runs `eval:true` worker code as CJS). Kept inline
// so it ships with the compiled bundle without a separate copied file.
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  try {
    const re = new RegExp(m.source, m.flags);
    const match = re.exec(m.input);
    parentPort.postMessage({
      ok: true,
      matched: !!match,
      groups: match && match.groups ? Object.assign({}, match.groups) : null,
    });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message ? String(e.message) : String(e) });
  }
});
`;

export interface UntrustedMatch {
  matched: boolean;
  groups: Record<string, string> | null;
}

interface Job extends UntrustedMatchRequest {
  resolve: (v: UntrustedMatch) => void;
  reject: (e: Error) => void;
}
interface UntrustedMatchRequest {
  source: string;
  flags: string;
  input: string;
}

let worker: Worker | null = null;
let active: Job | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const queue: Job[] = [];

function spawnWorker(): Worker {
  const w = new Worker(WORKER_SRC, { eval: true });
  w.on('message', onMessage);
  w.on('error', onError);
  // Don't keep a short-lived process (tests, CLIs) alive for this worker.
  w.unref();
  return w;
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function onMessage(msg: { ok: boolean; matched?: boolean; groups?: Record<string, string> | null; error?: string }): void {
  const job = active;
  if (!job) return; // late message from a worker we already moved past
  clearTimer();
  active = null;
  if (msg.ok) job.resolve({ matched: !!msg.matched, groups: msg.groups ?? null });
  else job.reject(new Error(msg.error || 'regex error'));
  pump();
}

function onError(err: Error): void {
  const job = active;
  worker = null; // crashed — respawn lazily on next job
  clearTimer();
  active = null;
  if (job) job.reject(err);
  pump();
}

function pump(): void {
  if (active || queue.length === 0) return;
  const job = queue.shift()!;
  active = job;
  if (!worker) worker = spawnWorker();
  timer = setTimeout(() => {
    // Hard timeout: the match is stuck in catastrophic backtracking. Kill the
    // worker outright (terminate is the only way to stop a sync regex), reject,
    // and let pump() spawn a fresh worker for the next job.
    const stuck = worker;
    worker = null;
    active = null;
    timer = null;
    if (stuck) void stuck.terminate().catch(() => { /* already gone */ });
    job.reject(new RegexTimeoutError());
    pump();
  }, TIMEOUT_MS);
  // Let the timer not hold the event loop open on its own.
  (timer as { unref?: () => void }).unref?.();
  worker.postMessage({ source: job.source, flags: job.flags, input: job.input });
}

/**
 * Execute an untrusted regex against `input` under a hard timeout in a worker
 * thread. Resolves with the match result, or rejects with RegexTimeoutError if
 * the match exceeds the budget (the caller should disable the offending
 * profile). Over-long inputs short-circuit to "no match".
 */
export function safeRegexExec(source: string, flags: string, input: string): Promise<UntrustedMatch> {
  if (input.length > MAX_UNTRUSTED_INPUT) {
    return Promise.resolve({ matched: false, groups: null });
  }
  return new Promise<UntrustedMatch>((resolve, reject) => {
    queue.push({ source, flags, input, resolve, reject });
    pump();
  });
}

/**
 * Reject catastrophic regexes at write time. Compiles the pattern (surfaces
 * syntax errors) then runs it against a battery of adversarial probe strings
 * under the same worker timeout. Returns a human-readable reason if the regex
 * is unsafe, or null if it passed.
 */
export async function assertUntrustedRegexSafe(source: string, flags = 'i'): Promise<string | null> {
  try {
    new RegExp(source, flags);
  } catch (e) {
    return e instanceof Error ? `invalid regex: ${e.message}` : 'invalid regex';
  }
  // Long runs of a single class followed by a non-matching tail are what trip
  // exponential backtracking (e.g. (a+)+$, (.*a){n}). Probe a few shapes.
  const probes = [
    'a'.repeat(80) + '!',
    '0'.repeat(80) + '!',
    'ab'.repeat(50) + '!',
    'Camera_'.repeat(40) + '!',
    'A'.repeat(160),
    'a'.repeat(64) + '_' + '0'.repeat(64),
  ];
  for (const probe of probes) {
    try {
      await safeRegexExec(source, flags, probe);
    } catch (e) {
      if (e instanceof RegexTimeoutError) {
        return 'regex is too slow on adversarial input (possible catastrophic backtracking)';
      }
      throw e;
    }
  }
  return null;
}

/** Terminate the shared worker and drop the queue. For tests / graceful shutdown. */
export async function _shutdownRegexWorker(): Promise<void> {
  clearTimer();
  const w = worker;
  worker = null;
  active = null;
  queue.length = 0;
  if (w) await w.terminate().catch(() => { /* already gone */ });
}
