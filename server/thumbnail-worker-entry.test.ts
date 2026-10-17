import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from './testing/story.js';

// Hoisted mocks — every external touched by the worker entry is replaced
// before the module evaluates so its top-level `await initDb()` and
// `consume(...)` calls are no-ops.
const {
  mockInitDb,
  mockGetEventByIdForOwner,
  mockUpdateEventThumbnail,
  mockUpdateEventDuration,
  mockGetMissingDurationEvents,
  mockGetFileMetadataByKey,
  mockCreateNotification,
  mockIncrementThumbnailAttempts,
  mockCollapseEventView,
  mockRecomputeEventsPlaybackReadyForFile,
  mockRecomputeEventsPlaybackReadyForEvent,
  mockGetUsersForScan,
  mockGenerateSidecarForFile,
  mockGetDurationSecondsFromExistingSidecar,
  mockGetObject,
  mockPutObject,
  mockHeadObject,
  mockConsume,
  mockClearThumbnailDedup,
  mockStartHealthzServer,
  mockRunFfmpegFromFile,
  mockPipelineToFile,
  mockStreamToSparseFile,
  mockStreamToBuffer,
  mockSeedSparseFromBuffer,
} = vi.hoisted(() => {
  // Loose `(...unknown[]) => unknown` signature so each spread-args wrapper
  // below stays compatible with the heterogeneous DB / S3 / ffmpeg shapes
  // without per-mock generics. vitest 4's stricter `Mock<Procedure>` default
  // refuses to be called via `mockX(...args)` otherwise.
  const make = () => vi.fn<(...args: unknown[]) => unknown>();
  return {
    mockInitDb: make(),
    mockGetEventByIdForOwner: make(),
    mockUpdateEventThumbnail: make(),
    mockUpdateEventDuration: make(),
    mockGetMissingDurationEvents: make(),
    mockGetFileMetadataByKey: make(),
    mockCreateNotification: make(),
    mockIncrementThumbnailAttempts: make(),
    mockCollapseEventView: make(),
    mockRecomputeEventsPlaybackReadyForFile: make(),
    mockRecomputeEventsPlaybackReadyForEvent: make(),
    mockGetUsersForScan: make(),
    mockGenerateSidecarForFile: make(),
    mockGetDurationSecondsFromExistingSidecar: make(),
    mockGetObject: make(),
    mockPutObject: make(),
    mockHeadObject: make(),
    mockConsume: make(),
    mockClearThumbnailDedup: make(),
    mockStartHealthzServer: make(),
    mockRunFfmpegFromFile: make(),
    mockPipelineToFile: make(),
    mockStreamToSparseFile: make(),
    mockStreamToBuffer: make(),
    mockSeedSparseFromBuffer: make(),
  };
});

vi.mock('./sentry.js', () => ({}));

vi.mock('./db/index.js', () => ({
  initDb: (...a: unknown[]) => mockInitDb(...a),
}));
vi.mock('./db/queries/events.js', () => ({
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
  getEventByIdForOwner: (...a: unknown[]) => mockGetEventByIdForOwner(...a),
  updateEventThumbnail: (...a: unknown[]) => mockUpdateEventThumbnail(...a),
  updateEventDuration: (...a: unknown[]) => mockUpdateEventDuration(...a),
  getMissingDurationEvents: (...a: unknown[]) => mockGetMissingDurationEvents(...a),
  getFileMetadataByKey: (...a: unknown[]) => mockGetFileMetadataByKey(...a),
  incrementThumbnailAttempts: (...a: unknown[]) => mockIncrementThumbnailAttempts(...a),
  collapseEventView: (...a: unknown[]) => mockCollapseEventView(...a),
  recomputeEventsPlaybackReadyForFile: (...a: unknown[]) =>
    mockRecomputeEventsPlaybackReadyForFile(...a),
  recomputeEventsPlaybackReadyForEvent: (...a: unknown[]) =>
    mockRecomputeEventsPlaybackReadyForEvent(...a),
}));
vi.mock('./db/queries/notifications.js', () => ({
  createNotification: (...a: unknown[]) => mockCreateNotification(...a),
}));
vi.mock('./db/queries/storage.js', () => ({
  getUsersForScan: (...a: unknown[]) => mockGetUsersForScan(...a),
}));

vi.mock('./services/s3.js', () => ({
  getObject: (...a: unknown[]) => mockGetObject(...a),
  putObject: (...a: unknown[]) => mockPutObject(...a),
  headObject: (...a: unknown[]) => mockHeadObject(...a),
}));

vi.mock('./services/fmp4PatchWorker.js', () => ({
  generateSidecarForFile: (...a: unknown[]) => mockGenerateSidecarForFile(...a),
  getDurationSecondsFromExistingSidecar: (...a: unknown[]) =>
    mockGetDurationSecondsFromExistingSidecar(...a),
}));

// HandledTransientError mirrors the real class — the outer wrapper in
// processThumbnailJob throws an instance to signal "already classified" to
// streamsClient. Tests assert `.message` is preserved, so the shape here just
// needs to pass `instanceof Error` and carry the wrapped error's message.
class MockHandledTransientError extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = 'HandledTransientError';
  }
}

vi.mock('./services/streamsClient.js', () => ({
  consume: (...a: unknown[]) => mockConsume(...a),
  clearThumbnailDedup: (...a: unknown[]) => mockClearThumbnailDedup(...a),
  HandledTransientError: MockHandledTransientError,
  // No-op stubs for the cleanup helper — the real one walks XINFO CONSUMERS
  // every hour, which we don't want firing in unit tests. Returns a noop
  // disposer so the import-time call site at the bottom of
  // thumbnail-worker-entry.ts works.
  scheduleStaleConsumerCleanup: () => () => {},
  STREAM_THUMBNAIL_GENERATE: 'stream:thumbnail',
  STREAM_DLQ_THUMBNAIL: 'stream:thumbnail-dlq',
  GROUP_THUMBNAIL_WORKERS: 'thumbnail-workers',
  // R3: the worker took over the delete-notify consumer from the retired
  // event-manager — the entry module now imports these at load time.
  STREAM_DELETE_NOTIFY: 'stream:delete-notify',
  GROUP_EVENT_MANAGERS: 'event-managers',
}));

