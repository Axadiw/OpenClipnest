import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const mockGetUsersForScan = vi.fn();
const mockGetAllUserUuids = vi.fn();
const mockGetUserQuota = vi.fn();
const mockGetUserByUuid = vi.fn();
const mockSetDiskUsageAbsolute = vi.fn();
const mockCreateReconciliationRun = vi.fn();
const mockRecordDiskCorrection = vi.fn();
const mockUpsertOrphanObject = vi.fn();
const mockUpsertOrphanObjects = vi.fn();
const mockCleanupOldZombieEvents = vi.fn();
const mockCountZombieEvents = vi.fn();
const mockGetEventRefsByOwner = vi.fn();
const mockUpdateEventFiles = vi.fn();
const mockDeleteEvent = vi.fn();
const mockDeleteNotificationsForEvent = vi.fn();
const mockGetOrphansOlderThan = vi.fn();
const mockDeleteOrphanObjectRow = vi.fn();
const mockTrackFileUpload = vi.fn();
const mockGetAllUserUuidsAnyStatus = vi.fn();
const mockGetUserIdsWithUnfinishedContentDeletion = vi.fn();
const mockHasUnfinishedContentDeletion = vi.fn(async (_id: number) => false);

const mockGetFileMetadataKeysByOwner = vi.fn();
const mockGetEventByIdAnyOwner = vi.fn();
const mockGetFileMetadataByKey = vi.fn();
const mockHasFileMetadataUnderPrefix = vi.fn();

vi.mock('../db/queries/storage.js', () => ({
  getUsersForScan: (...a: unknown[]) => mockGetUsersForScan(...a),
  getUserQuota: (...a: unknown[]) => mockGetUserQuota(...a),
  setDiskUsageAbsolute: (...a: unknown[]) => mockSetDiskUsageAbsolute(...a),
  createReconciliationRun: (...a: unknown[]) => mockCreateReconciliationRun(...a),
  recordDiskCorrection: (...a: unknown[]) => mockRecordDiskCorrection(...a),
  upsertOrphanObject: (...a: unknown[]) => mockUpsertOrphanObject(...a),
  upsertOrphanObjects: (...a: unknown[]) => mockUpsertOrphanObjects(...a),
  getOrphansOlderThan: (...a: unknown[]) => mockGetOrphansOlderThan(...a),
  deleteOrphanObjectRow: (...a: unknown[]) => mockDeleteOrphanObjectRow(...a),
  // The per-user lock wraps Step 1's body. Stub to a transparent pass-through
  // so tests exercise the body unchanged; race-vs-autoDelete is covered by
  // production integration (no unit-test concurrency simulation).
  withUserAdvisoryLock: async <T,>(_userId: number, fn: () => Promise<T>): Promise<T | null> => fn(),
  getUserIdsWithUnfinishedContentDeletion: (...a: unknown[]) => mockGetUserIdsWithUnfinishedContentDeletion(...a),
  hasUnfinishedContentDeletion: (id: number) => mockHasUnfinishedContentDeletion(id),
}));
vi.mock('../db/queries/events.js', () => ({
  cleanupOldZombieEvents: (...a: unknown[]) => mockCleanupOldZombieEvents(...a),
  countZombieEvents: (...a: unknown[]) => mockCountZombieEvents(...a),
  getEventRefsByOwner: (...a: unknown[]) => mockGetEventRefsByOwner(...a),
  updateEventFiles: (...a: unknown[]) => mockUpdateEventFiles(...a),
  deleteEvent: (...a: unknown[]) => mockDeleteEvent(...a),
  trackFileUpload: (...a: unknown[]) => mockTrackFileUpload(...a),
  getFileMetadataKeysByOwner: (...a: unknown[]) => mockGetFileMetadataKeysByOwner(...a),
  getEventByIdAnyOwner: (...a: unknown[]) => mockGetEventByIdAnyOwner(...a),
  getFileMetadataByKey: (...a: unknown[]) => mockGetFileMetadataByKey(...a),
  hasFileMetadataUnderPrefix: (...a: unknown[]) => mockHasFileMetadataUnderPrefix(...a),
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
}));
vi.mock('../db/queries/users.js', () => ({
  getUserByUuid: (...a: unknown[]) => mockGetUserByUuid(...a),
  getAllUserUuids: (...a: unknown[]) => mockGetAllUserUuids(...a),
  getAllUserUuidsAnyStatus: (...a: unknown[]) => mockGetAllUserUuidsAnyStatus(...a),
}));
vi.mock('../db/queries/notifications.js', () => ({
  deleteNotificationsForEvent: (...a: unknown[]) => mockDeleteNotificationsForEvent(...a),
}));

const mockListObjects = vi.fn();
const mockDeleteObject = vi.fn();
const mockHeadObject = vi.fn();
vi.mock('./s3.js', () => ({
  // The reconciler now consumes the streaming variant. Tests still set up
  // their fixtures as plain arrays via `mockListObjects.mockResolvedValue`;
  // the wrapper turns that array into an async iterable transparently.
  listObjectsStream: (...a: unknown[]) => {
    const result = mockListObjects(...a);
    return (async function*() {
      const arr = await Promise.resolve(result);
      for (const item of arr ?? []) yield item;
    })();
  },
  deleteObject: (...a: unknown[]) => mockDeleteObject(...a),
  headObject: (...a: unknown[]) => mockHeadObject(...a),
}));

vi.mock('./audit.js', () => ({ auditLog: vi.fn() }));

const mockDeleteS3AndMetadata = vi.fn().mockResolvedValue({ s3Deleted: true, metadataDeleted: true });
vi.mock('./fileLifecycle.js', () => ({
  deleteS3AndMetadata: (...a: unknown[]) => mockDeleteS3AndMetadata(...a),
}));

const mockPublishScanTrigger = vi.fn();
vi.mock('./streamsClient.js', () => ({
  publishScanTrigger: (...a: unknown[]) => mockPublishScanTrigger(...a),
}));

// Mutable so individual tests can toggle orphanAutoPurgeEnabled. beforeEach
// resets it to the production default (ENABLED). Defined via vi.hoisted so the
// object exists when the hoisted vi.mock factory dereferences it (avoids TDZ).
const mockConfig = vi.hoisted(() => ({
  s3RecordingsBucket: 'recordings',
  s3ThumbnailsBucket: 'thumbnails',
  s3SidecarsBucket: 'sidecars',
  orphanAutoPurgeEnabled: true,
}));
vi.mock('../config.js', () => ({ CONFIG: mockConfig }));

import {
  runStorageReconciliation,
  classifyOrphan,
  thumbEventId,
  sidecarParentKey,
  isStillOrphaned,
} from './storageReconciler.js';

const BUCKETS = { thumbnails: 'thumbnails', sidecars: 'sidecars', recordings: 'recordings' };

