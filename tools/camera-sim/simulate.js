#!/usr/bin/env node
/**
 * Clipnest camera simulator.
 *
 * Spawns N concurrent "camera" workers, each uploading files on a jittered
 * interval via curl's explicit FTPS support (curl --ftp-ssl). File names
 * follow the Reolink pattern that `server/services/scanner.ts` FILE_REGEX
 * expects: CameraName_View_YYYYMMDDHHMMSS.mp4
 *
 * Why curl and not basic-ftp: libunftp rejects basic-ftp's `OPTS MLST
 * type;size;modify;unique;unix.mode;...` auto-configuration with 501
 * Invalid Parameter, which tears down the control channel. curl's FTPS
 * client is simpler and interoperates with libunftp.
 *
 * Usage:
 *   FTPS_PASSWORD=... node simulate.js --host 127.0.0.1 --user foo --cameras 3
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';

// FTPS server in ftps-server/src/storage.rs validates magic bytes on upload:
//   .mp4 → bytes[4..8] must be "ftyp"
//   .jpg → bytes[0..3] must be FF D8 FF
// These stubs satisfy the check so the uploads aren't rejected with 550.
const MP4_MAGIC = Buffer.from([
  0x00, 0x00, 0x00, 0x20,              // box size (32 bytes, arbitrary)
  0x66, 0x74, 0x79, 0x70,              // "ftyp"
  0x69, 0x73, 0x6f, 0x6d,              // major brand "isom"
  0x00, 0x00, 0x02, 0x00,              // minor version
]);
const JPG_MAGIC = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0,              // SOI + APP0
  0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,  // length + "JFIF\0"
  0x01, 0x01,                          // JFIF version 1.01
  0x00, 0x00, 0x01, 0x00, 0x01,        // units, xdensity, ydensity
  0x00, 0x00,                          // no thumbnail
]);

function makePayload(totalBytes, magic) {
  const filler = randomBytes(Math.max(0, totalBytes - magic.length));
  return Buffer.concat([magic, filler], totalBytes);
}

// Synthesize a valid mp4 via ffmpeg. One file per camera, generated once
// at startup and reused for every upload — variation comes from the
// filename's per-upload timestamp, not the bytes themselves. Good enough
// for exercising ffprobe + thumbnail generation.
//
// Codec pick: libx264 if present (best portability for downstream
// consumers), else h264_videotoolbox (macOS hw accel), else mpeg4 which is
// always compiled into libav. All three land in an mp4 container with a
// proper `ftyp` + `moov`.
async function ffmpegBuildRealMp4(outputPath, cameraName, seconds) {
  // Use testsrc2 (animated colour-bar pattern with moving elements) instead
  // of a flat colour source — a solid colour compresses to ~80 KiB regardless
  // of the nominal bitrate, which defeats the point of stress-testing upload
  // bandwidth and storage. testsrc2's rich detail holds the requested bitrate
  // and produces realistic-looking Reolink-style clip sizes.
  //
  // Pattern uses the camera label's hash as the source seed via the testsrc2
  // `alpha` param (0..255) so each camera's clips look visually distinct in
  // the UI without needing the drawtext filter (often absent from minimal
  // ffmpeg builds).
  const seed = hashForLabel(cameraName) % 256;
  const filter = `testsrc2=size=${opts.resolution}:duration=${seconds}:rate=30:alpha=${seed}`;
  const baseArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', filter,
  ];
  const tail = [
    '-pix_fmt', 'yuv420p',
    '-b:v', opts.bitrate,
    '-maxrate', opts.bitrate,
    '-bufsize', opts.bitrate,
    '-movflags', '+faststart',
    '-t', String(seconds),
    outputPath,
  ];
  const encoders = await listEncoders();
  let codec;
  if (encoders.has('libx264')) codec = ['-c:v', 'libx264', '-preset', 'ultrafast'];
  else if (encoders.has('h264_videotoolbox')) codec = ['-c:v', 'h264_videotoolbox'];
  else codec = ['-c:v', 'mpeg4'];
  return ffmpegRun([...baseArgs, ...codec, ...tail]);
}

let _encoderCache = null;
async function listEncoders() {
  if (_encoderCache) return _encoderCache;
  const out = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(buf));
  });
  _encoderCache = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[A-Z.]+\s+(\S+)\s/);
    if (m) _encoderCache.add(m[1]);
  }
  return _encoderCache;
}

// Synthesize a JPEG thumbnail via ffmpeg. Single frame from a color source.
function ffmpegBuildRealJpg(outputPath, cameraName) {
  // Thumbnail stays small — 640x360 is what Reolink cameras send as the
  // sidecar preview regardless of the recording resolution.
  const color = colorForLabel(cameraName);
  const filter = `color=c=${color}:s=640x360:d=1`;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', filter,
    '-frames:v', '1', '-q:v', '3',
    outputPath,
  ];
  return ffmpegRun(args);
}

// Deterministic color per label (16 muted ffmpeg-compatible names — used for
// the JPEG thumbnail which doesn't need testsrc2 complexity).
function colorForLabel(label) {
  const palette = [
    'steelblue', 'forestgreen', 'darkred', 'goldenrod',
    'slategray', 'darkorange', 'mediumorchid', 'teal',
    'firebrick', 'darkslateblue', 'olive', 'sienna',
    'cadetblue', 'darkkhaki', 'darkseagreen', 'rosybrown',
  ];
  return palette[hashForLabel(label) % palette.length];
}

function hashForLabel(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash;
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg not found on PATH — install it or drop --real-video'));
      } else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit=${code} ${stderr.trim() || ''}`));
    });
  });
}

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const opts = {
  host: args.host ?? '127.0.0.1',
  port: Number(args.port ?? 21),
  user: args.user ?? 'admin',
  pass: args.pass ?? '',
  cameras: Number(args.cameras ?? 3),
  intervalMs: Number(args['interval-ms'] ?? 10_000),
  jitterPct: Number(args['jitter-pct'] ?? 30),
  fileSizeKb: Number(args['file-size-kb'] ?? 1024),
  durationS: args['duration-s'] ? Number(args['duration-s']) : null,
  insecure: args.insecure === true || args.insecure === 'true',
  verbose: args.verbose === true || args.verbose === 'true',
  thumbnails: args['with-thumbnails'] === true || args['with-thumbnails'] === 'true',
  // realVideo: build a valid H.264 mp4 via ffmpeg for each camera at startup,
  // so downstream ffprobe/thumbnail-worker can actually process it. Slower
  // startup + needs ffmpeg on PATH. Default false = cheap magic-byte stub.
  realVideo: args['real-video'] === true || args['real-video'] === 'true',
  clipSeconds: Number(args['clip-seconds'] ?? 60),
  // Resolution and bitrate control the on-wire size of each real-video clip.
  // Default 4K @ 8 Mbps → ~60 MB per 60 s clip, matching a typical Reolink
  // 4K motion recording. Lower resolution / bitrate for smaller pools, higher
  // for more realistic stress.
  resolution: args.resolution ?? '3840x2160',
  bitrate: args.bitrate ?? '8M',
  // poolSize: number of pre-generated clips per camera. With --real-video the
  // worker picks a random clip from the pool for each upload, so the server
  // sees variety without paying the ffmpeg cost on every upload. Default 1.
  poolSize: Number(args['pool-size'] ?? 1),
  // stress: drop the intervalMs sleep between uploads — each camera uploads
  // back-to-back, limited only by curl throughput. Use for load tests.
  stress: args.stress === true || args.stress === 'true',
  // cacheDir: on-disk location for generated real-video clips. Clips are
  // keyed by (resolution, bitrate, clipSeconds, camera, index) so reruns with
  // the same params reuse them. A mismatch in any of those → regenerate.
  cacheDir: args['cache-dir'] ?? join(homedir(), '.cache', 'clipnest-camera-sim'),
  clearCache: args['clear-cache'] === true || args['clear-cache'] === 'true',
  // Per-upload curl `--max-time` cap. Must cover the worst-case transfer:
  // under --stress with many cameras, bandwidth is shared and a 40 MB 4K clip
  // can easily take 60–90 s end-to-end. A too-low cap kills the curl client
  // mid-STOR, leaving the server's data task to finish into S3 but then fail
  // to deliver 226 because the control channel is already gone.
  uploadTimeoutS: Number(args['upload-timeout-s'] ?? 180),
};

if (args.help || args.h) {
  console.log(`Clipnest camera simulator

Options:
  --host HOST               FTPS server hostname       (default: 127.0.0.1)
  --port PORT               FTPS control-channel port  (default: 21)
  --user USER               FTPS username              (default: admin)
  --pass PASS               FTPS password              (read from $FTPS_PASSWORD if unset)
  --cameras N               Number of simulated cameras (default: 3)
  --interval-ms MS          Target upload interval per camera (default: 10000)
  --jitter-pct PCT          Percent jitter around interval (default: 30)
  --file-size-kb KB         Size of each simulated mp4 in KiB (default: 1024)
  --duration-s SEC          Run for SEC seconds, then exit (default: run until Ctrl-C)
  --with-thumbnails         Also upload a .jpg thumbnail per mp4 (default: false)
  --real-video              Use ffmpeg to synthesize a valid H.264 mp4 + JPEG
                            per camera at startup (slower setup, requires
                            ffmpeg). Default: magic-byte stub only, which is
                            enough for upload-path tests but breaks the
                            thumbnail worker because there's no moov atom.
  --clip-seconds SEC        Length of the synthesized H.264 clip (default: 60,
                            matches a typical motion-triggered Reolink clip)
  --resolution WxH          Video resolution (default: 3840x2160 = 4K UHD).
                            Use 1920x1080 / 1280x720 / 640x480 for smaller
                            files if disk/network bandwidth is tight.
  --bitrate B               Target video bitrate (default: 8M). Actual file
                            size ≈ bitrate × clip-seconds / 8. Lower bitrate =
                            smaller file but less realistic stress.
  --pool-size N             With --real-video: synthesize N distinct clips per
                            camera at startup, then pick one at random for each
                            upload. Default: 1. Larger pool = more filesystem
                            variety for deduping/caching stress tests.
  --stress                  Drop the inter-upload sleep; each camera uploads
                            as fast as curl can push. Combine with
                            --real-video --pool-size 5 --cameras 20 for a
                            saturation load test.
  --cache-dir DIR           On-disk cache for generated real-video clips
                            (default: ~/.cache/clipnest-camera-sim). Reruns
                            with the same resolution/bitrate/clip-seconds
                            reuse clips; only the missing N are rebuilt.
  --clear-cache             Wipe the cache before starting. Useful if the
                            disk footprint got out of hand.
  --insecure                Skip TLS cert validation (dev self-signed)
  --upload-timeout-s SEC    curl --max-time per upload (default: 180). Bump
                            higher for 4K --stress runs where a 40 MB clip
                            can share bandwidth with 20+ parallel uploads.
  --verbose                 Dump every curl invocation and its exit code

Env vars (used if matching flag is omitted):
  FTPS_PASSWORD             Used as --pass
  FTPS_USER                 Used as --user
`);
  process.exit(0);
}

if (!opts.pass) opts.pass = process.env.FTPS_PASSWORD ?? '';
if (!args.user && process.env.FTPS_USER) opts.user = process.env.FTPS_USER;
if (!opts.pass) {
  console.error('error: --pass or $FTPS_PASSWORD is required');
  process.exit(2);
}

// ─── Fixture data ───────────────────────────────────────────────────────────

const CAMERA_NAMES = [
  'Backyard', 'Porch', 'Lobby', 'Driveway', 'Garage',
  'SideDoor', 'Garden', 'Patio', 'Hallway', 'Attic',
];

// ─── Stats ──────────────────────────────────────────────────────────────────

const stats = {
  startedAt: Date.now(),
  uploads: 0,
  uploadBytes: 0,
  uploadFailures: 0,
  perCamera: new Map(),
};

function recordUpload(cameraId, bytes) {
  stats.uploads += 1;
  stats.uploadBytes += bytes;
  const c = stats.perCamera.get(cameraId) ?? { uploads: 0, failures: 0, bytes: 0 };
  c.uploads += 1;
  c.bytes += bytes;
  stats.perCamera.set(cameraId, c);
}
function recordUploadFailure(cameraId) {
  stats.uploadFailures += 1;
  const c = stats.perCamera.get(cameraId) ?? { uploads: 0, failures: 0, bytes: 0 };
  c.failures += 1;
  stats.perCamera.set(cameraId, c);
}

function printStats() {
  const elapsedS = (Date.now() - stats.startedAt) / 1000;
  const mb = stats.uploadBytes / 1024 / 1024;
  const mbps = mb / Math.max(elapsedS, 1);
  console.log(
    `[stats] elapsed=${elapsedS.toFixed(0)}s` +
      `  uploads=${stats.uploads} (${mb.toFixed(1)} MiB, ${mbps.toFixed(2)} MiB/s)` +
      `  failures=${stats.uploadFailures}`,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Monotonic YYYYMMDDHHMMSS. In stress mode uploads can fire within the same
// real-world second and would otherwise collide on filename (FILE_REGEX
// groups by CameraName+timestamp). We keep a per-process "last timestamp"
// and bump it by 1 s if we'd otherwise repeat — good enough for stress
// tests and still fits the 14-digit regex.
let _lastTs = 0n;
function timestampNow() {
  let nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec <= _lastTs) nowSec = _lastTs + 1n;
  _lastTs = nowSec;
  const d = new Date(Number(nowSec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jittered(ms, pct) {
  const span = ms * (pct / 100);
  return Math.max(100, ms + (Math.random() - 0.5) * span);
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// Bounded-concurrency version of Promise.all — keeps at most `limit`
// promises running at once. Used for ffmpeg because macOS's
// h264_videotoolbox tops out around 2 concurrent sessions.
async function runWithConcurrency(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

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

// Upload a single file via curl's FTPS (explicit TLS / FTPES).
// `--ftp-create-dirs` creates intermediate /YYYY/MM/DD/ directories, just
// like real Reolink cameras do via successive MKD commands.
function curlUpload(filePath, remotePath) {
  const url = `ftp://${opts.host}:${opts.port}/${remotePath}`;
  // Force TLS 1.2: older curl/OpenSSL versions (e.g. curl 7.68 + OpenSSL
  // 1.1.1 shipped with Ubuntu 20.04) interact badly with our server's
  // rustls TLS 1.3 session resumption on the FTPS data channel — the
  // client's close_notify arrives as a TCP RST on the server's data
  // reader and every upload fails with 451 after the bytes are sent.
  // Pinning to TLS 1.2 (what real Reolink cameras negotiate anyway)
  // avoids the issue without a server-side change.
  const curlArgs = [
    '--silent', '--show-error',
    '--ftp-ssl', '--ftp-pasv', '--ftp-create-dirs',
    '--tls-max', '1.2',
    ...(opts.insecure ? ['--insecure'] : []),
    '--user', `${opts.user}:${opts.pass}`,
    '--upload-file', filePath,
    '--max-time', String(opts.uploadTimeoutS),
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('curl', curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exit=${code} ${stderr.trim() || 'unknown error'}`));
    });
  });
}

// ─── Camera worker ──────────────────────────────────────────────────────────

class CameraWorker {
  constructor(id, name, tmpDir) {
    this.id = id;
    this.name = name;
    this.tmpDir = tmpDir;
    this.stopping = false;
    // Pools of pre-generated real assets (empty when --real-video is off).
    // Worker picks a random entry per upload.
    this.mp4Pool = [];
    this.jpgPool = [];
  }

  /** Register the paths this worker will use. Paths point inside the shared
   *  cache dir (not tmpDir) so clips survive between runs. Tasks are only
   *  returned for files that are NOT already cached — a rerun with the same
   *  params skips generation entirely. */
  planAssets(cacheSubdir) {
    if (!opts.realVideo) return [];
    const tasks = [];
    for (let i = 0; i < opts.poolSize; i += 1) {
      const mp4 = join(cacheSubdir, `${this.name}_${i}.mp4`);
      this.mp4Pool.push(mp4);
      if (!existsSync(mp4)) {
        tasks.push({ kind: 'mp4', label: `${this.name} #${i}`, path: mp4 });
      }
      if (opts.thumbnails) {
        const jpg = join(cacheSubdir, `${this.name}_${i}.jpg`);
        this.jpgPool.push(jpg);
        if (!existsSync(jpg)) {
          tasks.push({ kind: 'jpg', label: `${this.name} #${i}`, path: jpg });
        }
      }
    }
    return tasks;
  }

  pickFromPool(pool) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async uploadClip() {
    const ts = timestampNow();
    const yyyy = ts.slice(0, 4);
    const mm = ts.slice(4, 6);
    const dd = ts.slice(6, 8);
    const dir = `${yyyy}/${mm}/${dd}`;
    const mp4Name = `${this.name}_00_${ts}.mp4`;
    const jpgName = `${this.name}_00_${ts}.jpg`;
    const payloadBytes = opts.fileSizeKb * 1024;

    // Pick source: random clip from the real-video pool, or a per-upload
    // magic-byte stub.
    let mp4Local = this.mp4Pool.length > 0 ? this.pickFromPool(this.mp4Pool) : null;
    let mp4Cleanup = false;
    let mp4Bytes;
    if (!mp4Local) {
      mp4Local = join(this.tmpDir, mp4Name);
      writeFileSync(mp4Local, makePayload(payloadBytes, MP4_MAGIC));
      mp4Cleanup = true;
      mp4Bytes = payloadBytes;
    } else {
      mp4Bytes = fileSize(mp4Local);
    }

    try {
      await curlUpload(mp4Local, `${dir}/${mp4Name}`);
      recordUpload(this.id, mp4Bytes);
      if (opts.verbose) console.log(`[${this.name}] uploaded /${dir}/${mp4Name} (${mp4Bytes} B)`);
    } catch (err) {
      recordUploadFailure(this.id);
      console.error(`[${this.name}] mp4 upload failed: ${err.message}`);
    } finally {
      if (mp4Cleanup) rmSync(mp4Local, { force: true });
    }

    if (opts.thumbnails) {
      let jpgLocal = this.jpgPool.length > 0 ? this.pickFromPool(this.jpgPool) : null;
      let jpgCleanup = false;
      let jpgBytes;
      if (!jpgLocal) {
        jpgBytes = Math.min(payloadBytes, 50 * 1024);
        jpgLocal = join(this.tmpDir, jpgName);
        writeFileSync(jpgLocal, makePayload(jpgBytes, JPG_MAGIC));
        jpgCleanup = true;
      } else {
        jpgBytes = fileSize(jpgLocal);
      }

      try {
        await curlUpload(jpgLocal, `${dir}/${jpgName}`);
        recordUpload(this.id, jpgBytes);
        if (opts.verbose) console.log(`[${this.name}] uploaded /${dir}/${jpgName} (${jpgBytes} B)`);
      } catch (err) {
        recordUploadFailure(this.id);
        console.error(`[${this.name}] jpg upload failed: ${err.message}`);
      } finally {
        if (jpgCleanup) rmSync(jpgLocal, { force: true });
      }
    }
  }

  async run() {
    while (!this.stopping) {
      await this.uploadClip();
      if (this.stopping) break;
      if (!opts.stress) await sleep(jittered(opts.intervalMs, opts.jitterPct));
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function pickCameraName(i) {
  if (i < CAMERA_NAMES.length) return CAMERA_NAMES[i];
  return `Camera${i}`;
}

const workers = [];

async function main() {
  const pace = opts.stress ? 'STRESS (no sleep)' : `${opts.intervalMs}ms±${opts.jitterPct}%`;
  console.log(
    `[sim] target=${opts.host}:${opts.port}` +
      `  user=${opts.user}` +
      `  cameras=${opts.cameras}` +
      `  pace=${pace}` +
      `  mode=${opts.realVideo ? `real-video(pool=${opts.poolSize})` : 'stub'}` +
      (opts.realVideo ? '' : `  file=${opts.fileSizeKb} KiB`) +
      `  insecure=${opts.insecure}` +
      `  duration=${opts.durationS ?? '∞'}s` +
      `  thumbnails=${opts.thumbnails}`,
  );

  // Upload tmp for random-stub mode only (stubs are per-upload ephemeral).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'clipnest-sim-'));
  if (opts.verbose) console.log(`[sim] tmp dir: ${tmpRoot}`);

  for (let i = 0; i < opts.cameras; i += 1) {
    workers.push(new CameraWorker(i, pickCameraName(i), tmpRoot));
  }

  if (opts.realVideo) {
    // Cache key scopes clips by encoder-visible params. Resolution change OR
    // bitrate change OR clip-seconds change → new subdir → regenerate.
    const keySlug = `${opts.resolution}-${opts.bitrate}-${opts.clipSeconds}s`;
    const cacheSubdir = join(opts.cacheDir, keySlug);
    if (opts.clearCache) {
      if (existsSync(opts.cacheDir)) {
        rmSync(opts.cacheDir, { recursive: true, force: true });
        console.log(`[sim] cleared cache ${opts.cacheDir}`);
      }
    }
    mkdirSync(cacheSubdir, { recursive: true });

    // videotoolbox on macOS tops out around 2 concurrent encoder sessions
    // before returning -17691; software encoders handle more but there's no
    // point past CPU count.
    const encoders = await listEncoders();
    const concurrency = encoders.has('h264_videotoolbox') && !encoders.has('libx264')
      ? 2
      : Math.max(2, Math.min(8, workers.length));

    const tasks = workers.flatMap((w) => w.planAssets(cacheSubdir));
    const totalRequested = opts.cameras * opts.poolSize * (opts.thumbnails ? 2 : 1);
    const cached = totalRequested - tasks.length;

    if (tasks.length === 0) {
      console.log(`[sim] cache HIT — all ${totalRequested} clips already in ${cacheSubdir}`);
    } else {
      console.log(
        `[sim] cache: ${cached}/${totalRequested} hit, ${tasks.length} to build ` +
          `(${opts.clipSeconds}s each, ${opts.resolution} @ ${opts.bitrate}, concurrency=${concurrency})…`,
      );
      const t0 = Date.now();
      let done = 0;
      await runWithConcurrency(tasks, concurrency, async (task) => {
        if (task.kind === 'mp4') {
          await ffmpegBuildRealMp4(task.path, task.label, opts.clipSeconds);
        } else {
          await ffmpegBuildRealJpg(task.path, task.label);
        }
        done += 1;
        if (opts.verbose || done % 5 === 0 || done === tasks.length) {
          console.log(`[sim] build ${done}/${tasks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
      });
      const mp4Sz = workers[0].mp4Pool.length ? fileSize(workers[0].mp4Pool[0]) : 0;
      console.log(
        `[sim] pool ready in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `(${(mp4Sz / 1024 / 1024).toFixed(1)} MiB per mp4 clip, cached at ${cacheSubdir})`,
      );
    }
  }

  const statsTimer = setInterval(printStats, 10_000);
  let deadlineTimer = null;
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[sim] stopping (${signal})…`);
    clearInterval(statsTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    workers.forEach((w) => { w.stopping = true; });
    await sleep(1000);
    printStats();
    printPerCameraStats();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  if (opts.durationS) {
    deadlineTimer = setTimeout(() => void stop(`deadline ${opts.durationS}s`), opts.durationS * 1000);
  }

  // Stagger starts by ~500ms so the FTPS server doesn't see a thundering herd
  // of logins (libunftp handles it, but real-world cameras boot at different times).
  const runners = workers.map((w, i) =>
    sleep((i * 500) % 5_000).then(() => w.run()),
  );

  await Promise.allSettled(runners);
}

function printPerCameraStats() {
  const rows = [...stats.perCamera.entries()].map(([id, v]) => ({
    camera: workers[id]?.name ?? `id=${id}`,
    uploads: v.uploads,
    failures: v.failures,
    mib: (v.bytes / 1024 / 1024).toFixed(1),
  }));
  console.log('[per-camera]');
  console.table(rows);
}

main().catch((err) => {
  console.error('[sim] fatal:', err);
  process.exit(1);
});
