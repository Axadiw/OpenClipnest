import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const {
  mockRemoveFileMetadata,
  mockGetUserInternalIdByUuid,
  mockRemoveDeletedFileFromEvents,
  mockDeleteNotificationsForEvent,
  mockDeleteGeneratedThumbnail,
  mockDeleteSidecarsForRecording,
} = vi.hoisted(() => ({
  mockRemoveFileMetadata: vi.fn(),
  mockGetUserInternalIdByUuid: vi.fn(),
  mockRemoveDeletedFileFromEvents: vi.fn(),
  mockDeleteNotificationsForEvent: vi.fn(),
  mockDeleteGeneratedThumbnail: vi.fn(),
  mockDeleteSidecarsForRecording: vi.fn(),
}));

vi.mock('../config.js', () => ({
  CONFIG: { s3RecordingsBucket: 'recordings-test' },
}));

vi.mock('../db/queries/events.js', () => ({
  removeFileMetadata: (...args: unknown[]) => mockRemoveFileMetadata(...args),
  removeDeletedFileFromEvents: (...args: unknown[]) =>
    mockRemoveDeletedFileFromEvents(...args),
}));
vi.mock('../db/queries/users.js', () => ({
  getUserInternalIdByUuid: (...args: unknown[]) => mockGetUserInternalIdByUuid(...args),
}));
vi.mock('../db/queries/notifications.js', () => ({
  deleteNotificationsForEvent: (...args: unknown[]) => mockDeleteNotificationsForEvent(...args),
}));

vi.mock('./eventCleanup.js', () => ({
  deleteGeneratedThumbnail: (...args: unknown[]) => mockDeleteGeneratedThumbnail(...args),
}));

vi.mock('./fileLifecycle.js', () => ({
  deleteSidecarsForRecording: (...args: unknown[]) => mockDeleteSidecarsForRecording(...args),
}));

vi.mock('./userIdCache.js', () => ({
  getCachedUserInternalId: async (uuid: string, fallback: (u: string) => Promise<number | null>) =>
    fallback(uuid),
}));

import { handleDeleteNotify } from './deleteNotifyHandler.js';

