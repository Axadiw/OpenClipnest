import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const {
  mockDeleteObject,
  mockDeleteObjectsByPrefix,
  mockDeleteFileMetadataReturningSize,
  mockUpdateDiskUsage,
} = vi.hoisted(() => ({
  mockDeleteObject: vi.fn(),
  mockDeleteObjectsByPrefix: vi.fn(),
  mockDeleteFileMetadataReturningSize: vi.fn(),
  mockUpdateDiskUsage: vi.fn(),
}));

vi.mock('./s3.js', () => ({
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  deleteObjectsByPrefix: (...args: unknown[]) => mockDeleteObjectsByPrefix(...args),
}));

vi.mock('../db/queries/events.js', () => ({
  deleteFileMetadataReturningSize: (...args: unknown[]) =>
    mockDeleteFileMetadataReturningSize(...args),
}));
vi.mock('../db/queries/storage.js', () => ({
  updateDiskUsage: (...args: unknown[]) => mockUpdateDiskUsage(...args),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
  },
}));

import { deleteS3AndMetadata, deleteRecordingAllBuckets, deleteSidecarsForRecording } from './fileLifecycle.js';

describe('deleteS3AndMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes S3 object then row, decrements counter for recordings bucket', async (ctx) => {
    story(ctx, 'Happy path: helper kasuje obiekt S3, potem wiersz file_metadata, potem zmniejsza disk_usage_bytes — w tej kolejności i tylko dla recordings bucket.');
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteFileMetadataReturningSize.mockResolvedValue({ deleted: true, fileSizeBytes: 1000 });

    const result = await deleteS3AndMetadata({
      ownerId: 7,
      s3Bucket: 'recordings',
      s3Key: 'k/a.mp4',
      reason: 'event-delete',
    });

    expect(result).toEqual({ s3Deleted: true, metadataDeleted: true });
    expect(mockDeleteObject).toHaveBeenCalledWith('recordings', 'k/a.mp4');
    expect(mockDeleteFileMetadataReturningSize).toHaveBeenCalledWith(7, 'recordings', 'k/a.mp4');
    expect(mockUpdateDiskUsage).toHaveBeenCalledWith(7, -1000);

    const deleteObjectCallOrder = mockDeleteObject.mock.invocationCallOrder[0];
    const deleteRowCallOrder = mockDeleteFileMetadataReturningSize.mock.invocationCallOrder[0];
    expect(deleteObjectCallOrder).toBeLessThan(deleteRowCallOrder);
  });

  it('does NOT decrement disk_usage_bytes for thumbnails bucket', async (ctx) => {
    story(ctx, 'Thumbnails i sidecars to derived files — ich rozmiar nigdy nie był wliczany do quoty, więc nie wpływa na disk_usage_bytes przy kasowaniu.');
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteFileMetadataReturningSize.mockResolvedValue({ deleted: true, fileSizeBytes: 200 });

    await deleteS3AndMetadata({
      ownerId: 7,
      s3Bucket: 'thumbnails',
      s3Key: 'k/a.mp4.jpg',
      reason: 'event-delete',
    });

    expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
  });

  it('treats S3 NoSuchKey as idempotent success', async (ctx) => {
    story(ctx, 'Drugi run helpera albo run dla pliku już skasowanego nie crashuje — NoSuchKey jest cicho zignorowany.');
    const err = Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    mockDeleteObject.mockRejectedValue(err);
    mockDeleteFileMetadataReturningSize.mockResolvedValue({ deleted: true, fileSizeBytes: 500 });

    const result = await deleteS3AndMetadata({
      ownerId: 7,
      s3Bucket: 'recordings',
      s3Key: 'k/missing.mp4',
      reason: 'backfill',
    });

    expect(result).toEqual({ s3Deleted: false, metadataDeleted: true });
    expect(mockDeleteFileMetadataReturningSize).toHaveBeenCalled();
    expect(mockUpdateDiskUsage).toHaveBeenCalledWith(7, -500);
  });

  it('throws on transient S3 errors and leaves row alone', async (ctx) => {
    story(ctx, 'Transient błąd (np. timeout) NIE może spowodować skasowania wiersza — wracamy z błędem, reconciler safety net dosprzata później.');
    mockDeleteObject.mockRejectedValue(new Error('socket hang up'));

    await expect(
      deleteS3AndMetadata({
        ownerId: 7,
        s3Bucket: 'recordings',
        s3Key: 'k/transient.mp4',
        reason: 'event-delete',
      }),
    ).rejects.toThrow('socket hang up');

    expect(mockDeleteFileMetadataReturningSize).not.toHaveBeenCalled();
    expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
  });

  it('row already gone — s3 deletes, metadataDeleted=false, no decrement', async (ctx) => {
    story(ctx, 'Edge case: ktoś inny już skasował wiersz, ale S3 jeszcze został — kasujemy S3, zwracamy metadataDeleted=false, nie dekrementujemy disk_usage_bytes drugi raz.');
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteFileMetadataReturningSize.mockResolvedValue({ deleted: false, fileSizeBytes: null });

    const result = await deleteS3AndMetadata({
      ownerId: 7,
      s3Bucket: 'recordings',
      s3Key: 'k/already.mp4',
      reason: 'reconciler-safety-net',
    });

    expect(result).toEqual({ s3Deleted: true, metadataDeleted: false });
    expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
  });
});

