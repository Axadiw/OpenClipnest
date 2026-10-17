import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const {
  mockGetFileMetadataKeysByOwner,
  mockDeleteS3AndMetadata,
} = vi.hoisted(() => ({
  mockGetFileMetadataKeysByOwner: vi.fn(),
  mockDeleteS3AndMetadata: vi.fn(),
}));

vi.mock('../db/queries/events.js', () => ({
  getFileMetadataKeysByOwner: (...args: unknown[]) => mockGetFileMetadataKeysByOwner(...args),
  // Wire only the functions used by runOrphanFileMetadataSweepForUser.
  // Other db/queries/events.js exports are not needed in these isolated unit tests.
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
}));

vi.mock('./fileLifecycle.js', () => ({
  deleteS3AndMetadata: (...args: unknown[]) => mockDeleteS3AndMetadata(...args),
}));

// Config is not used by runOrphanFileMetadataSweepForUser directly, but the
// module import chain requires it to resolve without errors.
vi.mock('../config.js', () => ({
  CONFIG: {
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
  },
}));

// Other services imported transitively by storageReconciler.ts — stub them
// so the module loads cleanly in the isolated test environment.
vi.mock('./s3.js', () => ({
  listObjectsStream: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
}));
vi.mock('./audit.js', () => ({ auditLog: vi.fn() }));
vi.mock('./eventCleanup.js', () => ({ deleteEventAndThumbnail: vi.fn() }));
// Stubs for storageReconciler transitive db imports not used by this test
vi.mock('../db/queries/storage.js', () => ({
  getUsersForScan: vi.fn(),
  getUserQuota: vi.fn(),
  setDiskUsageAbsolute: vi.fn(),
  createReconciliationRun: vi.fn(),
  recordDiskCorrection: vi.fn(),
  upsertOrphanObject: vi.fn(),
  getOrphansOlderThan: vi.fn(),
  deleteOrphanObjectRow: vi.fn(),
  withUserAdvisoryLock: vi.fn(),
}));
vi.mock('../db/queries/users.js', () => ({
  getUserByUuid: vi.fn(),
  getAllUserUuids: vi.fn(),
}));
vi.mock('../db/queries/notifications.js', () => ({
  deleteNotificationsForEvent: vi.fn(),
}));
vi.mock('./streamsClient.js', () => ({ publishScanTrigger: vi.fn() }));

import { runOrphanFileMetadataSweepForUser, sidecarRecordingRel } from './storageReconciler.js';

describe('sidecarRecordingRel (Step 1c2 sidecar-orphan parsing)', () => {
  it('resolves the parent recording for EVERY sidecar suffix, not just .fmp4patch', (ctx) => {
    story(ctx, 'Sedno bugu "panel pokazuje 5651 a nie 200k": krok 1c2 wykrywał tylko .fmp4patch, więc .clean_frame/.classic_moov/.frames (~3/4 sidecarów) nigdy nie były liczone jako sieroty. Kotwiczenie na ostatnim .mp4 obejmuje wszystkie sufiksy, obecne i przyszłe.');
    expect(sidecarRecordingRel('2026/05/21/Cam_00_ts.mp4.fmp4patch')).toBe('2026/05/21/Cam_00_ts.mp4');
    expect(sidecarRecordingRel('2026/05/21/Cam_00_ts.mp4.clean_frame')).toBe('2026/05/21/Cam_00_ts.mp4');
    expect(sidecarRecordingRel('2026/05/21/Cam_00_ts.mp4.classic_moov')).toBe('2026/05/21/Cam_00_ts.mp4');
    expect(sidecarRecordingRel('2026/05/21/Cam_00_ts.mp4.frames')).toBe('2026/05/21/Cam_00_ts.mp4');
  });

  it('returns null for keys that are not a recognisable sidecar', (ctx) => {
    story(ctx, 'Goły klucz nagrania (bez sufiksu) ani plik bez .mp4 nie jest sidecarem — zwracamy null, żeby pętla go pominęła zamiast oznaczyć jako sierotę.');
    expect(sidecarRecordingRel('2026/05/21/Cam_00_ts.mp4')).toBeNull();
    expect(sidecarRecordingRel('notes.txt')).toBeNull();
  });
});

