import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { story } from '../testing/story.js';

vi.mock('../config.js', () => ({ CONFIG: { s3SidecarsBucket: 'sidecars' } }));
vi.mock('./s3.js', () => ({ getObject: vi.fn() }));

import { getObject } from './s3.js';
import { packCleanFrameSidecar } from './mp4/cleanFrameSidecar.js';
import { cleanFrameSidecarCache } from './cleanFrameSidecarCache.js';
import { loadCleanFrameSidecar, isS3NotFound } from './cleanFrameLoad.js';
import { installMetricsRecorder, noopRecorder } from '../utils/metrics.js';

const SALT = 'salt-aaa';
const WARMUP_RANGE = 'bytes=0-15';

/** The packed bytes of a tiny, valid sidecar. */
function blob(tag = 'x'): Buffer {
  return packCleanFrameSidecar({
    prelude: Buffer.from(`prelude-${tag}`),
    mdatHeader: Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]),
    byteRanges: [{ srcOffset: 100, length: 100 }],
    frameGrid: [0, 0.04],
  });
}

type Reply = () => Promise<{ body: Readable; contentRange: undefined }>;
const sidecarBody = (tag?: string): Reply => async () => ({ body: Readable.from([blob(tag)]), contentRange: undefined });
const sixteenBytes: Reply = async () => ({ body: Readable.from([Buffer.alloc(16)]), contentRange: undefined });
const notFound = () => Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
const transient = (msg = 'S3 503') => Object.assign(new Error(msg), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
const failing = (err: Error): Reply => async () => { throw err; };

/** What the object store answers: the sidecar fetches in order (the last step repeats), and `touch` for the 16-byte read of the original. */
function stubS3(sidecar: Reply[], touch: Reply = sixteenBytes): void {
  let i = 0;
  vi.mocked(getObject).mockImplementation(async (bucket: string) =>
    bucket === 'sidecars' ? sidecar[Math.min(i++, sidecar.length - 1)]() : touch(),
  );
}

const sidecarFetches = () => vi.mocked(getObject).mock.calls.filter(([bucket]) => bucket === 'sidecars');
const warmups = () => vi.mocked(getObject).mock.calls.filter(([bucket, , , range]) => bucket !== 'sidecars' && range === WARMUP_RANGE);

beforeEach(() => {
  vi.mocked(getObject).mockReset();
  cleanFrameSidecarCache.clear();
});
afterEach(() => { vi.useRealTimers(); installMetricsRecorder(undefined); });

describe('loadCleanFrameSidecar', () => {
  it('fetches the sidecar once and serves repeats from the cache', async (ctx) => {
    story(ctx, 'Każde żądanie ?fmt=clean (HEAD i każdy Range GET) potrzebuje sidecara. Po pierwszym pobraniu kolejne nie powinny już dotykać magazynu, ani po sidecar, ani po rozgrzewkę oryginału.');
    stubS3([sidecarBody('a')]);
    const first = await loadCleanFrameSidecar('recordings', 'uuid/2026/01/01/a.mp4', SALT);
    const second = await loadCleanFrameSidecar('recordings', 'uuid/2026/01/01/a.mp4', SALT);
    expect(second).toBe(first);
    expect(first.prelude.toString()).toBe('prelude-a');
    expect(sidecarFetches()).toHaveLength(1);
    expect(sidecarFetches()[0]).toEqual(['sidecars', 'uuid/2026/01/01/a.mp4.clean_frame', SALT]);
    expect(warmups()).toHaveLength(1);
  });

  it('keeps recordings apart', async (ctx) => {
    story(ctx, 'Dwa nagrania to dwa osobne wpisy: cache nie może pomylić klipów, bo odtwarzacz zszyłby wtedy plik według cudzej receptury.');
    vi.mocked(getObject).mockImplementation(async (bucket: string, key: string) =>
      bucket === 'sidecars' ? sidecarBody(key.includes('a.mp4') ? 'a' : 'b')() : sixteenBytes(),
    );
    const a = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    const b = await loadCleanFrameSidecar('recordings', 'uuid/b.mp4', SALT);
    expect(a.prelude.toString()).toBe('prelude-a');
    expect(b.prelude.toString()).toBe('prelude-b');
    expect(sidecarFetches()).toHaveLength(2);
  });

  it('throws a permanent miss as not-found, without retrying and without caching it', async (ctx) => {
    story(ctx, 'Brak sidecara to stan trwały: trasa schodzi wtedy na ścieżkę bez clean i musi robić to konsekwentnie. Cache nie może zapamiętać „braku", bo sidecar, który pojawi się chwilę później, ma zostać podchwycony przez następne żądanie.');
    stubS3([failing(notFound())]);
    const err = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT).catch((e) => e);
    expect(isS3NotFound(err)).toBe(true);
    expect(sidecarFetches()).toHaveLength(1); // not retried

    stubS3([sidecarBody('late')]);
    const later = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    expect(later.prelude.toString()).toBe('prelude-late'); // the miss was not remembered
  });

  it('reports a recording without a sidecar as absent, and one with a sidecar as a miss and then a hit', async (ctx) => {
    story(ctx, 'Licznik cache\'u ma odróżniać trzy rzeczy: odpowiedź z pamięci (hit), odczyt sidecara z magazynu (miss) i nagranie, które sidecara nie ma (absent). Dopiero wtedy hit / (hit + miss) mówi, czy cache działa, i nie psują go klipy, których cache w ogóle nie dotyczy.');
    const seen: string[] = [];
    installMetricsRecorder({ ...noopRecorder, recordCleanSidecarCache: (r) => { seen.push(r); } });

    stubS3([failing(notFound())]);
    await loadCleanFrameSidecar('recordings', 'uuid/none.mp4', SALT).catch(() => undefined);
    await loadCleanFrameSidecar('recordings', 'uuid/none.mp4', SALT).catch(() => undefined);
    expect(seen).toEqual(['absent', 'absent']); // never remembered, so it is asked again

    stubS3([sidecarBody('a')]);
    await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    expect(seen).toEqual(['absent', 'absent', 'miss', 'hit']);
  });

  it('retries a transient failure and caches the eventual success', async (ctx) => {
    story(ctx, 'Bucket z sidecarami czasem odpowiada 503. Dwie nieudane próby i trzecia udana mają dać wynik, a ten wynik ma być już w cache.');
    vi.useFakeTimers();
    stubS3([failing(transient()), failing(transient()), sidecarBody('ok')]);
    const pending = loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    await vi.advanceTimersByTimeAsync(1000);
    const got = await pending;
    expect(got.prelude.toString()).toBe('prelude-ok');
    expect(sidecarFetches()).toHaveLength(3);
    await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    expect(sidecarFetches()).toHaveLength(3); // served from the cache
  });

  it('gives up after three transient failures, throws the last one and caches nothing', async (ctx) => {
    story(ctx, 'Gdy magazyn nie wstaje, trasa dostaje błąd (i oddaje klientowi 503 z Retry-After), a nie podstawiony plik o złym rozmiarze. Błąd nie może zostać w cache.');
    vi.useFakeTimers();
    stubS3([failing(transient('one')), failing(transient('two')), failing(transient('three'))]);
    const outcome = loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await outcome;
    expect((err as Error).message).toBe('three');
    expect(isS3NotFound(err)).toBe(false);
    expect(sidecarFetches()).toHaveLength(3);

    stubS3([sidecarBody('recovered')]);
    const again = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    expect(again.prelude.toString()).toBe('prelude-recovered');
  });

  it('shares one fetch, and one warm-up, between concurrent requests for the same recording', async (ctx) => {
    story(ctx, 'Kilku widzów, którzy otwierają ten sam świeży klip naraz, powoduje jedno pobranie sidecara i jedną rozgrzewkę oryginału, a nie kilka.');
    stubS3([sidecarBody('shared')]);
    const results = await Promise.all([
      loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT),
      loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT),
      loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(sidecarFetches()).toHaveLength(1);
    expect(warmups()).toHaveLength(1);
  });
});