describe('deleteSidecarsForRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefix-deletes every sidecar suffix for a recording in the sidecars bucket', async (ctx) => {
    story(ctx, 'Sidecary nazywają się {recordingKey}.<suffix> (.fmp4patch / .clean_frame / .classic_moov / .frames / przyszłe). Kasowanie po prefiksie "{recordingKey}." obejmuje WSZYSTKIE sufiksy naraz — w tym .frames, który dawniej był pomijany — jednym LIST+DeleteObjects, odpornym na nowe sufiksy. To zamyka klasę błędu "zapomniany sufiks".');
    mockDeleteObjectsByPrefix.mockResolvedValue(4);

    const removed = await deleteSidecarsForRecording('u/2026/05/21/Cam_00_ts.mp4');

    expect(removed).toBe(4);
    expect(mockDeleteObjectsByPrefix).toHaveBeenCalledTimes(1);
    expect(mockDeleteObjectsByPrefix).toHaveBeenCalledWith('sidecars', 'u/2026/05/21/Cam_00_ts.mp4.');
  });
});

describe('deleteRecordingAllBuckets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes recording + .jpg thumbnail rows and prefix-deletes all sidecars', async (ctx) => {
    story(ctx, 'Wrapper kasuje nagranie + per-recording .jpg thumbnail przez helper (z cascade file_metadata + disk_usage), a WSZYSTKIE sidecary jednym prefix-delete "{key}." (pokrywa .frames i przyszłe sufiksy). Counter dekrementuje tylko o rozmiar nagrania; deletedRows liczy realnie skasowane wiersze file_metadata (nagranie + thumbnail).');
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteObjectsByPrefix.mockResolvedValue(4);
    mockDeleteFileMetadataReturningSize
      .mockImplementation(async (_userId: number, bucket: string) => {
        if (bucket === 'recordings') return { deleted: true, fileSizeBytes: 5000 };
        return { deleted: true, fileSizeBytes: 100 };
      });

    const result = await deleteRecordingAllBuckets({
      ownerId: 9,
      recordingS3Key: 'u/rec.mp4',
      reason: 'event-delete',
    });

    expect(result).toEqual({ deletedRows: 2 });

    expect(mockDeleteObject).toHaveBeenCalledWith('recordings', 'u/rec.mp4');
    expect(mockDeleteObject).toHaveBeenCalledWith('thumbnails', 'u/rec.mp4.jpg');
    expect(mockDeleteObject).toHaveBeenCalledTimes(2);

    // All sidecar variants removed via one prefix-delete (covers .frames).
    expect(mockDeleteObjectsByPrefix).toHaveBeenCalledTimes(1);
    expect(mockDeleteObjectsByPrefix).toHaveBeenCalledWith('sidecars', 'u/rec.mp4.');

    // only recordings decrement
    expect(mockUpdateDiskUsage).toHaveBeenCalledTimes(1);
    expect(mockUpdateDiskUsage).toHaveBeenCalledWith(9, -5000);
  });

  it('handles a missing thumbnail row gracefully (counts only deleted rows)', async (ctx) => {
    story(ctx, 'Jeśli .jpg thumbnail nie ma już wiersza w DB, wrapper liczy tylko realnie skasowane wiersze (samo nagranie) i nie crashuje; sidecary i tak są prefix-kasowane.');
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteObjectsByPrefix.mockResolvedValue(0);
    mockDeleteFileMetadataReturningSize
      .mockImplementation(async (_userId: number, bucket: string) => {
        if (bucket === 'thumbnails') return { deleted: false, fileSizeBytes: null };
        return { deleted: true, fileSizeBytes: 1000 };
      });

    const result = await deleteRecordingAllBuckets({
      ownerId: 9,
      recordingS3Key: 'u/partial.mp4',
      reason: 'reconciler-safety-net',
    });

    expect(result).toEqual({ deletedRows: 1 });
    expect(mockDeleteObjectsByPrefix).toHaveBeenCalledWith('sidecars', 'u/partial.mp4.');
  });
});
