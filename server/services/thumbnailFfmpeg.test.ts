import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { story } from '../testing/story.js';

// child_process.spawn returns an EventEmitter-ish object with .stderr stream.
// We construct one for each test so we can drive the close event manually.
class FakeProc extends EventEmitter {
  stderr = new EventEmitter();
}

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

import { runFfmpegFromFile, runFfmpegOnce, streamToSparseFile } from './thumbnailFfmpeg.js';

beforeEach(() => {
  mockSpawn.mockReset();
  vi.restoreAllMocks();
});

function spawnReturning(opts: { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string } = {}): FakeProc {
  const proc = new FakeProc();
  // Schedule the close event after the caller has wired listeners.
  setImmediate(() => {
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0, opts.signal ?? null);
  });
  return proc;
}

describe('runFfmpegOnce', () => {
  it('passes the args verbatim to spawn and forwards exit info', async (ctx) => {
    story(ctx, 'Wrapper na child_process.spawn jest cienki — testujemy że args lecą bez przepisywania, a wynik (kod, signal, stderr) wraca jak z procesu, żeby wyższe warstwy mogły o tym decydować.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 0, stderr: 'hello\n' }));

    const r = await runFfmpegOnce(['-i', '/tmp/x.mp4']);

    expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', ['-i', '/tmp/x.mp4'], expect.objectContaining({ killSignal: 'SIGKILL' }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('hello\n');
  });
});

describe('runFfmpegFromFile — args contract', () => {
  it('uses input-side seek + drops audio + maps only video stream', async (ctx) => {
    story(ctx, 'Trzy zaszyte na sztywno flagi (-ss przed -i, -an, -map 0:v:0) wyszły z incydentów na produzie: HEVC 4K 2s clip z pustym audio track i seek-past-EOF. Test pilnuje, że ich nikt przypadkiem nie wycofa razem z innym refaktorem.');
    let capturedArgs: string[] | null = null;
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return spawnReturning({ code: 0 });
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1234 } as fs.Stats);

    await runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg', '00:00:00.5');

    expect(capturedArgs).not.toBeNull();
    const args = capturedArgs as unknown as string[];
    // -ss MUST come before -i (input-side seek)
    const ssIdx = args.indexOf('-ss');
    const iIdx = args.indexOf('-i');
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(iIdx).toBeGreaterThan(ssIdx);
    expect(args[ssIdx + 1]).toBe('00:00:00.5');
    expect(args[iIdx + 1]).toBe('/tmp/in.mp4');
    expect(args).toContain('-an');
    expect(args.slice(args.indexOf('-map')).slice(0, 2)).toEqual(['-map', '0:v:0']);
  });

  it('returns successfully when ffmpeg writes output', async (ctx) => {
    story(ctx, 'Happy path: ffmpeg wypluł niepusty plik → orchestrator wgrywa miniaturkę do S3 bez retry.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 0, stderr: 'Duration: 00:00:02.50, ' }));
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 27_000 } as fs.Stats);

    const r = await runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg');

    expect(r.exhausted).toBe(false);
    expect(r.durationSec).toBeCloseTo(2.5);
  });

  it('parses Duration even when frame extraction fails', async (ctx) => {
    story(ctx, 'Duration leci na stderr od razu po przeczytaniu nagłówka MP4 — chcemy złapać go w trybie `events.duration`, nawet kiedy seek nie udał się i zwracamy błąd. Caller odczyta `err.durationSec`.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 234, stderr: 'Duration: 00:00:01.98, ...\nNothing was written\n' }));

    let captured: any = null;
    try { await runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg'); }
    catch (e) { captured = e; }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as { durationSec?: number }).durationSec).toBeCloseTo(1.98);
  });

  it('throws when rc=0 but the output file is missing or zero-byte', async (ctx) => {
    story(ctx, 'Klucz fix v0.8.31: ffmpeg potrafi zwrócić kod 0 i nic nie zapisać (HEVC 4K 2s, seek za EOF). Sam exit code nie wystarcza — sprawdzamy rozmiar pliku, żeby wyższa warstwa mogła zretryowac z innym seekiem.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 0, stderr: '' }));
    // simulate missing file
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });

    await expect(runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg')).rejects.toThrow(/no output/);
  });

  it('throws when rc=0 but the output is zero-byte', async (ctx) => {
    story(ctx, 'Niektóre wersje ffmpeg tworzą pusty plik wynikowy zamiast go nie tworzyć w ogóle — testujemy że pusty plik liczy się tak samo jak brakujący.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 0 }));
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0 } as fs.Stats);

    await expect(runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg')).rejects.toThrow(/no output/);
  });

  it('throws on non-zero exit so the caller can fall back to a different seek', async (ctx) => {
    story(ctx, 'Niezerowy exit od ffmpeg = sygnał do retry. Caller (orchestrator) łapie błąd i odpala drugą próbę z `-ss 0`.');
    mockSpawn.mockImplementation(() => spawnReturning({ code: 234, stderr: 'fatal\n' }));

    await expect(runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg')).rejects.toThrow(/code 234/);
  });

  it('throws a "timed out" error when the process is SIGKILLed', async (ctx) => {
    story(ctx, 'Timeout jest twardy: SIGKILL po 60s. Komunikat jest rozpoznawalny dla dispatch logiki, żeby nie liczyło się jako "zwykły" failure (wymaga osobnej obsługi przez orchestrator).');
    mockSpawn.mockImplementation(() => spawnReturning({ code: null, signal: 'SIGKILL' }));

    await expect(runFfmpegFromFile('/tmp/in.mp4', '/tmp/out.jpg')).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// streamToSparseFile — Range-GET fetch helper for the thumbnail worker
// ---------------------------------------------------------------------------

describe('streamToSparseFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-test-'));
  });

  it('first call allocates a sparse file of totalSize and writes head bytes at offset 0', async (ctx) => {
    story(ctx, 'Phase 1 oszczędności CPU dla thumbnail workera: zamiast pobrać 30 MB mp4 do /tmp i wyrzucić 99% bajtów, ściągamy tylko head=4MB do sparse-pliku rozmiaru pełnego mp4. ffmpeg-owi to wystarcza do thumbnaila bo Reolink-i mają moov-at-front.');
    const filePath = path.join(tmpDir, 'sparse.bin');
    const headBuf = Buffer.from('FAKE_MP4_HEAD_BYTES_PRETENDING_TO_BE_FTYP');
    const totalSize = 50 * 1024 * 1024;   // 50 MB logical, but only ~40 B written

    await streamToSparseFile(Readable.from(headBuf), filePath, totalSize, 0);

    const st = fs.statSync(filePath);
    expect(st.size).toBe(totalSize);   // logical size = full mp4 size
    const written = fs.readFileSync(filePath);
    expect(written.subarray(0, headBuf.length).equals(headBuf)).toBe(true);
    // Beyond the head, bytes are zero (sparse).
    expect(written.subarray(headBuf.length, headBuf.length + 16).every(b => b === 0)).toBe(true);
  });

  it('second call writes tail bytes at the requested offset without truncating the file', async (ctx) => {
    story(ctx, 'Eskalacja head→head+tail: po nieudanym head-stage worker dorzuca tail bytes na koniec sparse-pliku. Helper nie może retruncate-ować, bo head bytes w środku/na początku już są zapisane od poprzedniego wywołania.');
    const filePath = path.join(tmpDir, 'sparse.bin');
    const totalSize = 1_000_000;
    const headBuf = Buffer.alloc(64, 0xAA);
    const tailBuf = Buffer.alloc(64, 0xBB);
    const tailOffset = totalSize - tailBuf.length;

    await streamToSparseFile(Readable.from(headBuf), filePath, totalSize, 0);
    await streamToSparseFile(Readable.from(tailBuf), filePath, totalSize, tailOffset);

    const st = fs.statSync(filePath);
    expect(st.size).toBe(totalSize);
    // Verify head bytes still in place (second call must not have re-truncated).
    const fd = fs.openSync(filePath, 'r');
    try {
      const headRead = Buffer.alloc(headBuf.length);
      fs.readSync(fd, headRead, 0, headBuf.length, 0);
      expect(headRead.equals(headBuf)).toBe(true);
      const tailRead = Buffer.alloc(tailBuf.length);
      fs.readSync(fd, tailRead, 0, tailBuf.length, tailOffset);
      expect(tailRead.equals(tailBuf)).toBe(true);
      // Sample a byte in the middle — should still be zero.
      const mid = Buffer.alloc(1);
      fs.readSync(fd, mid, 0, 1, totalSize / 2);
      expect(mid[0]).toBe(0);
    } finally {
      fs.closeSync(fd);
    }
  });
});