describe('runOrphanFileMetadataSweepForUser (Step 2c safety net)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cascades a single orphan without firing a Sentry warn (below threshold)', async (ctx) => {
    story(ctx, 'Safety net znajduje pojedynczego sieroty i kasuje go przez helper. Sentry warn NIE leci — pojedyncze sieroty to normalny churn między delete paths a okienkiem widoczności S3 LIST, próg Sentry to ORPHAN_FILE_METADATA_WARN_MIN_COUNT (10).');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const s3KeysPerBucket = new Map([
      ['recordings', new Set(['u/has.mp4'])],
    ]);
    mockGetFileMetadataKeysByOwner.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'u/has.mp4' },
      { id: 2, s3Bucket: 'recordings', s3Key: 'u/orphan.mp4' },
    ]);
    mockDeleteS3AndMetadata.mockResolvedValue({ s3Deleted: false, metadataDeleted: true });

    const summary = await runOrphanFileMetadataSweepForUser(42, s3KeysPerBucket);

    expect(summary).toEqual({ orphansFound: 1, orphansDeleted: 1 });
    expect(mockDeleteS3AndMetadata).toHaveBeenCalledTimes(1);
    expect(mockDeleteS3AndMetadata).toHaveBeenCalledWith({
      ownerId: 42,
      s3Bucket: 'recordings',
      s3Key: 'u/orphan.mp4',
      reason: 'reconciler-safety-net',
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('orphan_file_metadata_detected'),
    );
    warnSpy.mockRestore();
  });

  it('fires Sentry warn when orphan count crosses ORPHAN_FILE_METADATA_WARN_MIN_COUNT (10)', async (ctx) => {
    story(ctx, 'Próg regresji: gdy w jednym tick znajdziemy >=10 sierot, warn leci do Sentry. Każdy sierota jest kasowany niezależnie od progu.');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const s3KeysPerBucket = new Map([['recordings', new Set<string>()]]);
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      s3Bucket: 'recordings',
      s3Key: `u/orphan-${i}.mp4`,
    }));
    mockGetFileMetadataKeysByOwner.mockResolvedValue(rows);
    mockDeleteS3AndMetadata.mockResolvedValue({ s3Deleted: false, metadataDeleted: true });

    const summary = await runOrphanFileMetadataSweepForUser(42, s3KeysPerBucket);

    expect(summary).toEqual({ orphansFound: 10, orphansDeleted: 10 });
    expect(mockDeleteS3AndMetadata).toHaveBeenCalledTimes(10);
    expect(warnSpy).toHaveBeenCalledWith(
      `[reconciler] orphan_file_metadata_detected userId=42`,
    );
    warnSpy.mockRestore();
  });

  it('returns zero when no orphans', async (ctx) => {
    story(ctx, 'Happy path bez sierot — żadne warn nie leci do Sentry, nic nie jest kasowane.');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const s3KeysPerBucket = new Map([['recordings', new Set(['u/a.mp4'])]]);
    mockGetFileMetadataKeysByOwner.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'u/a.mp4' },
    ]);

    const summary = await runOrphanFileMetadataSweepForUser(42, s3KeysPerBucket);

    expect(summary).toEqual({ orphansFound: 0, orphansDeleted: 0 });
    expect(mockDeleteS3AndMetadata).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('orphan_file_metadata_detected'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('skips rows for buckets not in the s3KeysPerBucket map (unknown bucket guard)', async (ctx) => {
    story(ctx, 'Wiersze file_metadata dla bucketa, który nie jest w mapie S3, są pomijane — zabezpieczenie przed false-positives gdy nie skanujemy wszystkich bucketów w jednym przebiegu.');

    // Only recordings bucket is provided; thumbnails bucket is absent.
    const s3KeysPerBucket = new Map([['recordings', new Set(['u/a.mp4'])]]);
    mockGetFileMetadataKeysByOwner.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'u/a.mp4' },
      { id: 2, s3Bucket: 'thumbnails', s3Key: 'u/__generated__/some.jpg' },
    ]);

    const summary = await runOrphanFileMetadataSweepForUser(42, s3KeysPerBucket);

    expect(summary).toEqual({ orphansFound: 0, orphansDeleted: 0 });
    expect(mockDeleteS3AndMetadata).not.toHaveBeenCalled();
  });

  it('counts partial failures — a delete error does not abort remaining orphans', async (ctx) => {
    story(ctx, 'Błąd deleteS3AndMetadata dla jednego sieroty nie przerywa pętli — pozostałe sieroty są kasowane, a błąd jest logowany jako warn (nie throw).');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const s3KeysPerBucket = new Map([['recordings', new Set<string>()]]);
    mockGetFileMetadataKeysByOwner.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'u/orphan-a.mp4' },
      { id: 2, s3Bucket: 'recordings', s3Key: 'u/orphan-b.mp4' },
    ]);
    mockDeleteS3AndMetadata
      .mockResolvedValueOnce({ s3Deleted: false, metadataDeleted: true })
      .mockRejectedValueOnce(new Error('S3 transient error'));

    const summary = await runOrphanFileMetadataSweepForUser(42, s3KeysPerBucket);

    expect(summary).toEqual({ orphansFound: 2, orphansDeleted: 1 });
    expect(mockDeleteS3AndMetadata).toHaveBeenCalledTimes(2);
    // The failure warn for the second orphan should be logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('delete failed userId=42'),
    );
    warnSpy.mockRestore();
  });
});
