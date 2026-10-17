import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { Buffer } from 'buffer';
import { story } from '../testing/story.js';

// ---------------------------------------------------------------------------
// Hoisted mock factories — must come before any vi.mock() call.
// ---------------------------------------------------------------------------
const mockGetViewsMissingFrameRate = vi.fn();
const mockUpdateEventViewFrameRate = vi.fn();
const mockGetObject = vi.fn();
const mockHeadObject = vi.fn();
const mockIndexFragmentedMp4 = vi.fn();

vi.mock('../db/queries/events.js', () => ({
  getViewsMissingFrameRate: (...a: unknown[]) => mockGetViewsMissingFrameRate(...a),
  updateEventViewFrameRate: (...a: unknown[]) => mockUpdateEventViewFrameRate(...a),
}));

vi.mock('./s3.js', () => ({
  getObject: (...a: unknown[]) => mockGetObject(...a),
  headObject: (...a: unknown[]) => mockHeadObject(...a),
}));

vi.mock('./mp4/fragmentIndex.js', () => ({
  indexFragmentedMp4: (...a: unknown[]) => mockIndexFragmentedMp4(...a),
}));

// frameRateFromIndex is exported from sidecarBuilder; mock it to isolate the
// reconciler's plumbing from the MP4 parse layer.
const mockFrameRateFromIndex = vi.fn();
vi.mock('./mp4/sidecarBuilder.js', () => ({
  frameRateFromIndex: (...a: unknown[]) => mockFrameRateFromIndex(...a),
}));

import { backfillFrameRates } from './reconcilers.js';

/** Build a Readable stream that emits a single Buffer chunk. */
function streamOf(buf: Buffer): Readable {
  return Readable.from([buf]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEventViewFrameRate.mockResolvedValue(undefined);
  mockHeadObject.mockResolvedValue({ contentLength: 1024 * 1024, lastModified: new Date() });
  mockGetObject.mockResolvedValue({ body: streamOf(Buffer.alloc(256)) });
});