const UUID = '11111111-2222-3333-4444-555555555555';
const USER = { id: 7, uuid: UUID, encryptionSalt: 'salt-7' };

beforeEach(() => {
  vi.resetAllMocks();
  // Default: auto-purge enabled (production default). Individual tests flip it.
  mockConfig.orphanAutoPurgeEnabled = true;
  mockGetUsersForScan.mockResolvedValue([USER]);
  mockGetUserIdsWithUnfinishedContentDeletion.mockResolvedValue(new Set());
  mockHasUnfinishedContentDeletion.mockResolvedValue(false);
  mockGetAllUserUuids.mockResolvedValue(new Set([UUID]));
  // Purge GUARD set (every user regardless of admin / deletion status).
  // Default mirrors the single active test user; tests that exercise admin /
  // mid-deletion prefixes extend this.
  mockGetAllUserUuidsAnyStatus.mockResolvedValue([UUID]);
  mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 0, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
  mockGetUserByUuid.mockResolvedValue({ uuid: UUID, username: 'tester' });
  mockListObjects.mockResolvedValue([]);
  mockGetEventRefsByOwner.mockResolvedValue([]);
  mockCleanupOldZombieEvents.mockResolvedValue(0);
  mockCountZombieEvents.mockResolvedValue(0);
  mockCreateReconciliationRun.mockResolvedValue(1);
  mockRecordDiskCorrection.mockResolvedValue(undefined);
  mockUpsertOrphanObject.mockResolvedValue(undefined);
  mockUpsertOrphanObjects.mockResolvedValue(undefined);
  mockGetOrphansOlderThan.mockResolvedValue([]);
  mockDeleteOrphanObjectRow.mockResolvedValue(true);
  mockDeleteObject.mockResolvedValue(undefined);
  mockSetDiskUsageAbsolute.mockResolvedValue(undefined);
  mockUpdateEventFiles.mockResolvedValue(undefined);
  mockDeleteEvent.mockResolvedValue(undefined);
  mockDeleteNotificationsForEvent.mockResolvedValue(0);
  mockTrackFileUpload.mockResolvedValue({ id: 1, inserted: true });
  mockDeleteS3AndMetadata.mockResolvedValue({ s3Deleted: true, metadataDeleted: true });
  // Step 2c safety net — default to no file_metadata rows (no orphans)
  mockGetFileMetadataKeysByOwner.mockResolvedValue([]);
  // Per-object re-verification defaults: parent is GONE, i.e. genuinely
  // orphaned. Tests that need "the parent came back" override these.
  mockGetEventByIdAnyOwner.mockResolvedValue(undefined);
  mockGetFileMetadataByKey.mockResolvedValue(null);
  mockHasFileMetadataUnderPrefix.mockResolvedValue(false);
});

describe('storageReconciler — disk usage', () => {
  it('corrects stored bytes when S3 reality differs', async (ctx) => {
    story(ctx, 'Reconciler porównuje sumę bajtów na S3 z licznikiem disk_usage_bytes w DB i zapisuje korektę — gwarancja, że quota nie rozjeżdża się po awariach FTPS, w których raportowanie usage zawiodło.');
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'recordings' && prefix === `${UUID}/`) return [{ key: `${UUID}/2026/04/24/Front_00_X.mp4`, size: 12345, lastModified: new Date() }];
      return [];
    });
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 99, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });

    await runStorageReconciliation();

    expect(mockSetDiskUsageAbsolute).toHaveBeenCalledWith(7, 12345);
    expect(mockRecordDiskCorrection).toHaveBeenCalled();
  });

  it('skips correction when stored bytes already match', async (ctx) => {
    story(ctx, 'Stabilny stan = brak zbędnych zapisów do bazy: gdy quota i sumowane bajty z S3 się zgadzają, reconciler nie generuje hałasu.');
    mockListObjects.mockResolvedValue([{ key: `${UUID}/x.mp4`, size: 100, lastModified: new Date() }]);
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 100, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });

    await runStorageReconciliation();

    expect(mockSetDiskUsageAbsolute).not.toHaveBeenCalled();
  });
});

describe('storageReconciler — content deletion in progress', () => {
  it('skips an account whose recordings are being deleted', async (ctx) => {
    story(ctx, 'Konto w trakcie usuwania nagrań jest pomijane w kroku 1 — reconciler nie odtworzy wierszy plików ani licznika zajętości z obiektów, do których usuwanie jeszcze nie dotarło. Pozostałe konta są sprawdzane jak zwykle.');
    const OTHER = { id: 8, uuid: '99999999-2222-3333-4444-555555555555', encryptionSalt: 'salt-8' };
    mockGetUsersForScan.mockResolvedValue([USER, OTHER]);
    mockGetUserIdsWithUnfinishedContentDeletion.mockResolvedValue(new Set([USER.id]));
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) =>
      bucket === 'recordings' ? [{ key: `${prefix}2026/10/01/Front_00_X.mp4`, size: 50, lastModified: new Date('2026-10-01T00:00:00Z') }] : []);
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 0, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });

    await runStorageReconciliation();

    const listedPrefixes = mockListObjects.mock.calls.map((c) => c[1]);
    expect(listedPrefixes).not.toContain(`${UUID}/`);
    expect(listedPrefixes).toContain(`${OTHER.uuid}/`);
    expect(mockTrackFileUpload.mock.calls.some((c) => c.includes(USER.id))).toBe(false);
    expect(mockSetDiskUsageAbsolute).not.toHaveBeenCalledWith(USER.id, expect.anything());
    expect(mockSetDiskUsageAbsolute).toHaveBeenCalledWith(OTHER.id, 50);
  });

  it('skips an account whose deletion started after the run read its list', async (ctx) => {
    story(ctx, 'Usuwanie nagrań i audyt zachodzą na siebie co rano: gdy usuwanie konta przekroczy punkt bez powrotu już po tym, jak audyt przeczytał swoją listę, audyt i tak to widzi — pyta jeszcze raz pod blokadą konta, tuż przed czytaniem jego obiektów — i nie odtwarza usuniętych nagrań.');
    const OTHER = { id: 8, uuid: '99999999-2222-3333-4444-555555555555', encryptionSalt: 'salt-8' };
    mockGetUsersForScan.mockResolvedValue([USER, OTHER]);
    mockGetUserIdsWithUnfinishedContentDeletion.mockResolvedValue(new Set()); // read at the start: nothing yet
    mockHasUnfinishedContentDeletion.mockImplementation(async (id: number) => id === USER.id); // started since
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) =>
      bucket === 'recordings' ? [{ key: `${prefix}2026/10/01/Front_00_X.mp4`, size: 50, lastModified: new Date('2026-10-01T00:00:00Z') }] : []);
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 0, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });

    await runStorageReconciliation();

    expect(mockHasUnfinishedContentDeletion).toHaveBeenCalledWith(USER.id);
    const listedPrefixes = mockListObjects.mock.calls.map((c) => c[1]);
    expect(listedPrefixes).not.toContain(`${UUID}/`);
    expect(listedPrefixes).toContain(`${OTHER.uuid}/`);
    expect(mockTrackFileUpload.mock.calls.some((c) => c.includes(USER.id))).toBe(false);
    expect(mockSetDiskUsageAbsolute).not.toHaveBeenCalledWith(USER.id, expect.anything());
  });
});