vi.mock('./services/thumbnailFfmpeg.js', () => ({
  runFfmpegFromFile: (...a: unknown[]) => mockRunFfmpegFromFile(...a),
  pipelineToFile: (...a: unknown[]) => mockPipelineToFile(...a),
  streamToSparseFile: (...a: unknown[]) => mockStreamToSparseFile(...a),
  streamToBuffer: (...a: unknown[]) => mockStreamToBuffer(...a),
  seedSparseFromBuffer: (...a: unknown[]) => mockSeedSparseFromBuffer(...a),
}));

vi.mock('./utils/healthz.js', () => ({
  startHealthzServer: (...a: unknown[]) => mockStartHealthzServer(...a),
}));

vi.mock('./services/fileLifecycle.js', () => ({
  deleteRecordingAllBuckets: vi.fn(),
}));

vi.mock('./config.js', () => ({
  CONFIG: {
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
  },
}));

const {
  processThumbnailJob,
  SIDECAR_TRANSIENT_MARKER,
  SIDECAR_MISSING_VIEW_MARKER,
  isTransientWorkerError,
  isFreshRecordingForPush,
  shouldAnnounceNewRecording,
  recordingArrivedAt,
  handleBudgetExceededView,
} = await import('./thumbnail-worker-entry.js');

beforeEach(() => {
  // resetAllMocks clears BOTH call history AND implementations — necessary so
  // a `mockRejectedValue` set in one test doesn't bleed into the next via the
  // hoisted mock instance.
  vi.resetAllMocks();
});