describe('handleDeleteNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveFileMetadata.mockResolvedValue(0);
    mockGetUserInternalIdByUuid.mockResolvedValue(42);
    mockRemoveDeletedFileFromEvents.mockResolvedValue({ deletedEventIds: [] });
    mockDeleteNotificationsForEvent.mockResolvedValue(undefined);
    mockDeleteGeneratedThumbnail.mockResolvedValue(undefined);
    mockDeleteSidecarsForRecording.mockResolvedValue(0);
  });

  it('cleans up file_metadata for non-recording extensions', async (ctx) => {
    story(
      ctx,
      'Od v0.10.277 FTPS akceptuje wszystkie typy plików — /internal/file-uploaded wstawia wiersz file_metadata bez filtra rozszerzenia. Bez tego cleanupu non-video DELE (snapshoty .jpg z kamery, configi .txt, status .json) zostawia osierocone wiersze, których reconciler-Step-2c potem ścigaa, wybijając Sentry warn. Cleanup file_metadata nie potrzebuje eventId, więc musi działać niezależnie od tego czy parseS3KeyForDelete rozpoznał klucz.',
    );

    await handleDeleteNotify({ userUuid: 'abc-uuid', s3Key: 'abc-uuid/foo.txt' });

    expect(mockRemoveFileMetadata).toHaveBeenCalledTimes(1);
    expect(mockRemoveFileMetadata).toHaveBeenCalledWith('recordings-test', 'abc-uuid/foo.txt');
    // Non-recording → event mutation pomijana (brak eventId do mutacji)
    expect(mockRemoveDeletedFileFromEvents).not.toHaveBeenCalled();
    // Non-recording → brak sidecarów do skasowania
    expect(mockDeleteSidecarsForRecording).not.toHaveBeenCalled();
  });

  it('cleans up file_metadata AND removes the file from events by path for canonical video s3Key', async (ctx) => {
    story(
      ctx,
      'Główny happy path: dla kanonicznego klucza (CameraName_LL_TIMESTAMP.mp4) cleanup file_metadata I event-row mutation muszą obie się wykonać. Po refactorze (cleanup wyniesiony przed early-return) chcemy upewnić się że na ścieżce video removeFileMetadata wciąż wołane jest dokładnie raz — nie dwa razy. Usuwanie z eventów idzie teraz po video_rel_path (NIE po eventId z nazwy pliku), więc removeDeletedFileFromEvents woła się z (ownerId, relKey-bez-uuid-prefiksu).',
    );

    mockRemoveDeletedFileFromEvents.mockResolvedValue({ deletedEventIds: [] });

    const s3Key = 'abc-uuid/2026/05/21/Cam_00_20260521143055.mp4';
    await handleDeleteNotify({ userUuid: 'abc-uuid', s3Key });

    expect(mockRemoveFileMetadata).toHaveBeenCalledTimes(1);
    expect(mockRemoveFileMetadata).toHaveBeenCalledWith('recordings-test', s3Key);
    expect(mockRemoveDeletedFileFromEvents).toHaveBeenCalledTimes(1);
    // Path-based lookup: (ownerId, relKey-without-uuid-prefix). NO filename-derived
    // eventId — that was the orphan bug for proximity-merged dual-view events.
    expect(mockRemoveDeletedFileFromEvents).toHaveBeenCalledWith(
      42,
      '2026/05/21/Cam_00_20260521143055.mp4',
    );
    // Nothing emptied → no per-event cleanup.
    expect(mockDeleteGeneratedThumbnail).not.toHaveBeenCalled();
    expect(mockDeleteNotificationsForEvent).not.toHaveBeenCalled();
    // Sidecary są per-PLIK (nie per-event): kasowane dla skasowanego nagrania
    // niezależnie od tego czy event przetrwał (dual-view) — to jest wyciek 217k.
    expect(mockDeleteSidecarsForRecording).toHaveBeenCalledTimes(1);
    expect(mockDeleteSidecarsForRecording).toHaveBeenCalledWith(s3Key);
  });

  it('cleans up the generated thumbnail and notifications for each emptied event', async (ctx) => {
    story(
      ctx,
      'Gdy usunięcie ostatniego view sprawia że event nie ma już żadnych plików, removeDeletedFileFromEvents kasuje wiersz events i zwraca jego id. Handler musi wtedy wyczyścić wygenerowany thumbnail (obiekt S3) ORAZ powiadomienia dla tego eventu — best-effort, owner-scoped. To pokrywa ścieżkę faktycznej kasacji eventu (proximity-merged dual-view: ostatni view zamyka event o id ≠ id z nazwy pliku).',
    );

    mockRemoveDeletedFileFromEvents.mockResolvedValue({ deletedEventIds: ['evt-keeper-1'] });

    const s3Key = 'abc-uuid/2026/05/21/Cam_01_20260521143056.mp4';
    await handleDeleteNotify({ userUuid: 'abc-uuid', s3Key });

    expect(mockRemoveDeletedFileFromEvents).toHaveBeenCalledWith(
      42,
      '2026/05/21/Cam_01_20260521143056.mp4',
    );
    expect(mockDeleteGeneratedThumbnail).toHaveBeenCalledTimes(1);
    expect(mockDeleteGeneratedThumbnail).toHaveBeenCalledWith('evt-keeper-1', 'abc-uuid');
    expect(mockDeleteNotificationsForEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteNotificationsForEvent).toHaveBeenCalledWith('evt-keeper-1');
  });

  it('cleans up file_metadata even when user is unknown', async (ctx) => {
    story(
      ctx,
      'Gdy user został w międzyczasie usunięty (race między user-deletion a delete-notify), getCachedUserInternalId zwraca null. Mimo to file_metadata musi być wyczyszczona — wiersz jest unikalny po (bucket, s3_key), więc bezpiecznie kasujemy bez owner-id; brak czyszczenia tutaj zostawia trwałe orphany.',
    );

    mockGetUserInternalIdByUuid.mockResolvedValue(null);

    const s3Key = 'ghost-uuid/2026/05/21/Cam_00_20260521143055.mp4';
    await handleDeleteNotify({ userUuid: 'ghost-uuid', s3Key });

    expect(mockRemoveFileMetadata).toHaveBeenCalledTimes(1);
    expect(mockRemoveFileMetadata).toHaveBeenCalledWith('recordings-test', s3Key);
    expect(mockRemoveDeletedFileFromEvents).not.toHaveBeenCalled();
    // Sidecary należą do klucza nagrania, więc czyścimy je nawet gdy owner
    // jest nieznany (race user-deletion vs delete-notify) — inaczej zostają sieroty.
    expect(mockDeleteSidecarsForRecording).toHaveBeenCalledWith(s3Key);
  });

  it('deletes sidecars for a recording even when the payload userUuid mismatches the key', async (ctx) => {
    story(
      ctx,
      'Gdy userUuid z payloadu nie zgadza się z uuid zaszytym w kluczu, mutacja eventu jest pomijana (bezpieczeństwo). Ale sidecary nazywają się dosłownie {s3Key}.<suffix> — należą do tego konkretnego, usuniętego nagrania — więc czyścimy je po kluczu niezależnie od mismatcha. Inaczej każdy taki DELE zostawia komplet sidecarów.',
    );

    const s3Key = 'abc-uuid/2026/05/21/Cam_00_20260521143055.mp4';
    await handleDeleteNotify({ userUuid: 'different-uuid', s3Key });

    expect(mockRemoveDeletedFileFromEvents).not.toHaveBeenCalled();
    expect(mockDeleteSidecarsForRecording).toHaveBeenCalledTimes(1);
    expect(mockDeleteSidecarsForRecording).toHaveBeenCalledWith(s3Key);
  });
});