describe('storageReconciler — event↔S3 consistency', () => {
  it('treats UUID-prefixed S3 keys as matching the relative paths in event rows', async (ctx) => {
    story(ctx, 'Regression test dla buga z v0.8.23-33: S3 zwraca pełne klucze "{uuid}/2026/.../X.mp4", a event.wide_video trzyma ścieżkę bez prefixu. Reconciler musi odjąć prefix, żeby zaopatrzyć Set kluczy do porównania — inaczej KAŻDY event był uznawany za "missing on disk" i kasowany w pierwszym przebiegu.');
    const wide = '2026/04/24/Front_00_X.mp4';
    const zoom = '2026/04/24/Front_01_X.mp4';
    mockListObjects.mockResolvedValue([
      { key: `${UUID}/${wide}`, size: 100, lastModified: new Date() },
      { key: `${UUID}/${zoom}`, size: 100, lastModified: new Date() },
    ]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev1', views: [{ id: '00', videoRelPath: wide }, { id: '01', videoRelPath: zoom }], thumbnail: null },
    ]);

    await runStorageReconciliation();

    expect(mockUpdateEventFiles).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('deletes event + purges notifications when every S3 reference is gone', async (ctx) => {
    story(ctx, 'Gdy obie ścieżki video nie istnieją na S3, event nie ma już co serwować — wiersz znika z DB razem ze wszystkimi powiązanymi powiadomieniami, żeby user nie klikał notyfikacji prowadzącej donikąd.');
    mockListObjects.mockResolvedValue([]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev-ghost', views: [{ id: '00', videoRelPath: '2026/01/01/A.mp4' }, { id: '01', videoRelPath: '2026/01/01/B.mp4' }], thumbnail: null },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteEvent).toHaveBeenCalledWith('ev-ghost', USER.id);
    expect(mockDeleteNotificationsForEvent).toHaveBeenCalledWith('ev-ghost');
    expect(mockUpdateEventFiles).not.toHaveBeenCalled();
  });

  it('nulls only the missing column when one view is still present', async (ctx) => {
    story(ctx, 'Częściowy delete (skasowano tylko jeden view) zostawia event z grywalnym strumieniem — reconciler nuluje tylko brakującą kolumnę, nie kasuje całego wiersza.');
    const wide = '2026/04/24/Front_00_X.mp4';
    mockListObjects.mockResolvedValue([{ key: `${UUID}/${wide}`, size: 100, lastModified: new Date() }]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev-half', views: [{ id: '00', videoRelPath: wide }, { id: '01', videoRelPath: '2026/04/24/Front_01_X.mp4' }], thumbnail: null },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteEvent).not.toHaveBeenCalled();
    expect(mockUpdateEventFiles).toHaveBeenCalledWith('ev-half', USER.id, '2026/04/24/Front_01_X.mp4');
  });

  it("preserves '__unplayable__' tombstone on the thumbnail column", async (ctx) => {
    story(ctx, 'Tombstone "__unplayable__" jest sentinelem workera, nie kluczem S3 — reconciler nigdy nie powinien go nullować, bo wtedy reconcileMissingThumbnails znowu zakolejkowałby ten sam beznadziejny event i wystrzelił powiadomienie.');
    const wide = '2026/04/24/Front_00_X.mp4';
    mockListObjects.mockResolvedValue([{ key: `${UUID}/${wide}`, size: 100, lastModified: new Date() }]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev-tomb', views: [{ id: '00', videoRelPath: wide }], thumbnail: '__unplayable__' },
    ]);

    await runStorageReconciliation();

    expect(mockUpdateEventFiles).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it("preserves generated '__s3_thumb__/...' references (separate bucket)", async (ctx) => {
    story(ctx, 'Generated thumbnaile żyją w osobnym bucket "thumbnails" — porównywanie ich do listingu bucket "recordings" musi je pomijać. Inaczej każdy event z thumbnailem wygenerowanym przez workera dostaje thumbnail=null co cykl reconcilera.');
    const wide = '2026/04/24/Front_00_X.mp4';
    mockListObjects.mockResolvedValue([{ key: `${UUID}/${wide}`, size: 100, lastModified: new Date() }]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev-genthumb', views: [{ id: '00', videoRelPath: wide }], thumbnail: `__s3_thumb__/${UUID}/ev-genthumb.jpg` },
    ]);

    await runStorageReconciliation();

    expect(mockUpdateEventFiles).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

      it('nulls native view-00 thumbnail when its S3 key is gone', async (ctx) => {
    story(ctx, 'Native JPG wgrany przez Reolink obok mp4 ma normalny S3 key (bez sentinela) — gdy plik zniknie z S3, reconciler usuwa tylko kolumnę thumbnail, zostawiając video do odtwarzania.');
    const wide = '2026/04/24/Front_00_X.mp4';
    const thumb = '2026/04/24/Front_00_X.jpg';
    mockListObjects.mockResolvedValue([{ key: `${UUID}/${wide}`, size: 100, lastModified: new Date() }]);
    mockGetEventRefsByOwner.mockResolvedValue([
      { id: 'ev-natthumb', views: [{ id: '00', videoRelPath: wide }], thumbnail: thumb },
    ]);

    await runStorageReconciliation();

    // The thumbnail rel_path itself is the removal target — updateEventFiles
    // nulls thumbnail when it matches the passed rel_path (here the native
    // sidecar jpg) AND drops any event_view_files row pointing at the same
    // path (no-op here because no view file matches).
    expect(mockUpdateEventFiles).toHaveBeenCalledWith('ev-natthumb', USER.id, thumb);
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });
});

describe('storageReconciler — zombies', () => {
  it('reports zombies cleaned + remaining in the run record', async (ctx) => {
    story(ctx, 'Liczniki zombie (oczyszczone w tym przebiegu + pozostałe w DB) lądują w tabeli storage_reconciliation_runs i są widoczne w admin /scan/health — podstawa monitorowania zdrowia pipeline\'u delete-notify.');
    mockCleanupOldZombieEvents.mockResolvedValue(4);
    mockCountZombieEvents.mockResolvedValue(1);

    await runStorageReconciliation();

    expect(mockCreateReconciliationRun).toHaveBeenCalledWith(
      expect.any(Number),  // usersChecked
      expect.any(Number),  // correctionsMade
      expect.any(Number),  // orphansFound
      expect.any(Number),  // orphanBytesTotal
      4,                   // zombiesCleaned
      1,                   // zombiesRemaining
      expect.any(Number),  // eventsReconciled
      expect.any(Number),  // eventsDeleted
      expect.any(Number),  // durationMs
    );
  });
});

describe('storageReconciler — file_metadata uploaded_at', () => {
  it('uses ListObjectsV2 LastModified when present (primary path)', async (ctx) => {
    story(ctx, 'Happy path: lista S3 zawiera LastModified — reconciler propaguje go bezpośrednio do trackFileUpload jako uploaded_at. Bez HeadObject round-tripów, bo lista już niesie tę informację.');
    const lastMod = new Date('2026-03-02T11:22:33.000Z');
    mockListObjects.mockResolvedValue([
      { key: `${UUID}/2026/03/02/X.mp4`, size: 100, lastModified: lastMod },
    ]);

    await runStorageReconciliation();

    expect(mockHeadObject).not.toHaveBeenCalled();
    expect(mockTrackFileUpload).toHaveBeenCalledWith(
      USER.id,
      'recordings',
      `${UUID}/2026/03/02/X.mp4`,
      'X.mp4',
      100,
      lastMod,
    );
  });

  it('falls back to HeadObject when listing yields no LastModified', async (ctx) => {
    story(ctx, 'Edge case: S3-compat backend (MinIO or another S3-compatible store) zwraca obiekt bez LastModified w ListObjectsV2. Wcześniejszy bug spadał wtedy do DEFAULT NOW(), psując FIFO. Naprawiona ścieżka woła HeadObject jako authoritative źródło — to ten sam plik z S3, więc jego LastModified jest dostępny per-object.');
    const lastMod = new Date('2026-03-02T11:22:33.000Z');
    mockListObjects.mockResolvedValue([
      { key: `${UUID}/2026/03/02/X.mp4`, size: 100 },  // no lastModified
    ]);
    mockHeadObject.mockResolvedValue({ contentLength: 100, lastModified: lastMod });

    await runStorageReconciliation();

    expect(mockHeadObject).toHaveBeenCalledWith('recordings', `${UUID}/2026/03/02/X.mp4`, 'salt-7');
    expect(mockTrackFileUpload).toHaveBeenCalledWith(
      USER.id, 'recordings', `${UUID}/2026/03/02/X.mp4`, 'X.mp4', 100, lastMod,
    );
  });

  it('skips the row when HeadObject fallback also fails (no NOW() poison)', async (ctx) => {
    story(ctx, 'Regression guard dla 31009×08:03:41: jeżeli ani listing, ani HeadObject nie dadzą LastModified, reconciler MUSI pominąć ten wiersz zamiast wstawiać z DEFAULT NOW(). Następny tick spróbuje ponownie. Lepiej krótkotrwały brak FIFO entry niż trwały zlepiony klaster timestampów.');
    mockListObjects.mockResolvedValue([
      { key: `${UUID}/2026/03/02/X.mp4`, size: 100 },  // no lastModified
    ]);
    mockHeadObject.mockRejectedValue(new Error('S3 transient: 503 Service Unavailable'));

    await runStorageReconciliation();

    expect(mockHeadObject).toHaveBeenCalled();
    expect(mockTrackFileUpload).not.toHaveBeenCalled();
  });
});

describe('storageReconciler — orphan auto-purge', () => {
  it('deletes the S3 object + DB row for orphans older than the grace window', async (ctx) => {
    story(ctx, 'Pliki na S3 pod usuniętym userem (orphan) starsze niż 7 dni są automatycznie kasowane przez reconciler — bez tej logiki rzeczy zostawały tam bez końca (np. 16-plikowy orphan z 2026-04-12 wisiał 17 dni nie ruszony, kosztując nas miejsce na the object storeze).');
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'gone-uuid/2026/04/09/x.mp4', sizeBytes: 1000, firstSeenAt: '2026-04-09T00:00:00Z' },
      { id: 2, s3Bucket: 'thumbnails', s3Key: 'gone-uuid/__generated__/y.jpg', sizeBytes: 50, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).toHaveBeenCalledTimes(2);
    expect(mockDeleteObject).toHaveBeenCalledWith('recordings', 'gone-uuid/2026/04/09/x.mp4');
    expect(mockDeleteObject).toHaveBeenCalledWith('thumbnails', 'gone-uuid/__generated__/y.jpg');
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledWith(1);
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledWith(2);
  });

  it('skips auto-purge when an orphan UUID belongs to an active user (race guard)', async (ctx) => {
    story(ctx, 'Defensywa: jeśli między getOrphansOlderThan a pętlą skasowania user się zarejestrował z tym samym UUIDem (gdyby zaszło), pomijamy delete. Bezpieczniej zostawić plik orphan na 1 więcej tick niż przypadkowo skasować realnemu userowi.');
    mockGetAllUserUuids.mockResolvedValue(new Set([UUID, 'live-uuid']));
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 7, s3Bucket: 'recordings', s3Key: 'live-uuid/2026/04/09/x.mp4', sizeBytes: 1000, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('does NOT purge an object under an ADMIN uuid prefix (purge guard)', async (ctx) => {
    story(ctx, 'knownUuids (DETEKCJA) wyklucza adminów, więc obiekt pod prefixem admina ZOSTAJE upsertowany jako orphan dla widoczności — ale getAllUserUuidsAnyStatus (GUARD) zawiera UUID admina, więc auto-purge MUSI go pominąć. Inaczej dane admina lecą do kosza po 7 dniach.');
    const ADMIN_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Admin is absent from active-only knownUuids (detection set) but present
    // in the all-status guard set.
    mockGetAllUserUuids.mockResolvedValue(new Set([UUID]));
    mockGetAllUserUuidsAnyStatus.mockResolvedValue([UUID, ADMIN_UUID]);
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 9, s3Bucket: 'recordings', s3Key: `${ADMIN_UUID}/2026/04/09/x.mp4`, sizeBytes: 1000, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('does NOT purge an object under a non-active (mid-deletion) user prefix', async (ctx) => {
    story(ctx, 'User utknięty w stanie deletionStatus != active dłużej niż okno 7 dni: knownUuids go nie zawiera (detekcja go flaguje), ale guard getAllUserUuidsAnyStatus tak — więc jego pliki NIE są kasowane przez auto-purge. Ochrona przed data-loss path na koncie w trakcie usuwania.');
    const PENDING_UUID = '99999999-8888-7777-6666-555555555555';
    mockGetAllUserUuids.mockResolvedValue(new Set([UUID]));
    mockGetAllUserUuidsAnyStatus.mockResolvedValue([UUID, PENDING_UUID]);
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 11, s3Bucket: 'recordings', s3Key: `${PENDING_UUID}/2026/04/09/x.mp4`, sizeBytes: 2000, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('does NOT delete anything when CONFIG.orphanAutoPurgeEnabled is false (flag gate)', async (ctx) => {
    story(ctx, 'Flaga CLIPNEST_ORPHAN_AUTO_PURGE=false wyłącza destrukcyjny Step-2b: orphany dalej są wykrywane/upsertowane (widoczność dla admina), ale żaden deleteObject nie leci. Default to ENABLED, więc prod zachowanie bez zmiany — to jest opt-out.');
    mockConfig.orphanAutoPurgeEnabled = false;
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'gone-uuid/2026/04/09/x.mp4', sizeBytes: 1000, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('counts a partial S3 failure without aborting the reconciler', async (ctx) => {
    story(ctx, 'Jeden orphan-purge może paść (np. S3 chwilowo niedostępny) — reconciler nie powinien ubić całego ticka, tylko zalogować failure i jechać dalej. Następny tick (1 min) spróbuje ponownie.');
    mockGetOrphansOlderThan.mockResolvedValue([
      { id: 1, s3Bucket: 'recordings', s3Key: 'gone-uuid/a.mp4', sizeBytes: 100, firstSeenAt: '2026-04-09T00:00:00Z' },
      { id: 2, s3Bucket: 'recordings', s3Key: 'gone-uuid/b.mp4', sizeBytes: 200, firstSeenAt: '2026-04-09T00:00:00Z' },
    ]);
    mockDeleteObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('s3 transient error'));

    await runStorageReconciliation();

    // Only the successful one had its DB row deleted.
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledTimes(1);
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledWith(1);
  });
});

describe('storageReconciler — scanner notification after new file_metadata insert', () => {
  it('publishes scan-trigger when trackFileUpload returns inserted=true', async (ctx) => {
    story(ctx, 'Świeży orphan w S3 (np. root upload przez sync_reolink) — storageReconciler wstawia file_metadata i NATYCHMIAST powiadamia scanner przez stream:scan-trigger, żeby nie czekać do 24 h na full rescan.');
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'recordings' && prefix === `${UUID}/`) {
        return [{ key: `${UUID}/Driveway_01_20260526125625.mp4`, size: 100, lastModified: new Date() }];
      }
      return [];
    });
    mockTrackFileUpload.mockResolvedValue({ id: 42, inserted: true });
    mockPublishScanTrigger.mockResolvedValue(undefined);

    await runStorageReconciliation();

    expect(mockPublishScanTrigger).toHaveBeenCalledTimes(1);
    expect(mockPublishScanTrigger).toHaveBeenCalledWith(
      UUID,
      `${UUID}/Driveway_01_20260526125625.mp4`,
    );
  });

  it('does NOT publish scan-trigger when trackFileUpload returns inserted=false', async (ctx) => {
    story(ctx, 'Drugi przebieg reconcilera dla tego samego pliku — row już istnieje, trackFileUpload zwraca inserted=false, więc nie spamujemy scanner-a zduplikowanymi triggerami.');
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'recordings' && prefix === `${UUID}/`) {
        return [{ key: `${UUID}/Driveway_01_20260526125625.mp4`, size: 100, lastModified: new Date() }];
      }
      return [];
    });
    // Existing row → UPDATE-on-conflict path → inserted=false.
    mockTrackFileUpload.mockResolvedValue({ id: 42, inserted: false });

    await runStorageReconciliation();

    expect(mockTrackFileUpload).toHaveBeenCalledTimes(1);
    expect(mockPublishScanTrigger).not.toHaveBeenCalled();
  });

  it('publish failure is non-fatal — reconciler completes the pass', async (ctx) => {
    story(ctx, 'Redis chwilowo padł — XADD throwuje, ale outer reconciler i tak musi dokończyć resztę plików. Następny tick (1 min) spróbuje ponownie; jeśli row już istnieje, inserted=false i nie powtarzamy publishu.');
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'recordings' && prefix === `${UUID}/`) {
        return [
          { key: `${UUID}/a.mp4`, size: 10, lastModified: new Date() },
          { key: `${UUID}/b.mp4`, size: 20, lastModified: new Date() },
        ];
      }
      return [];
    });
    mockTrackFileUpload.mockResolvedValue({ id: 1, inserted: true });
    mockPublishScanTrigger
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);

    await expect(runStorageReconciliation()).resolves.toBeUndefined();

    expect(mockTrackFileUpload).toHaveBeenCalledTimes(2);
    expect(mockPublishScanTrigger).toHaveBeenCalledTimes(2);
  });
});

describe('storageReconciler — orphan sweep cadence split', () => {
  /** One orphaned thumbnail (no matching event row) under the live user. */
  function withOneOrphanThumb(): void {
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'thumbnails' && prefix === `${UUID}/__generated__/`) {
        return [{ key: `${UUID}/__generated__/gone.jpg`, size: 4321, lastModified: new Date() }];
      }
      return [];
    });
  }

  it('scans and purges by default, so every existing caller is unchanged', async (ctx) => {
    story(
      ctx,
      'Domyślka MUSI zostać włączona. Opcja została dodana wyłącznie po to, żeby 6-godzinny audyt mógł się wypiąć — gdyby domyślka była wyłączona, każdy inny wywołujący po cichu przestałby sprzątać, a zauważylibyśmy to dopiero po tygodniach narastania sterty.',
    );
    withOneOrphanThumb();

    await runStorageReconciliation();

    expect(mockUpsertOrphanObjects).toHaveBeenCalled();
    const flushed = mockUpsertOrphanObjects.mock.calls.flatMap((c) => c[0] as unknown[]);
    expect(flushed).toHaveLength(1);
    expect(mockGetOrphansOlderThan).toHaveBeenCalled();
  });

  it('skips detection AND purge when the sweep is off', async (ctx) => {
    story(
      ctx,
      'To jest tryb 6-godzinnego audytu. Skan S3 zżerał 504 s z 540 s deadline’u, więc retencja, quota tidy i czyszczenie upload_events — wszystko, co leci PO nim — nigdy się nie wykonywało. Pominięcie musi objąć też purge: kasowanie na podstawie wierszy, których ten przebieg nie odświeżył, byłoby działaniem na nieaktualnym stanie.',
    );
    withOneOrphanThumb();

    await runStorageReconciliation({ scanOrphans: false });

    expect(mockUpsertOrphanObjects).not.toHaveBeenCalled();
    expect(mockGetOrphansOlderThan).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('still reconciles disk usage when the sweep is off', async (ctx) => {
    story(
      ctx,
      'Rozdział ma zdjąć z audytu TYLKO skan sierot. Korekta użycia dysku musi zostać, bo to ona zasila klucz FIFO, po którym retencja wybiera najstarsze pliki — gdyby wypadła razem ze skanem, retencja kasowałaby według nieaktualnych danych.',
    );
    mockListObjects.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'recordings' && prefix === `${UUID}/`) {
        return [{ key: `${UUID}/2026/07/26/Front_00_X.mp4`, size: 5000, lastModified: new Date() }];
      }
      return [];
    });
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 1, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });

    await runStorageReconciliation({ scanOrphans: false });

    expect(mockSetDiskUsageAbsolute).toHaveBeenCalledWith(7, 5000);
  });
});