describe('warming the original', () => {
  it('reads 16 bytes of the original at the same time as it fetches the sidecar', async (ctx) => {
    story(ctx, 'Na zdalnym magazynie pierwszy odczyt obiektu jest wolny (0,3-0,5 s), a kolejny szybki. Trasa potrzebuje sidecara, a dopiero potem czyta dane, więc dwa zimne odczyty szły jeden po drugim. Rozgrzewka oryginału startuje razem z sidecarem, więc się nakładają.');
    let releaseSidecar!: () => void;
    let releaseTouch!: () => void;
    vi.mocked(getObject).mockImplementation(async (bucket: string) => {
      if (bucket === 'sidecars') { await new Promise<void>((r) => { releaseSidecar = r; }); return sidecarBody('x')(); }
      await new Promise<void>((r) => { releaseTouch = r; });
      return sixteenBytes();
    });
    const pending = loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    // Both requests are in flight before either has answered.
    expect(sidecarFetches()).toHaveLength(1);
    expect(warmups()).toHaveLength(1);
    expect(warmups()[0]).toEqual(['recordings', 'uuid/a.mp4', SALT, WARMUP_RANGE]);
    releaseSidecar();
    releaseTouch();
    const got = await pending;
    expect(got.prelude.toString()).toBe('prelude-x');
  });

  it('never fails the load when the warm-up fails', async (ctx) => {
    story(ctx, 'Rozgrzewka to optymalizacja: jej błąd (timeout, 503) nie może zepsuć odtwarzania, bo sidecar i tak przyszedł.');
    stubS3([sidecarBody('ok')], failing(transient('warm-up blew up')));
    const got = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT);
    expect(got.prelude.toString()).toBe('prelude-ok');
  });

  it('does not wait longer than the cap for a slow warm-up', async (ctx) => {
    story(ctx, 'Zawieszona rozgrzewka nie może wstrzymać odtwarzania w nieskończoność: najwyżej 1,5 s, potem klient dostaje to, co ma.');
    vi.useFakeTimers();
    stubS3([sidecarBody('ok')], () => new Promise(() => { /* never answers */ }));
    let done = false;
    const pending = loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT).then((v) => { done = true; return v; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await pending).prelude.toString()).toBe('prelude-ok');
  });

  it('does not make a missing sidecar wait for the warm-up', async (ctx) => {
    story(ctx, 'Plik bez sidecara schodzi od razu na ścieżkę bez clean. Nie czeka na rozgrzewkę, której i tak nikt nie potrzebuje.');
    vi.useFakeTimers(); // a wait on the warm-up would need a timer to be advanced; nothing is
    stubS3([failing(notFound())], () => new Promise(() => { /* never answers */ }));
    const err = await loadCleanFrameSidecar('recordings', 'uuid/a.mp4', SALT).catch((e) => e);
    expect(isS3NotFound(err)).toBe(true);
  });

  it('does not warm anything when CLEAN_FRAME_WARM_CAP_MS is 0', async (ctx) => {
    story(ctx, 'CLEAN_FRAME_WARM_CAP_MS=0 wyłącza rozgrzewkę bez wdrożenia: zostaje samo pobranie sidecara.');
    vi.resetModules();
    process.env.CLEAN_FRAME_WARM_CAP_MS = '0';
    try {
      const s3 = await import('./s3.js');
      const { loadCleanFrameSidecar: load } = await import('./cleanFrameLoad.js');
      vi.mocked(s3.getObject).mockImplementation(async () => ({ body: Readable.from([blob('x')]), contentRange: undefined }));
      await load('recordings', 'uuid/a.mp4', SALT);
      expect(vi.mocked(s3.getObject)).toHaveBeenCalledTimes(1); // the sidecar only
    } finally {
      delete process.env.CLEAN_FRAME_WARM_CAP_MS;
      vi.resetModules();
    }
  });
});

describe('isS3NotFound', () => {
  it('recognises the shapes the S3 client throws for a missing key', (ctx) => {
    story(ctx, 'Rozróżnienie „brak klucza" od „chwilowy błąd" decyduje, czy trasa spada na ścieżkę bez clean, czy oddaje 503. Pomyłka w którąkolwiek stronę psuje odtwarzanie.');
    expect(isS3NotFound(notFound())).toBe(true);
    expect(isS3NotFound({ Code: 'NoSuchKey' })).toBe(true);
    expect(isS3NotFound(new Error('Request failed with status code: 404'))).toBe(true);
    expect(isS3NotFound(transient())).toBe(false);
    expect(isS3NotFound(new Error('socket hang up'))).toBe(false);
  });
});
