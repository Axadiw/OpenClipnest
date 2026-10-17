import fs from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/** Stream an S3 body into a file. `pipeline` releases the AWS SDK keep-alive socket on error so the connection pool doesn't wedge. */
export async function pipelineToFile(body: Readable, outputPath: string): Promise<void> {
  await pipeline(body, fs.createWriteStream(outputPath));
}

/**
 * Write a partial S3 body into a sparse file at `offset`. First call allocates
 * `totalSize` via ftruncate; later calls write at the given offset without
 * re-truncating, so head + tail can be seeded incrementally. ffmpeg's MP4
 * demuxer only follows box pointers so sparse zeros between ranges are invisible.
 */
export async function streamToSparseFile(
  body: Readable,
  outputPath: string,
  totalSize: number,
  offset: number,
): Promise<void> {
  if (!fs.existsSync(outputPath)) {
    const fd = fs.openSync(outputPath, 'w');
    try { fs.ftruncateSync(fd, totalSize); }
    finally { fs.closeSync(fd); }
  }
  await pipeline(body, fs.createWriteStream(outputPath, { flags: 'r+', start: offset }));
}

/** Buffer an entire (bounded) stream into memory. */
export async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += b.length;
    if (total > maxBytes) throw new Error(`streamToBuffer: stream exceeded maxBytes=${maxBytes}`);
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Seed a sparse file with an in-memory head buffer (ftruncate to full size,
 * write the head at offset 0). The Buffer counterpart of streamToSparseFile —
 * used when the head bytes are already held in memory (head-fetch dedup), so
 * ffmpeg's MP4 demuxer follows box pointers over the sparse zeros as usual.
 */
export function seedSparseFromBuffer(outputPath: string, totalSize: number, head: Buffer): void {
  const fd = fs.openSync(outputPath, 'w');
  try {
    fs.ftruncateSync(fd, totalSize);
    fs.writeSync(fd, head, 0, Math.min(head.length, totalSize), 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Spawn ffmpeg once with the given args (file-input only). Exposed for tests. */
export function runFfmpegOnce(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Hard 60s cap so a malformed MP4 cannot stall the sequential pipeline.
    // SIGKILL because SIGTERM is not guaranteed to take effect.
    const proc = spawn('ffmpeg', args, { timeout: 60_000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code, signal) => resolve({ code, signal, stderr }));
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Extract one JPG frame near `seek` from a local MP4. File input (not piped
 * stdin) is required for HEVC 4K so the decoder can seek back over moov / NAL
 * splits. Duration is parsed from stderr regardless of frame-extraction success,
 * so even a failed first attempt can still update `events.duration`. If ffmpeg
 * exits 0 but writes no output (seek past a single camera-boot keyframe at t=0)
 * throws so the caller can retry from zero.
 */
export function runFfmpegFromFile(
  inputPath: string,
  output: string,
  seek = '00:00:00.5',
): Promise<{ durationSec: number | null; exhausted: boolean; lastStderr: string }> {
  return (async () => {
    const args = [
      '-ss', seek,
      '-i', inputPath,
      '-an',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', 'scale=480:-1',
      '-q:v', '6',
      '-y', output,
    ];
    const { code, signal, stderr } = await runFfmpegOnce(args);

    if (signal === 'SIGKILL') {
      throw new Error('ffmpeg timed out after 60s and was killed');
    }

    const match = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderr);
    let durationSec: number | null = null;
    if (match) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const s = parseFloat(match[3]);
      const computed = h * 3600 + m * 60 + s;
      if (computed > 0) durationSec = computed;
    }

    if (code === 0) {
      let produced = 0;
      try { produced = fs.statSync(output).size; } catch { /* missing */ }
      if (produced > 0) {
        return { durationSec, exhausted: false, lastStderr: stderr };
      }
      const err = new Error(`ffmpeg exited 0 but produced no output: ${stderr.slice(-300)}`) as Error & { durationSec?: number | null };
      err.durationSec = durationSec;
      throw err;
    }
    if (code !== null) {
      const err = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`) as Error & { durationSec?: number | null };
      err.durationSec = durationSec;
      throw err;
    }
    return { durationSec, exhausted: true, lastStderr: stderr };
  })();
}