describe('orphan classification', () => {
  it('recognises the two per-object shapes and nothing else', (ctx) => {
    story(
      ctx,
      'Klasyfikator decyduje, KTÓRY strażnik chroni dany obiekt, więc pomyłka w stronę luźniejszej gałęzi mogłaby skasować żywy plik. Dlatego jest ścisły i wszystko, co nie pasuje DOKŁADNIE, spada do `unowned_prefix`, czyli pod zachowawczy strażnik prefiksowy.',
    );
    expect(classifyOrphan('thumbnails', `${UUID}/__generated__/evt.jpg`, BUCKETS)).toBe('orphan_thumb');
    expect(classifyOrphan('sidecars', `${UUID}/2026/07/26/C_00_1.mp4.frames`, BUCKETS)).toBe('orphan_sidecar');
    // Right bucket, wrong shape → conservative branch.
    expect(classifyOrphan('thumbnails', `${UUID}/__generated__/evt.png`, BUCKETS)).toBe('unowned_prefix');
    expect(classifyOrphan('thumbnails', `${UUID}/other/evt.jpg`, BUCKETS)).toBe('unowned_prefix');
    // A bare recording in the sidecars bucket is not a sidecar (no suffix).
    expect(classifyOrphan('sidecars', `${UUID}/2026/07/26/C_00_1.mp4`, BUCKETS)).toBe('unowned_prefix');
    // Recordings bucket is never per-object.
    expect(classifyOrphan('recordings', `${UUID}/2026/07/26/C_00_1.mp4`, BUCKETS)).toBe('unowned_prefix');
  });

  it('recognises FTPS folder markers, and only real date-tree ones', (ctx) => {
    story(
      ctx,
      'Trzecia klasa per-obiekt (krok 1d). Bez niej znaczniki katalogów pod żywymi użytkownikami zostawały pod strażnikiem prefiksowym — 193 sztuki przetrwały cztery kolejne sweepy z `0 auto-purged`. Sam korzeń konta `{uuid}/` NIE jest znacznikiem drzewa dat i nie wolno go tak potraktować.',
    );
    expect(classifyOrphan('recordings', `${UUID}/2026/03/`, BUCKETS)).toBe('folder_marker');
    expect(classifyOrphan('recordings', `${UUID}/2026/07/16/`, BUCKETS)).toBe('folder_marker');
    // Account root — not a marker.
    expect(classifyOrphan('recordings', `${UUID}/`, BUCKETS)).toBe('unowned_prefix');
    // A real object, not a marker.
    expect(classifyOrphan('recordings', `${UUID}/2026/03/a.mp4`, BUCKETS)).toBe('unowned_prefix');
    // Markers only exist in the recordings bucket.
    expect(classifyOrphan('sidecars', `${UUID}/2026/03/`, BUCKETS)).toBe('unowned_prefix');
  });

  it('parses parents, and refuses when it cannot', (ctx) => {
    story(ctx, 'Nieparsowalny klucz musi dać null, bo null jest w isStillOrphaned tłumaczony na „nie kasuj".');
    expect(thumbEventId(`${UUID}/__generated__/abc.jpg`)).toBe('abc');
    expect(thumbEventId(`${UUID}/__generated__/.jpg`)).toBeNull();
    expect(thumbEventId(`${UUID}/nope/abc.jpg`)).toBeNull();
    expect(sidecarParentKey(`${UUID}/2026/a.mp4.frames`)).toBe(`${UUID}/2026/a.mp4`);
    expect(sidecarParentKey('nofolder.mp4.frames')).toBeNull();
  });
});