describe('backfillFrameRates', () => {
  it('indexes the ORIGINAL recording (not the sidecar) and writes the computed fps', async (ctx) => {
    story(ctx, 'Główna ścieżka backfillu: reconciler robi HEAD + GET na ORYGINALNYM pliku nagrania (nie sidecara), wywołuje indexFragmentedMp4 by policzyć prawdziwe sample-counts, potem frameRateFromIndex → zapis do DB. Tak unika błędu ×10 z trex.default_sample_duration.');

    const row = {
      eventId: 'evt-1',
      ownerId: 7,
      videoRelPath: 'cam1/clip.mp4',
      s3Key: 'uuid123/cam1/clip.mp4',
      encryptionSalt: 'salt-abc',
    };
    mockGetViewsMissingFrameRate.mockResolvedValue([row]);
    mockHeadObject.mockResolvedValue({ contentLength: 2 * 1024 * 1024, lastModified: new Date() });
    mockIndexFragmentedMp4.mockResolvedValue({});
    mockFrameRateFromIndex.mockReturnValue(14.93);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backfillFrameRates();
    logSpy.mockRestore();

    // Must HEAD the recordings bucket for the original file
    expect(mockHeadObject).toHaveBeenCalledWith(
      expect.stringContaining('recording'),
      'uuid123/cam1/clip.mp4',
      'salt-abc',
    );
    // Must GET the original file head window
    expect(mockGetObject).toHaveBeenCalledWith(
      expect.stringContaining('recording'),
      'uuid123/cam1/clip.mp4',
      'salt-abc',
      expect.stringMatching(/^bytes=0-/),
    );
    // indexFragmentedMp4 was called with the head buffer and file size
    expect(mockIndexFragmentedMp4).toHaveBeenCalledTimes(1);
    // fps from frameRateFromIndex should be written
    expect(mockUpdateEventViewFrameRate).toHaveBeenCalledWith('evt-1', 7, 'cam1/clip.mp4', 14.93);
  });

  it('writes sentinel -1 when frameRateFromIndex returns null (VFR with zero duration or bad moov)', async (ctx) => {
    story(ctx, 'Gdy frameRateFromIndex zwraca null (np. totalSeconds=0 albo brak próbek), reconciler zapisuje sentinel -1, żeby wiersz nie wracał do kolejki w kolejnych przebiegach.');

    const row = {
      eventId: 'evt-2',
      ownerId: 8,
      videoRelPath: 'cam1/clip2.mp4',
      s3Key: 'uuid456/cam1/clip2.mp4',
      encryptionSalt: null,
    };
    mockGetViewsMissingFrameRate.mockResolvedValue([row]);
    mockIndexFragmentedMp4.mockResolvedValue({});
    mockFrameRateFromIndex.mockReturnValue(null);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backfillFrameRates();
    logSpy.mockRestore();

    expect(mockUpdateEventViewFrameRate).toHaveBeenCalledTimes(1);
    const [eventId, , , fps] = mockUpdateEventViewFrameRate.mock.calls[0];
    expect(eventId).toBe('evt-2');
    expect(fps).toBe(-1);
  });

  it('skips the row (no updateEventViewFrameRate call) when headObject throws', async (ctx) => {
    story(ctx, 'Błąd HEAD (np. NoSuchKey lub transient S3) nie tombstonuje wiersza — frame_rate zostaje NULL żeby retry nastąpił w następnym przebiegu. Kolejny wiersz w batchu wciąż jest przetwarzany.');

    const rowFailing = {
      eventId: 'evt-fail',
      ownerId: 9,
      videoRelPath: 'cam1/fail.mp4',
      s3Key: 'uuid789/cam1/fail.mp4',
      encryptionSalt: 'salt-xyz',
    };
    const rowOk = {
      eventId: 'evt-ok',
      ownerId: 9,
      videoRelPath: 'cam1/ok.mp4',
      s3Key: 'uuid789/cam1/ok.mp4',
      encryptionSalt: 'salt-xyz',
    };
    mockGetViewsMissingFrameRate.mockResolvedValue([rowFailing, rowOk]);

    mockHeadObject
      .mockRejectedValueOnce(new Error('S3 NoSuchKey'))
      .mockResolvedValueOnce({ contentLength: 512 * 1024, lastModified: new Date() });
    mockIndexFragmentedMp4.mockResolvedValue({});
    mockFrameRateFromIndex.mockReturnValue(15.0);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backfillFrameRates();
    logSpy.mockRestore();

    // Only the second row (evt-ok) should have been written
    expect(mockUpdateEventViewFrameRate).toHaveBeenCalledTimes(1);
    const [eventId] = mockUpdateEventViewFrameRate.mock.calls[0];
    expect(eventId).toBe('evt-ok');
  });

  it('skips the row when getObject (original fetch) throws', async (ctx) => {
    story(ctx, 'Błąd GET na oryginalnym pliku — np. transient network. Wiersz pozostaje niezmieniony, retry w następnym przebiegu.');

    const row = {
      eventId: 'evt-getfail',
      ownerId: 10,
      videoRelPath: 'cam2/clip.mp4',
      s3Key: 'uuidABC/cam2/clip.mp4',
      encryptionSalt: 'salt-def',
    };
    mockGetViewsMissingFrameRate.mockResolvedValue([row]);
    mockGetObject.mockRejectedValueOnce(new Error('S3 transient'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backfillFrameRates();
    logSpy.mockRestore();

    expect(mockUpdateEventViewFrameRate).not.toHaveBeenCalled();
  });

  it('no-op when query returns an empty batch', async (ctx) => {
    story(ctx, 'Gdy wszystkie wiersze mają już poprawny frame_rate, query zwraca pustą listę i reconciler kończy się bez żadnego zapisu — samogasząca się pętla.');

    mockGetViewsMissingFrameRate.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backfillFrameRates();
    logSpy.mockRestore();

    expect(mockHeadObject).not.toHaveBeenCalled();
    expect(mockGetObject).not.toHaveBeenCalled();
    expect(mockUpdateEventViewFrameRate).not.toHaveBeenCalled();
    // No log line either (early return)
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('passes includeWrong=true to the query when CLIPNEST_REFRESH_FRAME_RATES=true', async (ctx) => {
    story(ctx, 'Env-gated re-backfill: gdy CLIPNEST_REFRESH_FRAME_RATES=true, reconciler przekazuje includeWrong=true do getViewsMissingFrameRate, żeby objąć też wiersze z błędnym frame_rate > 121 (stary ×10 artefakt z trex).');

    const origEnv = process.env.CLIPNEST_REFRESH_FRAME_RATES;
    process.env.CLIPNEST_REFRESH_FRAME_RATES = 'true';
    mockGetViewsMissingFrameRate.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await backfillFrameRates();
    } finally {
      if (origEnv === undefined) delete process.env.CLIPNEST_REFRESH_FRAME_RATES;
      else process.env.CLIPNEST_REFRESH_FRAME_RATES = origEnv;
      logSpy.mockRestore();
    }

    expect(mockGetViewsMissingFrameRate).toHaveBeenCalledWith(
      expect.any(Number),
      true,
    );
  });

  it('passes includeWrong=false when CLIPNEST_REFRESH_FRAME_RATES is unset', async (ctx) => {
    story(ctx, 'Domyślne zachowanie bez flagi: getViewsMissingFrameRate dostaje includeWrong=false, więc zapytanie pokrywa tylko NULL — wiersze z (złym) frame_rate > 121 są pomijane.');

    const origEnv = process.env.CLIPNEST_REFRESH_FRAME_RATES;
    delete process.env.CLIPNEST_REFRESH_FRAME_RATES;
    mockGetViewsMissingFrameRate.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await backfillFrameRates();
    } finally {
      if (origEnv !== undefined) process.env.CLIPNEST_REFRESH_FRAME_RATES = origEnv;
      logSpy.mockRestore();
    }

    expect(mockGetViewsMissingFrameRate).toHaveBeenCalledWith(
      expect.any(Number),
      false,
    );
  });
});
