#!/usr/bin/env node
/**
 * Clipnest FTPS download stress.
 *
 * Companion to simulate.js. Where simulate.js pushes N cameras' worth of
 * uploads, this tool hammers the RETR path: it walks the user's FTPS
 * directory tree (YYYY/MM/DD/), collects every .mp4 it finds, then runs M
 * concurrent workers that pick a random file and download it to /dev/null
 * as fast as curl can fetch. Measures throughput + failure rate.
 *
 * Assumes files are already on the server — typically you'd run simulate.js
 * first and then this to characterise the download-side of the pipeline.
 *
 * Usage (local dev):
 *   FTPS_PASSWORD=Admin1234test node download.js \
 *     --host 127.0.0.1 --port 21 --user admin --insecure --concurrency 10 --duration-s 60
 *
 * Usage (prod — use a dedicated test account):
 *   FTPS_PASSWORD='...' node download.js \
 *     --host clips.example.com --port 21 --user you@example.com --insecure \
 *     --concurrency 20 --duration-s 60 --discover-days 3
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    const key = a.replace(/^-+/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`Clipnest FTPS download stress

Options:
  --host HOST               FTPS server hostname           (default: 127.0.0.1)
  --port PORT               FTPS control-channel port      (default: 21)
  --user USER               FTPS username                  (default: admin)
  --pass PASS               FTPS password                  (read from $FTPS_PASSWORD if unset)
  --concurrency N           Number of parallel downloaders (default: 5)
  --duration-s SEC          Run for SEC seconds, then exit (default: 60)
  --discover-days N         Walk the last N UTC days of /YYYY/MM/DD/ (default: 1)
  --path PATH               Only crawl a specific prefix, e.g. 2026/04/16
                            (overrides --discover-days)
  --download-timeout-s SEC  curl --max-time per RETR        (default: 300)
  --insecure                Skip TLS cert validation (dev self-signed)
  --verbose                 Dump every curl invocation and its exit code
  --help                    Show this help

Env vars (used if matching flag is omitted):
  FTPS_PASSWORD             Used as --pass
  FTPS_USER                 Used as --user
`);
  process.exit(0);
}

const opts = {
  host: args.host ?? '127.0.0.1',
  port: Number(args.port ?? 21),
  user: args.user ?? 'admin',
  pass: args.pass ?? process.env.FTPS_PASSWORD ?? '',
  concurrency: Number(args.concurrency ?? 5),
  durationS: Number(args['duration-s'] ?? 60),
  discoverDays: Number(args['discover-days'] ?? 1),
  path: typeof args.path === 'string' ? args.path : null,
  downloadTimeoutS: Number(args['download-timeout-s'] ?? 300),
  insecure: args.insecure === true || args.insecure === 'true',
  verbose: args.verbose === true || args.verbose === 'true',
};

if (!args.user && process.env.FTPS_USER) opts.user = process.env.FTPS_USER;
if (!opts.pass) {
  console.error('error: --pass or $FTPS_PASSWORD is required');
  process.exit(2);
}

// ─── Stats ──────────────────────────────────────────────────────────────────

const stats = {
  startedAt: 0,
  downloads: 0,
  bytes: 0,
  failures: 0,
  perWorker: new Map(),
};

function recordDownload(workerId, bytes) {
  stats.downloads += 1;
  stats.bytes += bytes;
  const w = stats.perWorker.get(workerId) ?? { downloads: 0, failures: 0, bytes: 0 };
  w.downloads += 1;
  w.bytes += bytes;
  stats.perWorker.set(workerId, w);
}

function recordFailure(workerId, reason) {
  stats.failures += 1;
  const w = stats.perWorker.get(workerId) ?? { downloads: 0, failures: 0, bytes: 0 };
  w.failures += 1;
  stats.perWorker.set(workerId, w);
  if (opts.verbose) console.error(`[w${workerId}] failure: ${reason}`);
}

function printStats() {
  const elapsedS = (Date.now() - stats.startedAt) / 1000;
  const mb = stats.bytes / 1024 / 1024;
  const mbps = mb / Math.max(elapsedS, 1);
  console.log(
    `[stats] elapsed=${elapsedS.toFixed(0)}s` +
      `  downloads=${stats.downloads} (${mb.toFixed(1)} MiB, ${mbps.toFixed(2)} MiB/s)` +
      `  failures=${stats.failures}`,
  );
}

function printPerWorkerStats() {
  const rows = [...stats.perWorker.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, v]) => ({
      worker: `w${id}`,
      downloads: v.downloads,
      failures: v.failures,
      mib: (v.bytes / 1024 / 1024).toFixed(1),
    }));
  console.log('[per-worker]');
  console.table(rows);
}

// ─── Discovery (curl NLST) ──────────────────────────────────────────────────

// Returns [] on failure (e.g. dir doesn't exist). NLST emits one file per
// line; the response is raw bytes on stdout.
function curlList(remoteDir) {
  const url = `ftp://${opts.host}:${opts.port}/${remoteDir}${remoteDir.endsWith('/') ? '' : '/'}`;
  const curlArgs = [
    '--silent', '--show-error',
    '--ftp-ssl', '--ftp-pasv',
    '--tls-max', '1.2',
    ...(opts.insecure ? ['--insecure'] : []),
    '--user', `${opts.user}:${opts.pass}`,
    '--list-only',
    '--max-time', '30',
    url,
  ];

  return new Promise((resolve) => {
    const child = spawn('curl', curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) {
        if (opts.verbose) console.error(`[discover] NLST ${remoteDir} failed: ${stderr.trim()}`);
        resolve([]);
        return;
      }
      const names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve(names);
    });
  });
}

function todayUtc() {
  const d = new Date();
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Walk /YYYY/MM/DD/ for the last `days` UTC days, collect every .mp4.
async function discoverFiles() {
  const files = [];
  if (opts.path) {
    const names = await curlList(opts.path);
    for (const n of names) {
      if (n.endsWith('.mp4')) files.push(`${opts.path}/${n}`);
    }
    return files;
  }
  const today = todayUtc();
  for (let offset = 0; offset < opts.discoverDays; offset += 1) {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d - offset));
    const yyyy = String(d.getUTCFullYear());
    const mm = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    const dir = `${yyyy}/${mm}/${dd}`;
    const names = await curlList(dir);
    for (const n of names) {
      if (n.endsWith('.mp4')) files.push(`${dir}/${n}`);
    }
    if (opts.verbose) {
      console.log(`[discover] ${dir}: ${names.filter((n) => n.endsWith('.mp4')).length} mp4(s)`);
    }
  }
  return files;
}

// ─── Download (curl RETR) ───────────────────────────────────────────────────

// Resolves to bytes downloaded on success, rejects with Error on failure.
// curl's -w "%{size_download}" prints the transferred byte count to stdout
// regardless of --output target, so we can pipe the body to /dev/null and
// still learn how much we got.
function curlDownload(remotePath) {
  const url = `ftp://${opts.host}:${opts.port}/${remotePath}`;
  const curlArgs = [
    '--silent', '--show-error',
    '--ftp-ssl', '--ftp-pasv',
    '--tls-max', '1.2',
    ...(opts.insecure ? ['--insecure'] : []),
    '--user', `${opts.user}:${opts.pass}`,
    '--output', '/dev/null',
    '--max-time', String(opts.downloadTimeoutS),
    '--write-out', '%{size_download}',
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('curl', curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        const n = parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(n) ? n : 0);
      } else {
        reject(new Error(`curl exit=${code} ${stderr.trim() || 'unknown error'}`));
      }
    });
  });
}

// ─── Worker loop ────────────────────────────────────────────────────────────

class DownloadWorker {
  constructor(id, files) {
    this.id = id;
    this.files = files;
    this.stopping = false;
  }

  pickFile() {
    return this.files[Math.floor(Math.random() * this.files.length)];
  }

  async run() {
    while (!this.stopping) {
      const path = this.pickFile();
      try {
        const bytes = await curlDownload(path);
        if (this.stopping) break;
        recordDownload(this.id, bytes);
        if (opts.verbose) console.log(`[w${this.id}] /${path} ${bytes} B`);
      } catch (err) {
        if (this.stopping) break;
        recordFailure(this.id, err.message);
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[dl] target=${opts.host}:${opts.port}` +
      `  user=${opts.user}` +
      `  concurrency=${opts.concurrency}` +
      `  duration=${opts.durationS}s` +
      `  ${opts.path ? `path=${opts.path}` : `discover-days=${opts.discoverDays}`}` +
      `  insecure=${opts.insecure}`,
  );

  console.log('[dl] discovering files…');
  const tDiscover = Date.now();
  const files = await discoverFiles();
  const discoverS = ((Date.now() - tDiscover) / 1000).toFixed(1);
  console.log(`[dl] discovered ${files.length} file(s) in ${discoverS}s`);

  if (files.length === 0) {
    console.error('[dl] no files to download — run simulate.js first, or use --path / --discover-days to widen the crawl');
    process.exit(3);
  }

  const workers = Array.from({ length: opts.concurrency }, (_, i) => new DownloadWorker(i, files));

  stats.startedAt = Date.now();
  const statsTimer = setInterval(printStats, 10_000);
  let deadlineTimer = null;
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[dl] stopping (${signal})…`);
    clearInterval(statsTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    workers.forEach((w) => { w.stopping = true; });
    // Give any in-flight curl processes up to 10s to wind down naturally.
    await new Promise((r) => setTimeout(r, 1500));
    printStats();
    printPerWorkerStats();
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  if (opts.durationS > 0) {
    deadlineTimer = setTimeout(() => void stop(`deadline ${opts.durationS}s`), opts.durationS * 1000);
  }

  await Promise.allSettled(workers.map((w) => w.run()));
}

main().catch((err) => {
  console.error('[dl] fatal:', err);
  process.exit(1);
});