describe('processThumbnailJob — sidecar transient classification', () => {
  it('re-throws sidecar transient errors instead of tombstoning the event', async (ctx) => {
    story(
      ctx,
      'Bug: wysyłane były powiadomienia "thumbnail_failed", mimo że file_metadata.processing_state != unplayable i nie było żadnych wpisów w processing_failures. Przyczyna — runSidecarStage rzucał Error("sidecar transient error ..."), outer catch nie matchował CONNECT_TIMEOUT_MARKER i wpadał w forceTombstoneEvent (= notyfikacja). Teraz sidecar-transient = re-throw, XCLAIM przejmuje, brak notyfikacji.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 7, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-1',
      ownerId: 7,
      views: [{ id: '00', videoRelPath: 'recordings/cam1/clip.mp4' }],
      // `thumbnail` already set so processThumbnailJob takes the early-return
      // path that runs runSidecarStage directly — no S3/ffmpeg work needed.
      thumbnail: '__s3_thumb__/user-uuid/evt-1.jpg',
    });
    mockGetFileMetadataByKey.mockResolvedValue({ id: 99 });
    mockHeadObject.mockResolvedValue({ contentLength: 1_234_567, lastModified: new Date() });
    mockGenerateSidecarForFile.mockResolvedValue({
      result: 'transient-error',
      reason: 'sidecar PUT failed: NoSuchBucket',
    });

    let caught: unknown = null;
    try {
      await processThumbnailJob({ eventId: 'evt-1', ownerId: 7, notify: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(SIDECAR_TRANSIENT_MARKER);
    expect((caught as Error).message).toContain('sidecar PUT failed: NoSuchBucket');
    // The whole point of the fix: NO tombstone, NO notification.
    expect(mockUpdateEventThumbnail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    // And the retry-budget counter is NOT bumped on the early-return path,
    // because runSidecarStage runs before incrementThumbnailAttempts is reached.
    expect(mockIncrementThumbnailAttempts).not.toHaveBeenCalled();
  });

  it('treats Postgres 40P01 "deadlock detected" as transient — re-throws, no tombstone', async (ctx) => {
    story(
      ctx,
      'Bug: eventy wpadały w tombstone+notyfikacje po jednej próbie, bo outer catch nie matchował "deadlock detected" (pg 40P01) na worker-side UPDATE events. Marker dodany do isTransientWorkerError → re-throw → XCLAIM przejmuje.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 7, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-3',
      ownerId: 7,
      views: [{ id: '00', videoRelPath: 'recordings/cam1/clip.mp4' }],
      thumbnail: null,
    });
    // The first DB write inside processThumbnailJob — the atomic
    // increment-attempts UPDATE — loses a deadlock cycle and surfaces the
    // verbatim pg server message. This stands in for any later events-row
    // UPDATE inside the same job (updateEventDuration, updateEventThumbnail);
    // they'd all surface the same shape and route through the same outer catch.
    mockIncrementThumbnailAttempts.mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    let caught: unknown = null;
    try {
      await processThumbnailJob({ eventId: 'evt-3', ownerId: 7, notify: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('deadlock detected');
    // No tombstone path executed — never a follow-up UPDATE to '__unplayable__',
    // and definitely no user-facing notification.
    expect(mockUpdateEventThumbnail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('treats local 120s withTimeout error as transient — re-throws, no tombstone', async (ctx) => {
    story(
      ctx,
      'Druga połowa fixu z 2026-05-10: gdy ffmpeg/S3 zawiesi się na >120s, withTimeout w consume-handlerze rzuca "thumbnail job <id> timed out after 120000ms". Wcześniej outer catch klasyfikował to jako permanent → tombstone+notyfikacja. Po fixie: re-throw → XCLAIM ponowi z budżetu retry.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 7, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-4',
      ownerId: 7,
      views: [{ id: '00', videoRelPath: 'recordings/cam1/slow.mp4' }],
      thumbnail: null,
    });
    mockIncrementThumbnailAttempts.mockResolvedValue(1);
    mockHeadObject.mockResolvedValue({ contentLength: 1024 });
    mockGetObject.mockResolvedValue({ body: { /* unused */ } });
    // Simulate the withTimeout rejection bubbling INTO processThumbnailJob's
    // catch — the message format mirrors the wrapper's template at the
    // bottom of thumbnail-worker-entry.ts (label + "timed out after Nms").
    mockRunFfmpegFromFile.mockRejectedValue(
      new Error('thumbnail job evt-4 timed out after 120000ms'),
    );

    let caught: unknown = null;
    try {
      await processThumbnailJob({ eventId: 'evt-4', ownerId: 7, notify: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('timed out after 120000ms');
    expect(mockUpdateEventThumbnail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('clears dedup + throws transient when a referenced view has no file_metadata yet (dual-view upload race)', async (ctx) => {
    story(
      ctx,
      'Bug: Reolink wysyła widoki w odstępie od kilku sekund do kilku minut (np. Back_01 (zoom) przed Back_00 (wide)). Scanner paruje oba w events od razu z patternu nazwy, worker odpala zanim istnieje file_metadata drugiego widoku → wcześniej silent `continue` + ack. SETNX 600s blokował każdy republish reconcilera; plik utykał na "Processing One File" na ~11 minut do wygaśnięcia TTL. Fix: clear thumbnail-published:<eventId> + throw z markerem missing-view → XCLAIM retry za 30s ORAZ kolejny tick reconcilera (≤1min) dostaje świeży publish.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-dual-race',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/05/15/Back_00_20260515152536.mp4' }, { id: '01', videoRelPath: '2026/05/15/Back_01_20260515152536.mp4' }],
      // Already has thumbnail → early-return path into runSidecarStage. This
      // mirrors the prod scenario where the first publish generated the
      // thumbnail+sidecar for zoom, then the racy republish keeps coming back
      // through this branch trying to sidecar the still-unborn wide.
      thumbnail: '__s3_thumb__/user-uuid/evt-dual-race.jpg',
    });
    // First view (wide=Back_00) — file_metadata not yet inserted (race).
    // Second view (zoom=Back_01) — exists & sidecar already done. The worker
    // iterates wide first (the runSidecarStage loop preserves [wide, zoom]
    // order), so it should bail before ever asking for zoom.
    mockGetFileMetadataByKey.mockResolvedValueOnce(null);
    mockGetFileMetadataByKey.mockResolvedValueOnce({ id: 26187072 });
    mockClearThumbnailDedup.mockResolvedValue(undefined);

    let caught: unknown = null;
    try {
      await processThumbnailJob({ eventId: 'evt-dual-race', ownerId: 22, notify: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(SIDECAR_MISSING_VIEW_MARKER);
    // Classified transient → outer catch re-throws, no tombstone, no toast.
    expect(isTransientWorkerError((caught as Error).message)).toBe(true);
    expect(mockUpdateEventThumbnail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    // The whole point: dedup MUST be cleared so reconciler can republish on
    // the next minute tick instead of waiting 600s for SETNX TTL.
    expect(mockClearThumbnailDedup).toHaveBeenCalledTimes(1);
    expect(mockClearThumbnailDedup).toHaveBeenCalledWith('evt-dual-race');
    // Early exit on first view — we should NOT have asked S3 to HEAD or
    // generated a sidecar for either side; the loop bails on the missing row.
    expect(mockGenerateSidecarForFile).not.toHaveBeenCalled();
    expect(mockHeadObject).not.toHaveBeenCalled();
    // No collapse on the first attempt — that's an escape-hatch after the
    // budget exhausts, not a first-response.
    expect(mockCollapseEventView).not.toHaveBeenCalled();
  });

  it('collapses dual-view event to single-view once missing-view retries exhaust the budget', async (ctx) => {
    story(
      ctx,
      'Dual-view event, w którym jedna soczewka ma file_metadata, a druga zginęła (np. skasował ją auto-delete-oldest), generował setki eventów "sidecar missing view file_metadata" na jednego użytkownika. Wcześniej każda próba rzucała transient → XCLAIM + reconciler ponawiały bez końca, bo retry-budget odpalał się TYLKO w path "brak thumbnaila" (events z ustawionym thumbnailem w ogóle nie tickowały licznika). Fix: missing-view block tickuje TEN SAM licznik i po THUMBNAIL_RETRY_BUDGET próbach zwija event do single-view (NULL na missing view column), żeby getEventsMissingSidecar przestał go matchować.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 42, uuid: 'user-uuid-e730bd1e', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-stuck-april',
      ownerId: 42,
      // wide view FM is the one that's permanently gone — pattern from H1.
      views: [{ id: '00', videoRelPath: '2026/04/22/Front_00_20260422161011.mp4' }, { id: '01', videoRelPath: '2026/04/22/Front_01_20260422161011.mp4' }],
      // Already has thumbnail → enters runSidecarStage via the early-return
      // path at processThumbnailJob:396. Without this fix the path NEVER hit
      // incrementThumbnailAttempts, so the budget never tripped.
      thumbnail: '__s3_thumb__/user-uuid-e730bd1e/evt-stuck-april.jpg',
    });
    // wide FM missing → returns null on the first view lookup. The loop bails
    // on it before zoom is even queried (existing iteration order).
    mockGetFileMetadataByKey.mockResolvedValueOnce(null);
    // Simulate the 5th retry — over the budget. Budget = 5 (THUMBNAIL_RETRY_BUDGET).
    mockIncrementThumbnailAttempts.mockResolvedValue(5);
    mockCollapseEventView.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);

    // No throw — collapse + continue, then the for-loop's only iteration
    // already burned, so the function returns cleanly.
    await processThumbnailJob({ eventId: 'evt-stuck-april', ownerId: 42, notify: false });

    // View column nulled for the dead side (wide).
    expect(mockCollapseEventView).toHaveBeenCalledTimes(1);
    expect(mockCollapseEventView).toHaveBeenCalledWith('evt-stuck-april', 42, '00');
    // User informed once.
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0]?.[1]).toBe('invalid_file');
    // We do NOT clear the dedup on collapse — no point scheduling another
    // republish when the event is now single-view and dropping out of
    // getEventsMissingSidecar on the next sidecar reconcile.
    expect(mockClearThumbnailDedup).not.toHaveBeenCalled();
    // Event is preserved (not tombstoned) — surviving view still plays.
    expect(mockUpdateEventThumbnail).not.toHaveBeenCalled();
  });

  it('collapses the zoom view when the missing FM is on the second iteration', async (ctx) => {
    story(
      ctx,
      'Symetryczny case: wide view ma file_metadata (i nawet sidecar już ready), zoom view ma file_metadata zaginione. Iteracja runSidecarStage idzie [wide, zoom]; pierwsza działa, druga rzuca z markerem. Po przekroczeniu budżetu kolapsujemy KOLUMNĘ ZOOM, nie wide.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 42, uuid: 'user-uuid-e730bd1e', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-h2-middle',
      ownerId: 42,
      views: [
        { id: '00', videoRelPath: '2026/04/19/Middle_00_20260419133324.mp4' },
        { id: '01', videoRelPath: '2026/04/19/Middle_01_20260419133324.mp4' }, // <- FM gone
      ],
      thumbnail: '__s3_thumb__/user-uuid-e730bd1e/evt-h2-middle.jpg',
    });
    // wide FM exists + already ready; zoom FM missing.
    mockGetFileMetadataByKey.mockResolvedValueOnce({ id: 11111 });
    mockGetFileMetadataByKey.mockResolvedValueOnce(null);
    mockHeadObject.mockResolvedValue({ contentLength: 54_000_000, lastModified: new Date() });
    mockGenerateSidecarForFile.mockResolvedValue({ result: 'skipped-already-ready' });
    mockGetDurationSecondsFromExistingSidecar.mockResolvedValue(96.358);
    mockIncrementThumbnailAttempts.mockResolvedValue(7); // way past budget
    mockCollapseEventView.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);

    await processThumbnailJob({ eventId: 'evt-h2-middle', ownerId: 42, notify: false });

    // Zoom column nulled.
    expect(mockCollapseEventView).toHaveBeenCalledTimes(1);
    expect(mockCollapseEventView).toHaveBeenCalledWith('evt-h2-middle', 42, '01');
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockClearThumbnailDedup).not.toHaveBeenCalled();
  });

  it('still tombstones genuine permanent ffmpeg failures (regression guard)', async (ctx) => {
    story(
      ctx,
      'Drugi kierunek tej samej zmiany: jeśli ffmpeg padnie deterministycznie (np. uszkodzony container), outer catch DALEJ ma wywołać forceTombstoneEvent — fix nie może przepuścić wszystkich błędów do XCLAIM, tylko te z markerami transientów.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 7, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-2',
      ownerId: 7,
      views: [{ id: '00', videoRelPath: 'recordings/cam1/broken.mp4' }],
      thumbnail: null,
    });
    mockIncrementThumbnailAttempts.mockResolvedValue(1);
    mockHeadObject.mockResolvedValue({ contentLength: 1024, lastModified: new Date() });
    // Force the full-GET stage to throw a permanent-looking ffmpeg error.
    mockGetObject.mockResolvedValue({ body: { /* unused — sparse stub */ } });
    mockRunFfmpegFromFile.mockRejectedValue(new Error('ffmpeg exit 1: invalid data'));

    await processThumbnailJob({ eventId: 'evt-2', ownerId: 7, notify: false });

    // Permanent path: thumbnail set to UNPLAYABLE + notification fired.
    expect(mockUpdateEventThumbnail).toHaveBeenCalledWith('evt-2', 7, '__unplayable__');
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0]?.[1]).toBe('thumbnail_failed');
  });
});

describe('isTransientWorkerError — outer-catch classifier', () => {
  it('classifies the five known transient markers as transient', (ctx) => {
    story(
      ctx,
      'Lista markerów obsługiwanych przez outer catch w processThumbnailJob: connect-timeout, sidecar transient, missing-view (dual-view upload race), postgres deadlock, lokalny withTimeout 120s. Każdy z nich = re-throw + XCLAIM, bez notyfikacji "thumbnail_failed".',
    );

    expect(
      isTransientWorkerError(
        'AWS SDK error: did not establish a connection with the server within the configured timeout',
      ),
    ).toBe(true);
    expect(
      isTransientWorkerError(`${SIDECAR_TRANSIENT_MARKER} for fm=99: NoSuchBucket`),
    ).toBe(true);
    expect(
      isTransientWorkerError(`${SIDECAR_MISSING_VIEW_MARKER} for key uuid/x.mp4 (event evt-1)`),
    ).toBe(true);
    expect(isTransientWorkerError('deadlock detected')).toBe(true);
    expect(
      isTransientWorkerError('thumbnail job evt-1 timed out after 120000ms'),
    ).toBe(true);
  });

  it('classifies a smithy socket-inactivity timeout as transient', (ctx) => {
    story(
      ctx,
      'Kompletne 100 MB nagranie (oba widoki) zostało trwale oznaczone jako `unplayable`, bo odczyt z S3 stanął na 10 s. Plik był w porządku — zdechło gniazdo. Komunikat smithy brzmi "timed out after 10000 ms" ze SPACJĄ, a WITH_TIMEOUT_MARKER_RE celowo wymaga `\\d+ms` bez spacji (żeby odróżnić lokalny withTimeout od PERMANENTNEGO "timed out after 60s" z ffmpeg). Ta jedna spacja przepuszczała błąd do gałęzi permanentnej.',
    );

    expect(
      isTransientWorkerError(
        '@smithy/node-http-handler - the request socket timed out after 10000 ms of inactivity (configured by client requestHandler)',
      ),
    ).toBe(true);
    // Value-independent: raising the configured timeout must not un-fix this.
    expect(
      isTransientWorkerError('the request socket timed out after 30000 ms of inactivity'),
    ).toBe(true);
  });

  it('does NOT classify permanent ffmpeg / S3 / decode failures as transient', (ctx) => {
    story(
      ctx,
      'Klasyfikator nie może przepuszczać błędów deterministycznych — w przeciwnym razie poison-pill mp4 latałby w nieskończoność po XCLAIM zamiast zostać tombstoned po 5 próbach.',
    );

    expect(isTransientWorkerError('ffmpeg exit 1: invalid data found')).toBe(false);
    expect(isTransientWorkerError('NoSuchKey: The specified key does not exist')).toBe(false);
    expect(isTransientWorkerError('video file appears corrupt')).toBe(false);
    // Crucial discriminator: the permanent ffmpeg-SIGKILL message uses `60s`
    // (seconds) NOT `60000ms`, so the WITH_TIMEOUT_MARKER_RE regex (which
    // requires `\d+ms` suffix) must reject it.
    expect(isTransientWorkerError('ffmpeg timed out after 60s and was killed')).toBe(false);
  });
});

describe('isFreshRecordingForPush — new_recording recency guard', () => {
  // Fixed "now" so the window math is deterministic. 2026-06-10T20:00:00Z.
  const NOW = Date.parse('2026-06-10T20:00:00.000Z');
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const H = 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  // A clip that arrived a minute ago; its camera stamp is `offsetH` hours away
  // from that (the camera's local wall clock stored as UTC).
  const justArrived = (stampOffsetH: number) => ({
    arrivedAt: iso(NOW - 60_000),
    capturedAt: iso(NOW - 60_000 - 30_000 + stampOffsetH * H),
  });

  it('fires the push for a recording captured just now', (ctx) => {
    story(
      ctx,
      'Happy path: kamera złapała ruch i plik wpadł chwilę temu — banner "New recording" ma sens, więc push leci.',
    );
    expect(isFreshRecordingForPush(justArrived(0), NOW, SIX_HOURS)).toBe(true);
    expect(isFreshRecordingForPush({ arrivedAt: iso(NOW - 2.5 * H), capturedAt: iso(NOW - 2.6 * H) }, NOW, SIX_HOURS)).toBe(true);
  });

  it('announces a fresh upload whose camera stamp looks 7–8 h old (camera west of UTC)', (ctx) => {
    story(
      ctx,
      'Kamera w strefie UTC−7/UTC−8 zapisuje czas lokalny, który serwer czyta jak UTC — świeży klip wygląda na 7–8 h stary. Świeżość liczymy od chwili, gdy plik dotarł na serwer, więc banner przychodzi niezależnie od strefy kamery.',
    );
    expect(isFreshRecordingForPush(justArrived(-7), NOW, SIX_HOURS)).toBe(true);
    expect(isFreshRecordingForPush(justArrived(-8), NOW, SIX_HOURS)).toBe(true);
    expect(isFreshRecordingForPush(justArrived(-12), NOW, SIX_HOURS)).toBe(true); // UTC−12
    expect(isFreshRecordingForPush(justArrived(14), NOW, SIX_HOURS)).toBe(true); // UTC+14
  });

  it('suppresses an upload that arrived longer ago than the window (job stuck in a backlog)', (ctx) => {
    story(
      ctx,
      'Post-deploy scan/reconcile albo zalegająca kolejka przerabia nagrania, które dotarły dawno temu — dla każdego "pierwszego thumbnaila" leciałby new_recording. Plik, który dotarł wcześniej niż okno świeżości, NIE wysyła pusha.',
    );
    expect(isFreshRecordingForPush({ arrivedAt: iso(NOW - 7 * H), capturedAt: iso(NOW - 7 * H - 60_000) }, NOW, SIX_HOURS)).toBe(false);
    expect(isFreshRecordingForPush({ arrivedAt: '2026-06-03T20:00:00.000Z', capturedAt: '2026-06-03T19:59:00.000Z' }, NOW, SIX_HOURS)).toBe(false);
    // Just over the 6h window.
    expect(isFreshRecordingForPush({ arrivedAt: iso(NOW - SIX_HOURS - 1000), capturedAt: iso(NOW - SIX_HOURS - 2000) }, NOW, SIX_HOURS)).toBe(false);
  });

  it('suppresses history a reconnecting camera uploads days after recording it', (ctx) => {
    story(
      ctx,
      'Kamera, która wraca po awarii sieci, wgrywa zaległe nagrania sprzed dni — plik przychodzi „teraz”, ale nagrany był dawno. Takiego klipu nie ogłaszamy: stempel kamery może być wcześniejszy od czasu przyjścia najwyżej o okno + 12 h (największe opóźnienie strefy, UTC−12).',
    );
    expect(isFreshRecordingForPush(justArrived(-3 * 24), NOW, SIX_HOURS)).toBe(false);
    expect(isFreshRecordingForPush(justArrived(-19), NOW, SIX_HOURS)).toBe(false);
  });

  it('announces history a UTC camera uploads after an outage when recorded up to 18 h (6 h window + 12 h lag allowance) before arriving, not older', (ctx) => {
    story(
      ctx,
      'Świadomy kompromis: strefy kamery nie znamy, więc stempel może być do 12 h „za” czasem przyjścia (UTC−12). Kamera w UTC, która po awarii wgrywa zaległe klipy, dostaje więc banner dla nagrań do 18 h przed przyjściem (okno 6 h + 12 h); starsze przechodzą po cichu.',
    );
    const utcClip = (recordedHoursBeforeArrival: number) => ({
      arrivedAt: iso(NOW - 60_000),
      capturedAt: iso(NOW - 60_000 - recordedHoursBeforeArrival * H),
    });
    expect(isFreshRecordingForPush(utcClip(17), NOW, SIX_HOURS)).toBe(true);
    expect(isFreshRecordingForPush(utcClip(18), NOW, SIX_HOURS)).toBe(true);
    expect(isFreshRecordingForPush(utcClip(18.01), NOW, SIX_HOURS)).toBe(false);
    expect(isFreshRecordingForPush(utcClip(30), NOW, SIX_HOURS)).toBe(false);
  });

  it('treats the exact window boundary as still fresh (<=)', (ctx) => {
    story(ctx, 'Granica inclusive: dokładnie 6h to jeszcze świeże, żeby nie gubić pushy na styku.');
    expect(isFreshRecordingForPush({ arrivedAt: iso(NOW - SIX_HOURS), capturedAt: iso(NOW - SIX_HOURS) }, NOW, SIX_HOURS)).toBe(true);
  });

  it('treats a camera stamp ahead of the arrival (camera clock skew) as fresh', (ctx) => {
    story(ctx, 'Zegar kamery do przodu → stempel późniejszy niż przyjście pliku; takie nagranie jest na pewno świeże, nie odrzucamy.');
    expect(isFreshRecordingForPush({ arrivedAt: iso(NOW - 60_000), capturedAt: '2026-06-10T20:05:00.000Z' }, NOW, SIX_HOURS)).toBe(true);
  });

  it('fails safe to NOT-fresh on a missing or unparseable time', (ctx) => {
    story(
      ctx,
      'Fail-safe: brak/nieparsowalny czas przyjścia albo stempel → traktujemy jako nie-świeże i nie wysyłamy pusha. Lepiej zgubić jeden push niż spamować przy backlogu z popsutym stemplem.',
    );
    const arrivedAt = iso(NOW - 60_000);
    const capturedAt = iso(NOW - 90_000);
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(isFreshRecordingForPush({ arrivedAt: bad, capturedAt }, NOW, SIX_HOURS)).toBe(false);
      expect(isFreshRecordingForPush({ arrivedAt, capturedAt: bad }, NOW, SIX_HOURS)).toBe(false);
    }
  });
});

describe('recordingArrivedAt — arrival time of the recording', () => {
  it('takes the newest upload time among the event files', async () => {
    mockGetFileMetadataByKey.mockImplementation((...args: unknown[]) => {
      const key = String(args[1]);
      return Promise.resolve(
        key.endsWith('_00_1.mp4') ? { uploadedAt: '2026-06-10T19:58:00.000Z' }
          : key.endsWith('_01_1.mp4') ? { uploadedAt: '2026-06-10T19:59:00.000Z' }
            : null,
      );
    });
    const at = await recordingArrivedAt('user-uuid', [
      { videoRelPath: '2026/06/10/Cam_00_1.mp4' },
      { videoRelPath: '2026/06/10/Cam_01_1.mp4' },
      { videoRelPath: '2026/06/10/Cam_02_1.mp4' }, // no file row
      { videoRelPath: null },
    ]);
    expect(at).toBe('2026-06-10T19:59:00.000Z');
    expect(mockGetFileMetadataByKey).toHaveBeenCalledWith('recordings', 'user-uuid/2026/06/10/Cam_00_1.mp4');
  });

  it('is null when no file row is known or the lookup fails — and then nothing is announced', async () => {
    mockGetFileMetadataByKey.mockResolvedValue(null);
    expect(await recordingArrivedAt('u', [{ videoRelPath: 'a.mp4' }])).toBeNull();
    mockGetFileMetadataByKey.mockRejectedValue(new Error('connection reset'));
    const at = await recordingArrivedAt('u', [{ videoRelPath: 'a.mp4' }]);
    expect(at).toBeNull();
    expect(shouldAnnounceNewRecording({ notify: true }, { arrivedAt: at, capturedAt: new Date().toISOString() })).toBe(false);
  });
});

describe('shouldAnnounceNewRecording — ingest/repair split × recency', () => {
  const NOW = Date.parse('2026-06-10T20:00:00.000Z');
  const FRESH = { arrivedAt: '2026-06-10T19:59:30.000Z', capturedAt: '2026-06-10T19:59:00.000Z' };
  const OLD = { arrivedAt: '2026-06-03T20:00:30.000Z', capturedAt: '2026-06-03T20:00:00.000Z' }; // 7 days

  it('announces only for an ingest job (notify) with a fresh recording', (ctx) => {
    story(
      ctx,
      'Świeży upload: scanner odkrył NOWY plik → job ingest (notify=true), nagranie świeże → push leci.',
    );
    expect(shouldAnnounceNewRecording({ notify: true }, FRESH, NOW)).toBe(true);
  });

  it('NEVER announces for a repair job, even when the recording is fresh', (ctx) => {
    story(
      ctx,
      'Sedno strukturalnego fixu: reconciler/backfill publikuje jako repair (notify=false). Nawet jeśli nagranie jest świeże, ścieżka recovery z DEFINICJI nie announce\'uje — to zabija storm u źródła, nie guardem. Świeży event i tak dostanie pusha ze swojego własnego ingest joba.',
    );
    expect(shouldAnnounceNewRecording({ notify: false }, FRESH, NOW)).toBe(false);
    expect(shouldAnnounceNewRecording({ notify: false }, OLD, NOW)).toBe(false);
  });

  it('does NOT announce an ingest job for an old recording (force-full rescan / new-camera history)', (ctx) => {
    story(
      ctx,
      'Rezydualny przypadek: job ingest, który utknął w kolejce, albo kamera wgrywająca historię niesie notify=true dla STAREGO nagrania. Recency-guard (czas przyjścia pliku + stempel kamery) je wycina — dlatego oba mechanizmy są potrzebne.',
    );
    expect(shouldAnnounceNewRecording({ notify: true }, OLD, NOW)).toBe(false);
  });
});

describe('processThumbnailJob — events.duration uses sidecar (not head-only ffmpeg)', () => {
  it('writes the sidecar duration to events.duration when sidecar is freshly generated', async (ctx) => {
    story(
      ctx,
      'Bug: dla Reolink fragmented mp4 (mvhd duration=0, brak mehd/mfra) thumbnail worker uruchamia ffmpeg na sparse 4MB head — ffmpeg widzi tylko ~8s fragmentów i to leci do events.duration. Naprawa: generated sidecar już ma authoritative totalDurationSeconds (walking ALL fragments), więc po sidecar stage nadpisujemy events.duration prawdziwą wartością. Dla wide-only eventu (zoom=null) update leci dokładnie raz, primary view = wide.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-fixed',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/03/03/Back_00_20260303151907.mp4' }],
      // already has thumbnail → early-return path that runs runSidecarStage.
      thumbnail: '__s3_thumb__/user-uuid/evt-fixed.jpg',
    });
    mockGetFileMetadataByKey.mockResolvedValue({ id: 15951741 });
    mockHeadObject.mockResolvedValue({ contentLength: 54_064_719 });
    mockGenerateSidecarForFile.mockResolvedValue({
      result: 'generated',
      sidecarBytes: 4096,
      durationSeconds: 96.358, // realny duration tego konkretnego pliku z proda
    });

    await processThumbnailJob({ eventId: 'evt-fixed', ownerId: 22, notify: false });

    expect(mockUpdateEventDuration).toHaveBeenCalledTimes(1);
    expect(mockUpdateEventDuration).toHaveBeenCalledWith('evt-fixed', 22, 96.358);
  });

  it('recovers duration from existing sidecar when generateSidecarForFile reports skipped-already-ready', async (ctx) => {
    story(
      ctx,
      'Self-healing dla starych eventów: pliki, które zostały zpatchowane przed tym fixem, mają processing_state=ready i bogus events.duration (np. 8.58 s zamiast 96.358 s). Re-trigger thumbnail job (XCLAIM, scanner re-publish) trafia w "skipped-already-ready" branch — w nim czytamy duration z istniejącego sidecara (1 GET ~5KB) i nadpisujemy events.duration. Zero re-uploadów sidecarów, zero indexowania fragmentów.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-old',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/03/03/Back_00_20260303151907.mp4' }],
      thumbnail: '__s3_thumb__/user-uuid/evt-old.jpg',
    });
    mockGetFileMetadataByKey.mockResolvedValue({ id: 15951741 });
    mockHeadObject.mockResolvedValue({ contentLength: 54_064_719 });
    mockGenerateSidecarForFile.mockResolvedValue({ result: 'skipped-already-ready' });
    mockGetDurationSecondsFromExistingSidecar.mockResolvedValue(96.358);

    await processThumbnailJob({ eventId: 'evt-old', ownerId: 22, notify: false });

    expect(mockGetDurationSecondsFromExistingSidecar).toHaveBeenCalledWith(15951741, 'salt');
    expect(mockUpdateEventDuration).toHaveBeenCalledTimes(1);
    expect(mockUpdateEventDuration).toHaveBeenCalledWith('evt-old', 22, 96.358);
  });

  it('does not write duration when the sidecar reports skipped-already-good (class B/C, ffmpeg-friendly mp4)', async (ctx) => {
    story(
      ctx,
      'Dla mp4 które od razu mają sensowne mvhd (class B/C) sidecar branch zwraca skipped-already-good i NIE policzył duration sam. Wtedy events.duration zostaje takim, jakim go zapisał wcześniej head-only ffmpeg — bo dla tych klas head-only ffmpeg działa poprawnie. Tu nie ruszamy.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-classB',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/03/03/some-faststart.mp4' }],
      thumbnail: '__s3_thumb__/user-uuid/evt-classB.jpg',
    });
    mockGetFileMetadataByKey.mockResolvedValue({ id: 9999 });
    mockHeadObject.mockResolvedValue({ contentLength: 1_000_000 });
    mockGenerateSidecarForFile.mockResolvedValue({ result: 'skipped-already-good' });

    await processThumbnailJob({ eventId: 'evt-classB', ownerId: 22, notify: false });

    expect(mockUpdateEventDuration).not.toHaveBeenCalled();
    expect(mockGetDurationSecondsFromExistingSidecar).not.toHaveBeenCalled();
  });

  it('only writes duration once even with both wide and zoom views (primary = wide)', async (ctx) => {
    story(
      ctx,
      'Dual-view event ma dwa pliki z osobnymi sidecarami; oba mają niemal identyczny duration (rejestrowane jednocześnie). events.duration to single source of truth — piszemy tylko dla wide (primary), żeby zoom nie nadpisał wartości jeśli różni się o ~1 frame.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-duo',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/03/03/Back_00_20260303151907.mp4' }, { id: '01', videoRelPath: '2026/03/03/Back_01_20260303151907.mp4' }],
      thumbnail: '__s3_thumb__/user-uuid/evt-duo.jpg',
    });
    let fmCalls = 0;
    mockGetFileMetadataByKey.mockImplementation(() => {
      fmCalls += 1;
      return Promise.resolve({ id: fmCalls === 1 ? 100 : 101 });
    });
    mockHeadObject.mockResolvedValue({ contentLength: 54_000_000 });
    mockGenerateSidecarForFile.mockResolvedValueOnce({
      result: 'generated', sidecarBytes: 4096, durationSeconds: 96.358,
    });
    mockGenerateSidecarForFile.mockResolvedValueOnce({
      result: 'generated', sidecarBytes: 4096, durationSeconds: 96.317,
    });

    await processThumbnailJob({ eventId: 'evt-duo', ownerId: 22, notify: false });

    expect(mockUpdateEventDuration).toHaveBeenCalledTimes(1);
    expect(mockUpdateEventDuration).toHaveBeenCalledWith('evt-duo', 22, 96.358);
  });
});

describe('processThumbnailJob — playback_ready recompute on skipped-already-ready', () => {
  it('recomputes playback_ready (once per event) when sidecars are already ready but the event is not', async (ctx) => {
    story(
      ctx,
      'Bug: event (re)utworzony PO tym jak jego pliki były już patch-ready (full-rescan displaced-event synthesis, slot heal, admin rescan) nigdy nie dostaje recompute — markPlaybackPatchReady odpala tylko z branchy generated/skipped-already-good, a taki event zawsze trafia w skipped-already-ready. Skutek: playback_ready=FALSE na zawsze, event niewidoczny w gridzie mimo thumbnaila i gotowych plików. Fix: branch skipped-already-ready woła recomputeEventsPlaybackReadyForFile gdy event NIE jest jeszcze ready — i tylko RAZ na joba (recompute per-file i tak przelicza cały event ze wszystkimi views), żeby dual-view nie kosztował dwóch transakcji.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 80, uuid: 'user-uuid-80', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-displaced',
      ownerId: 80,
      views: [
        { id: '00', videoRelPath: '2026/04/26/Driveway_00_20260426200610.mp4' },
        { id: '01', videoRelPath: '2026/04/26/Driveway_01_20260426200610.mp4' },
      ],
      // Thumbnail present → early-return path straight into runSidecarStage,
      // exactly how the stuck prod event keeps re-entering via reconciler jobs.
      thumbnail: '__s3_thumb__/user-uuid-80/evt-displaced.jpg',
      playbackReady: false,
    });
    let fmCalls = 0;
    mockGetFileMetadataByKey.mockImplementation(() => {
      fmCalls += 1;
      return Promise.resolve({ id: fmCalls === 1 ? 7001 : 7002 });
    });
    mockHeadObject.mockResolvedValue({ contentLength: 54_000_000 });
    mockGenerateSidecarForFile.mockResolvedValue({ result: 'skipped-already-ready' });
    mockGetDurationSecondsFromExistingSidecar.mockResolvedValue(null);

    await processThumbnailJob({ eventId: 'evt-displaced', ownerId: 80, notify: false });

    // Once per event, not per view — the per-file recompute re-evaluates every
    // attached view, so the second call would be pure churn.
    expect(mockRecomputeEventsPlaybackReadyForFile).toHaveBeenCalledTimes(1);
    expect(mockRecomputeEventsPlaybackReadyForFile).toHaveBeenCalledWith(7001);
  });

  it('does NOT recompute when the event is already playback-ready (repair-churn no-op path)', async (ctx) => {
    story(
      ctx,
      'Guard przeciw churnowi: skipped-already-ready to NAJCZĘSTSZA ścieżka repeat-jobów (XCLAIM, scanner/reconciler re-publish) dla zdrowych eventów. Bezwarunkowy recompute dokładałby transakcję DB per view per powtórzony job. Gdy event już jest playback_ready, recompute się nie odpala.',
    );

    mockGetUsersForScan.mockResolvedValue([
      { id: 22, uuid: 'user-uuid', encryptionSalt: 'salt' },
    ]);
    mockGetEventByIdForOwner.mockResolvedValue({
      id: 'evt-healthy',
      ownerId: 22,
      views: [{ id: '00', videoRelPath: '2026/03/03/Back_00_20260303151907.mp4' }],
      thumbnail: '__s3_thumb__/user-uuid/evt-healthy.jpg',
      playbackReady: true,
    });
    mockGetFileMetadataByKey.mockResolvedValue({ id: 15951741 });
    mockHeadObject.mockResolvedValue({ contentLength: 54_064_719 });
    mockGenerateSidecarForFile.mockResolvedValue({ result: 'skipped-already-ready' });
    mockGetDurationSecondsFromExistingSidecar.mockResolvedValue(null);

    await processThumbnailJob({ eventId: 'evt-healthy', ownerId: 22, notify: false });

    expect(mockRecomputeEventsPlaybackReadyForFile).not.toHaveBeenCalled();
  });
});

