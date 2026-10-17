import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const { mockListMultipartUploads, mockAbortMultipartUpload } = vi.hoisted(() => ({
  mockListMultipartUploads: vi.fn(),
  mockAbortMultipartUpload: vi.fn(),
}));

vi.mock('./s3.js', () => ({
  listMultipartUploads: (...args: unknown[]) => mockListMultipartUploads(...args),
  abortMultipartUpload: (...args: unknown[]) => mockAbortMultipartUpload(...args),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
  },
}));

import { abortStaleMultipartUploads } from './multipartCleanup.js';

const HOUR = 3600_000;
const NOW = 1_900_000_000_000; // fixed reference

describe('abortStaleMultipartUploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLIPNEST_MPU_ABORT_AGE_HOURS;
    mockAbortMultipartUpload.mockResolvedValue(undefined);
  });

  it('aborts uploads older than the threshold and skips fresh ones, across all buckets', async (ctx) => {
    story(ctx, 'Niedokończone multipart uploady zajmują miejsce w buckecie niewidoczne dla ListObjectsV2, a magazyn obiektów może nie mieć lifecycle rules. Sweep abortuje te starsze niż próg (domyślnie 24h), a pomija świeże (możliwy upload w locie). Działa na wszystkich 3 bucketach.');
    mockListMultipartUploads.mockImplementation(async (bucket: string) => {
      if (bucket === 'recordings') return [
        { key: 'u/old.mp4', uploadId: 'A', initiated: new Date(NOW - 48 * HOUR) },
        { key: 'u/fresh.mp4', uploadId: 'B', initiated: new Date(NOW - 1 * HOUR) },
      ];
      if (bucket === 'sidecars') return [
        { key: 'u/old.mp4.frames', uploadId: 'C', initiated: new Date(NOW - 100 * HOUR) },
      ];
      return [];
    });

    const res = await abortStaleMultipartUploads(NOW);

    expect(res).toEqual({ aborted: 2, failed: 0 });
    expect(mockAbortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(mockAbortMultipartUpload).toHaveBeenCalledWith('recordings', 'u/old.mp4', 'A');
    expect(mockAbortMultipartUpload).toHaveBeenCalledWith('sidecars', 'u/old.mp4.frames', 'C');
    // the fresh one is never aborted
    expect(mockAbortMultipartUpload).not.toHaveBeenCalledWith('recordings', 'u/fresh.mp4', 'B');
  });

  it('honours CLIPNEST_MPU_ABORT_AGE_HOURS override', async (ctx) => {
    story(ctx, 'Próg jest konfigurowalny przez env (godziny). Przy 1h upload sprzed 2h jest abortowany, sprzed 30min — pomijany.');
    process.env.CLIPNEST_MPU_ABORT_AGE_HOURS = '1';
    mockListMultipartUploads.mockImplementation(async (bucket: string) =>
      bucket === 'recordings'
        ? [
            { key: 'u/2h.mp4', uploadId: 'A', initiated: new Date(NOW - 2 * HOUR) },
            { key: 'u/30m.mp4', uploadId: 'B', initiated: new Date(NOW - 0.5 * HOUR) },
          ]
        : [],
    );

    const res = await abortStaleMultipartUploads(NOW);

    expect(res.aborted).toBe(1);
    expect(mockAbortMultipartUpload).toHaveBeenCalledExactlyOnceWith('recordings', 'u/2h.mp4', 'A');
  });

  it('counts abort failures without throwing and keeps going', async (ctx) => {
    story(ctx, 'Błąd abortu jednego uploadu (transient S3) nie przerywa sweepu ani audytu — jest liczony jako failed i logowany, reszta leci dalej.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListMultipartUploads.mockImplementation(async (bucket: string) =>
      bucket === 'recordings'
        ? [
            { key: 'u/a.mp4', uploadId: 'A', initiated: new Date(NOW - 48 * HOUR) },
            { key: 'u/b.mp4', uploadId: 'B', initiated: new Date(NOW - 48 * HOUR) },
          ]
        : [],
    );
    mockAbortMultipartUpload
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('S3 transient'));

    const res = await abortStaleMultipartUploads(NOW);

    expect(res).toEqual({ aborted: 1, failed: 1 });
    expect(mockAbortMultipartUpload).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a list error for one bucket does not abort the whole sweep', async (ctx) => {
    story(ctx, 'Jeśli ListMultipartUploads padnie dla jednego bucketa, sweep loguje błąd i przechodzi do kolejnych bucketów — best-effort, nigdy nie wywala audytu.');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListMultipartUploads.mockImplementation(async (bucket: string) => {
      if (bucket === 'recordings') throw new Error('list boom');
      if (bucket === 'sidecars') return [{ key: 'u/x.mp4.fmp4patch', uploadId: 'Z', initiated: new Date(NOW - 72 * HOUR) }];
      return [];
    });

    const res = await abortStaleMultipartUploads(NOW);

    expect(res).toEqual({ aborted: 1, failed: 0 });
    expect(mockAbortMultipartUpload).toHaveBeenCalledExactlyOnceWith('sidecars', 'u/x.mp4.fmp4patch', 'Z');
    err.mockRestore();
  });
});