describe('isStillOrphaned — fails closed', () => {
  beforeEach(() => {
    mockGetEventByIdAnyOwner.mockResolvedValue(undefined);
    mockGetFileMetadataByKey.mockResolvedValue(null);
    mockHasFileMetadataUnderPrefix.mockResolvedValue(false);
  });

  it('says orphaned only when the parent is genuinely absent', async (ctx) => {
    story(ctx, 'Ścieżka pozytywna: rodzic zniknął, więc obiekt jest nieosiągalny i wolno go skasować.');
    expect(await isStillOrphaned('orphan_thumb', `${UUID}/__generated__/gone.jpg`)).toBe(true);
    expect(await isStillOrphaned('orphan_sidecar', `${UUID}/2026/a.mp4.frames`)).toBe(true);
  });

  it('refuses when the parent came back', async (ctx) => {
    story(
      ctx,
      'To jest powód, dla którego weryfikacja jest PONAWIANA tuż przed kasowaniem, a nie brana ze zbioru policzonego na starcie skanu. Zdarzenie mogło zostać ponownie zaingestowane, a sidecar wygenerowany na nowo, w ciągu 7 dni okna karencji.',
    );
    mockGetEventByIdAnyOwner.mockResolvedValue({ id: 'back' });
    expect(await isStillOrphaned('orphan_thumb', `${UUID}/__generated__/back.jpg`)).toBe(false);

    mockGetFileMetadataByKey.mockResolvedValue({ id: 1, s3Key: 'x' });
    expect(await isStillOrphaned('orphan_sidecar', `${UUID}/2026/a.mp4.frames`)).toBe(false);
  });

  it('keeps a folder marker that still has live recordings under it', async (ctx) => {
    story(
      ctx,
      'Najniebezpieczniejszy przypadek w tej klasie. Znacznik reprezentuje CAŁE poddrzewo, więc skasowanie go, gdy pod spodem są jeszcze żywe nagrania, usuwałoby strukturę wciąż w użyciu. Sprawdzenie musi pytać o zawartość poddrzewa, a nie o sam znacznik.',
    );
    mockHasFileMetadataUnderPrefix.mockResolvedValue(true);
    expect(await isStillOrphaned('folder_marker', `${UUID}/2026/03/`)).toBe(false);

    mockHasFileMetadataUnderPrefix.mockResolvedValue(false);
    expect(await isStillOrphaned('folder_marker', `${UUID}/2026/03/`)).toBe(true);
  });

  it('refuses a folder marker whose key does not end in a slash', async (ctx) => {
    story(
      ctx,
      'Obrona w głąb. Prefiksowe LIKE na kluczu bez końcowego `/` zamienia test poddrzewa w test podciągu i mogłoby dopasować sąsiedni katalog — `2026/03` złapałoby `2026/030`. Klasyfikator już to sprawdza; weryfikacja sprawdza ponownie, żeby własność bezpieczeństwa została w tej samej funkcji, która kasuje.',
    );
    expect(await isStillOrphaned('folder_marker', `${UUID}/2026/03`)).toBe(false);
    expect(mockHasFileMetadataUnderPrefix).not.toHaveBeenCalled();
  });

  it('refuses on an unparseable key rather than guessing', async (ctx) => {
    story(ctx, 'Fail-closed: gdy nie umiemy wyznaczyć rodzica, nie mamy CZEGO sprawdzić — a brak dowodu nie jest dowodem braku.');
    expect(await isStillOrphaned('orphan_thumb', `${UUID}/__generated__/.jpg`)).toBe(false);
    expect(await isStillOrphaned('orphan_sidecar', 'nofolder.mp4.frames')).toBe(false);
    expect(mockGetEventByIdAnyOwner).not.toHaveBeenCalled();
  });
});