describe('handleBudgetExceededView orphan cascade', () => {
  it('deletes file_metadata rows when S3 is also gone', async (ctx) => {
    story(ctx, 'Po wyczerpaniu retry-budgetu, jeśli S3 dla collapsowanego lensa też nie istnieje — kasujemy wszystkie 3 wiersze file_metadata, nie zostawiamy sieroty.');
    const collapseEventView = vi.fn().mockResolvedValue(undefined);
    const headObjectDep = vi.fn().mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'NotFound' }),
    );
    const deleteRecordingAllBucketsDep = vi.fn().mockResolvedValue({ deletedRows: 3 });

    const result = await handleBudgetExceededView(
      {
        eventId: 'evt-1',
        ownerId: 42,
        userUuid: 'user-uuid-1',
        encryptionSalt: 'salt-1',
        viewId: '00',
        views: [{ id: '00', videoRelPath: 'Front_00_20260519100000.mp4' }],
      },
      { collapseEventView, headObject: headObjectDep, deleteRecordingAllBuckets: deleteRecordingAllBucketsDep },
    );

    expect(result).toEqual({ collapsed: true, orphanCleaned: true });
    expect(collapseEventView).toHaveBeenCalledWith('evt-1', 42, '00');
    expect(deleteRecordingAllBucketsDep).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 42, reason: 'collapse-view' }),
    );
  });

  it('leaves file_metadata alone when S3 still exists (malformed MP4 case)', async (ctx) => {
    story(ctx, 'S3 dalej jest → problem nie jest sierotą, tylko malformed MP4 — to obsługuje CLASS D/E path osobno. Nie kasujemy wierszy.');
    const collapseEventView = vi.fn().mockResolvedValue(undefined);
    const headObjectDep = vi.fn().mockResolvedValue({ contentLength: 1000 });
    const deleteRecordingAllBucketsDep = vi.fn();

    const result = await handleBudgetExceededView(
      {
        eventId: 'evt-2',
        ownerId: 42,
        userUuid: 'user-uuid-1',
        encryptionSalt: 'salt-1',
        viewId: '01',
        views: [{ id: '01', videoRelPath: 'Front_01_20260519100000.mp4' }],
      },
      { collapseEventView, headObject: headObjectDep, deleteRecordingAllBuckets: deleteRecordingAllBucketsDep },
    );

    expect(result).toEqual({ collapsed: true, orphanCleaned: false });
    expect(deleteRecordingAllBucketsDep).not.toHaveBeenCalled();
  });

  it('handles missing relPath (already-NULLed view) gracefully', async (ctx) => {
    story(ctx, 'Defensive: jeśli rel-path jest null (view już skolapsowany), collapseEventView dalej zostaje wywołany, ale HEAD/cascade jest pominięty.');
    const collapseEventView = vi.fn().mockResolvedValue(undefined);
    const headObjectDep = vi.fn();
    const deleteRecordingAllBucketsDep = vi.fn();

    const result = await handleBudgetExceededView(
      {
        eventId: 'evt-3',
        ownerId: 42,
        userUuid: 'user-uuid-1',
        encryptionSalt: 'salt-1',
        viewId: '00',
        views: [],
      },
      { collapseEventView, headObject: headObjectDep, deleteRecordingAllBuckets: deleteRecordingAllBucketsDep },
    );

    expect(result).toEqual({ collapsed: true, orphanCleaned: false });
    expect(headObjectDep).not.toHaveBeenCalled();
    expect(deleteRecordingAllBucketsDep).not.toHaveBeenCalled();
  });
});