describe('auto-purge — per-object guard', () => {
  const THUMB_KEY = `${UUID}/__generated__/deadevent.jpg`;
  const oldOrphan = (bucket: string, key: string) => ({
    id: 1, s3Bucket: bucket, s3Key: key, sizeBytes: 100,
    firstSeenAt: '2026-06-18T00:00:00Z', lastSeenAt: '2026-07-26T00:00:00Z', seenCount: 400,
  });

  it('DELETES a per-object orphan under a live user — the whole point', async (ctx) => {
    story(
      ctx,
      'Regresja, przez którą uzbierały się sieroty z „0 auto-purged". Strażnik prefiksowy pomijał KAŻDĄ sierotę pod żywym użytkownikiem — a kroki 1c/1c2 wykrywają wyłącznie takie. Wykrywanie i kasowanie wzajemnie się wykluczały.',
    );
    // UUID is a live, protected user — under the old guard this was an
    // unconditional `continue`, which is exactly the bug.
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('thumbnails', THUMB_KEY)]);

    await runStorageReconciliation();

    expect(mockDeleteObject).toHaveBeenCalledWith('thumbnails', THUMB_KEY);
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledWith(1);
  });

  it('DELETES an empty folder marker under a live user', async (ctx) => {
    story(
      ctx,
      'Trzecia klasa, ta sama blokada. 193 znaczniki katalogów przetrwały cztery kolejne sweepy po v0.10.493 z `0 auto-purged`, bo klasyfikator odsyłał cały bucket recordings pod strażnik prefiksowy. Zero bajtów, więc bez kosztu miejsca — ale pozostawiona wiadoma-zepsuta klasa sugeruje następnemu czytającemu, że tak ma być.',
    );
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('recordings', `${UUID}/2026/03/`)]);
    mockHasFileMetadataUnderPrefix.mockResolvedValue(false); // subtree empty

    await runStorageReconciliation();

    expect(mockDeleteObject).toHaveBeenCalledWith('recordings', `${UUID}/2026/03/`);
  });

  it('does NOT delete a folder marker that still has live recordings beneath it', async (ctx) => {
    story(ctx, 'Znacznik reprezentuje poddrzewo. Dopóki cokolwiek pod nim żyje, kasowanie go usuwałoby strukturę wciąż w użyciu.');
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('recordings', `${UUID}/2026/03/`)]);
    mockHasFileMetadataUnderPrefix.mockResolvedValue(true);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('does NOT delete when the parent event reappeared, and clears the stale row', async (ctx) => {
    story(ctx, 'Rodzic wrócił w oknie karencji — obiekt jest znowu osiągalny. Wiersz sieroty trzeba usunąć, żeby przestał być co dzień przelistowywany.');
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('thumbnails', THUMB_KEY)]);
    mockGetEventByIdAnyOwner.mockResolvedValue({ id: 'deadevent' });

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).toHaveBeenCalledWith(1);
  });

  it('skips (never deletes) when re-verification throws', async (ctx) => {
    story(ctx, 'Błąd bazy w trakcie weryfikacji nie może zostać zinterpretowany jako „sierota". Pomijamy i wracamy jutro.');
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('thumbnails', THUMB_KEY)]);
    mockGetEventByIdAnyOwner.mockRejectedValue(new Error('db down'));

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('STILL protects an unowned-prefix orphan owned by an admin — guard intact', async (ctx) => {
    story(
      ctx,
      'Rdzeń guardu prefiksowego. Obiekt w buckecie recordings pod prefiksem admina (lub użytkownika zawieszonego w kasowaniu) trafia do gałęzi `unowned_prefix` i musi być dalej chroniony niezmienionym strażnikiem. Ta zmiana NIE MOŻE poluzować tej klasy.',
    );
    const ADMIN = '99999999-8888-7777-6666-555555555555';
    mockGetAllUserUuids.mockResolvedValue(new Set([UUID]));            // detection set: admin absent
    mockGetAllUserUuidsAnyStatus.mockResolvedValue([UUID, ADMIN]);     // purge guard: admin present
    mockGetOrphansOlderThan.mockResolvedValue([
      oldOrphan('recordings', `${ADMIN}/2026/07/26/Cam_00_1.mp4`),
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteOrphanObjectRow).not.toHaveBeenCalled();
  });

  it('deletes a genuinely unowned prefix, so the original feature still works', async (ctx) => {
    story(ctx, 'Kontrola po drugiej stronie: prefiks bez ŻADNEGO użytkownika to pierwotny przypadek użycia auto-purge i musi dalej działać.');
    mockGetOrphansOlderThan.mockResolvedValue([
      oldOrphan('recordings', 'deadbeef-0000-0000-0000-000000000000/2026/x.mp4'),
    ]);

    await runStorageReconciliation();

    expect(mockDeleteObject).toHaveBeenCalled();
  });

  it('stops cleanly at the time budget instead of being killed mid-drain', async (ctx) => {
    story(
      ctx,
      'Bez limitu liczbowego jedynym ogranicznikiem jest zegar. Nawis ~59 tys. obiektów x ~40 ms to ~39 minut, czyli WIĘCEJ niż 30-minutowy deadline sweepa — job zostałby ubity w połowie. Kasowania są commitowane pojedynczo, więc nic nie ginie, ale job raportowałby porażkę i gubił podsumowanie: dokładnie ten kształt awarii, który przed chwilą usunęliśmy z audytu. Musi zatrzymać się sam i oddać resztę jutrzejszemu przebiegowi.',
    );
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      s3Bucket: 'thumbnails',
      s3Key: `${UUID}/__generated__/e${i}.jpg`,
      sizeBytes: 10,
      firstSeenAt: '2026-06-18T00:00:00Z',
      lastSeenAt: '2026-07-26T00:00:00Z',
      seenCount: 1,
    }));
    mockGetOrphansOlderThan.mockResolvedValue(many);

    // Jump the clock past the 25-min budget once a few objects are gone.
    const realNow = Date.now;
    const t0 = realNow();
    let deleted = 0;
    mockDeleteObject.mockImplementation(async () => { deleted++; });
    vi.spyOn(Date, 'now').mockImplementation(() =>
      deleted >= 3 ? t0 + 26 * 60_000 : t0,
    );

    try {
      await runStorageReconciliation();
    } finally {
      vi.mocked(Date.now).mockRestore();
    }

    // Stopped early — nowhere near all 40 — but did real work before stopping.
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(many.length);
  });

  it('respects the CLIPNEST_ORPHAN_AUTO_PURGE kill switch for per-object orphans too', async (ctx) => {
    story(ctx, 'Wyłącznik awaryjny musi obejmować NOWĄ gałąź. Gdyby ją omijał, jedyny sposób na szybkie zatrzymanie kasowania na produkcji przestałby działać dokładnie dla klasy, którą ta zmiana odblokowuje.');
    mockConfig.orphanAutoPurgeEnabled = false;
    mockGetOrphansOlderThan.mockResolvedValue([oldOrphan('thumbnails', THUMB_KEY)]);

    await runStorageReconciliation();

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

describe('storageReconciler — step 1 time budget', () => {
  const manyUsers = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    uuid: `${i}1111111-2222-3333-4444-555555555555`,
    encryptionSalt: `salt-${i}`,
  }));

  function withUsers(): Set<string> {
    mockGetUsersForScan.mockResolvedValue(manyUsers);
    mockGetAllUserUuids.mockResolvedValue(new Set(manyUsers.map((u) => u.uuid)));
    mockGetAllUserUuidsAnyStatus.mockResolvedValue(manyUsers.map((u) => u.uuid));
    const seen = new Set<string>();
    mockListObjects.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix) seen.add(prefix.split('/')[0]);
      return [];
    });
    return seen;
  }

  it('stops the per-user pass at its budget so the destructive passes still run', async (ctx) => {
    story(
      ctx,
      'To jest ta sama awaria co przy purge, tylko o pass wcześniej. Pass 1 rośnie razem z bucketem (na prodzie 255s -> 296s w 12h przy stałym deadline 540s), a KAŻDY pass który kasuje dane użytkownika biegnie PO nim. Gdy pass 1 zje cały budżet, job ginie na DeadlineExceeded i retencja po cichu przestaje działać — dokładnie to, przed czym ostrzega docstring audit-once. Pass 1 musi zatrzymać się sam i oddać resztę następnemu przebiegowi, zamiast zagłodzić kasowanie.',
    );
    const seen = withUsers();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() =>
      seen.size >= 3 ? t0 + 5 * 60_000 : t0,
    );

    await runStorageReconciliation({ scanOrphans: false, stepOneBudgetMs: 4 * 60_000 });

    // Stopped early — did NOT walk every user.
    expect(seen.size).toBeLessThan(manyUsers.length);
    // …and the run still finished cleanly, so passes 2-7 in audit-once are reachable.
    expect(mockCreateReconciliationRun).toHaveBeenCalled();
  });

  it('walks every user when the budget is not exceeded', async (ctx) => {
    story(
      ctx,
      'Kontrola przeciwna: budżet nie może obcinać przebiegu, który się w nim mieści. Bez tego testu "zatrzymuje się wcześnie" przechodziłoby też dla implementacji, która po prostu zawsze urywa pętlę.',
    );
    const seen = withUsers();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0);

    await runStorageReconciliation({ scanOrphans: false, stepOneBudgetMs: 4 * 60_000 });

    expect(seen.size).toBe(manyUsers.length);
  });

  it('is unbounded when no budget is given, so the daily sweep is unchanged', async (ctx) => {
    story(
      ctx,
      'Budżet jest opcją, nie nową zasadą globalną — dokładnie jak scanOrphans. Dzienny orphan-sweep ma własny deadline 1800s i musi nadal przechodzić WSZYSTKICH użytkowników; gdyby domyślnie obowiązywał go limit audytu, naprawa jednego joba po cichu okroiłaby drugi.',
    );
    const seen = withUsers();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + 60 * 60_000);

    await runStorageReconciliation({ scanOrphans: false });

    expect(seen.size).toBe(manyUsers.length);
  });

  it('rotates which user the pass starts from, so the tail is not starved forever', async (ctx) => {
    story(
      ctx,
      'Obcinanie pętli zawsze w tej samej kolejności zamienia jedną awarię w drugą: użytkownicy z końca listy nie byliby reconcilowani NIGDY, a to ich file_metadata karmi FIFO retencji. Offset rotuje z czasem, więc każdy przebieg zaczyna od innego użytkownika i pokrycie wyrównuje się w ciągu doby — bez nowej kolumny w schemacie.',
    );
    const firstOf = async (clockMs: number): Promise<string> => {
      vi.resetAllMocks();
      mockConfig.orphanAutoPurgeEnabled = true;
      mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 0, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
      mockGetUserByUuid.mockResolvedValue({ uuid: manyUsers[0].uuid, username: 'tester' });
      mockGetEventRefsByOwner.mockResolvedValue([]);
      mockCleanupOldZombieEvents.mockResolvedValue(0);
      mockCountZombieEvents.mockResolvedValue(0);
      mockCreateReconciliationRun.mockResolvedValue(1);
      mockGetOrphansOlderThan.mockResolvedValue([]);
      mockGetFileMetadataKeysByOwner.mockResolvedValue([]);
      mockSetDiskUsageAbsolute.mockResolvedValue(undefined);
      const order: string[] = [];
      mockGetUserIdsWithUnfinishedContentDeletion.mockResolvedValue(new Set());
      mockGetUsersForScan.mockResolvedValue(manyUsers);
      mockGetAllUserUuids.mockResolvedValue(new Set(manyUsers.map((u) => u.uuid)));
      mockGetAllUserUuidsAnyStatus.mockResolvedValue(manyUsers.map((u) => u.uuid));
      mockListObjects.mockImplementation(async (_b: string, prefix: string) => {
        const u = prefix ? prefix.split('/')[0] : '';
        if (u && !order.includes(u)) order.push(u);
        return [];
      });
      vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
      await runStorageReconciliation({ scanOrphans: false, stepOneBudgetMs: 4 * 60_000 });
      return order[0];
    };

    const runA = await firstOf(0);
    const runB = await firstOf(6 * 3600_000);

    expect(runA).not.toBe(runB);
  });
});
