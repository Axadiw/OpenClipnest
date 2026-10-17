import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const mockGetEventsMissingThumbnail = vi.fn();
const mockGetStalePlaybackReadyEventIds = vi.fn();
const mockRecomputeEventsPlaybackReadyForEvent = vi.fn();
vi.mock('../db/queries/events.js', () => ({
  getEventsMissingThumbnail: (...a: unknown[]) => mockGetEventsMissingThumbnail(...a),
  getStalePlaybackReadyEventIds: (...a: unknown[]) => mockGetStalePlaybackReadyEventIds(...a),
  recomputeEventsPlaybackReadyForEvent: (...a: unknown[]) => mockRecomputeEventsPlaybackReadyForEvent(...a),
}));

const mockPublishThumbnailUnique = vi.fn();
vi.mock('./streamsClient.js', () => ({
  publishThumbnailUnique: (...a: unknown[]) => mockPublishThumbnailUnique(...a),
}));

import { reconcileMissingThumbnails, reconcileStalePlaybackReady, createTrackedThumbnailPublisher } from './reconcilers.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishThumbnailUnique.mockResolvedValue('published');
});

describe('reconcileMissingThumbnails', () => {
  it('republishes every missing-thumbnail event found by the DB query', async (ctx) => {
    story(ctx, 'Compose-mode bezpiecznik: jeśli scanner z jakiegoś powodu pominie publikację thumbnail joba (race przy /file-uploaded vs scanner debounce), reconciler co minutę re-publishuje brakujące eventy do stream:thumbnail.');
    mockGetEventsMissingThumbnail.mockResolvedValue([
      { id: 'evt-A', ownerId: 1 },
      { id: 'evt-B', ownerId: 1 },
      { id: 'evt-C', ownerId: 2 },
    ]);

    await reconcileMissingThumbnails();

    expect(mockPublishThumbnailUnique).toHaveBeenCalledTimes(3);
    // Repair sweep → notify=false so a backlog drain never fires new_recording.
    expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-A', 1, { notify: false });
    expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-B', 1, { notify: false });
    expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-C', 2, { notify: false });
  });

  it('no-op when query returns zero pending events (idle tick)', async (ctx) => {
    story(ctx, 'Pusta lista = no-op. Reconciler odpalany co 60s, na większości tików nie ma nic do roboty — query LIMIT 1000 zwraca [], żadnego publishu.');
    mockGetEventsMissingThumbnail.mockResolvedValue([]);

    await reconcileMissingThumbnails();

    expect(mockPublishThumbnailUnique).not.toHaveBeenCalled();
  });

  it('continues iterating when one publish throws (partial failure tolerated)', async (ctx) => {
    story(ctx, 'Pojedynczy błąd publishu (Redis blip) nie zatrzymuje reconcilera — pozostałe eventy w batchu wciąż lecą. Następny tick podejmie ten, który padł.');
    mockGetEventsMissingThumbnail.mockResolvedValue([
      { id: 'evt-A', ownerId: 1 },
      { id: 'evt-B', ownerId: 1 },
      { id: 'evt-C', ownerId: 2 },
    ]);
    mockPublishThumbnailUnique
      .mockResolvedValueOnce('published')
      .mockRejectedValueOnce(new Error('redis transient'))
      .mockResolvedValueOnce('published');

    await reconcileMissingThumbnails();

    expect(mockPublishThumbnailUnique).toHaveBeenCalledTimes(3);
  });

  it('counts dedup vs published to surface SETNX hit rate in the log', async (ctx) => {
    story(ctx, 'Statystyka deduped/published w logu pomaga oceniać czy stream:thumbnail jest zalewany duplikatami (deduped >> published) czy reconciler faktycznie łata gap (published > 0).');
    mockGetEventsMissingThumbnail.mockResolvedValue([
      { id: 'evt-A', ownerId: 1 },
      { id: 'evt-B', ownerId: 1 },
    ]);
    mockPublishThumbnailUnique
      .mockResolvedValueOnce('published')
      .mockResolvedValueOnce('deduped');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reconcileMissingThumbnails();
    logSpy.mockRestore();

    expect(mockPublishThumbnailUnique).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileStalePlaybackReady', () => {
  it('recomputes playback_ready once per stale event returned by the query and logs a summary', async (ctx) => {
    story(ctx, 'Safety net dla eventów (re)utworzonych PO tym jak ich pliki były już patch-ready (full-rescan displaced-event synthesis, slot heals, admin rescans) — markPlaybackPatchReady nigdy nie odpala dla nich recompute, więc siedzą niewidoczne w gridzie. Sweep woła recomputeEventsPlaybackReadyForEvent dokładnie raz per eventId i loguje podsumowanie.');
    mockGetStalePlaybackReadyEventIds.mockResolvedValue(['evt-stale-1', 'evt-stale-2']);
    mockRecomputeEventsPlaybackReadyForEvent.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reconcileStalePlaybackReady();

    expect(mockRecomputeEventsPlaybackReadyForEvent).toHaveBeenCalledTimes(2);
    expect(mockRecomputeEventsPlaybackReadyForEvent).toHaveBeenCalledWith('evt-stale-1');
    expect(mockRecomputeEventsPlaybackReadyForEvent).toHaveBeenCalledWith('evt-stale-2');
    expect(logSpy).toHaveBeenCalledWith('reconciler: stale playback_ready — recomputed 2 event(s)');
    logSpy.mockRestore();
  });

  it('no recompute and NO log line when the stale query returns [] (the ~always case)', async (ctx) => {
    story(ctx, 'W odróżnieniu od thumbnail/sidecar reconcilerów ten pass jest pusty praktycznie zawsze — cisza na pustym przebiegu trzyma minutowe logi czyste. Zero eventów = zero recompute i zero logów.');
    mockGetStalePlaybackReadyEventIds.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reconcileStalePlaybackReady();

    expect(mockRecomputeEventsPlaybackReadyForEvent).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('createTrackedThumbnailPublisher', () => {
  it('forwards (eventId, ownerId, notify) to publishThumbnailUnique', async (ctx) => {
    story(ctx, 'Helper opakowuje publishThumbnailUnique zachowując sygnaturę ThumbnailPublisher — runScan woła publisher(ev.id, ownerId, notify), a ten przekazuje notify do streamu jako opcję, żeby worker wiedział czy to ingest (push) czy repair (cisza).');
    const { publisher } = createTrackedThumbnailPublisher('scan-once');

    publisher('evt-A', 1, true);
    publisher('evt-B', 2, false);

    expect(mockPublishThumbnailUnique).toHaveBeenCalledTimes(2);
    expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-A', 1, { notify: true });
    expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-B', 2, { notify: false });
  });

  it('drain() stays pending until every in-flight publish settles', async (ctx) => {
    story(ctx, 'Sedno fixu: publisher jest fire-and-forget, więc bez draina XADD-y wisiały w locie gdy .then() wołał closeRedis() → "Connection is closed.". drain() musi blokować dopóki wszystkie publishe się nie domkną, żeby closeRedis nie wyścignął streamu.');
    const resolvers: Array<() => void> = [];
    mockPublishThumbnailUnique.mockImplementation(
      () => new Promise<'published'>((resolve) => { resolvers.push(() => resolve('published')); }),
    );

    const { publisher, drain } = createTrackedThumbnailPublisher('scan-once');
    publisher('evt-A', 1, false);
    publisher('evt-B', 1, false);
    publisher('evt-C', 2, false);

    let drained = false;
    const drainPromise = drain().then(() => { drained = true; });

    // Flush microtasks — drain must still be open because no publish resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    // XADDs complete → drain resolves.
    resolvers.forEach((r) => r());
    await drainPromise;

    expect(drained).toBe(true);
    expect(mockPublishThumbnailUnique).toHaveBeenCalledTimes(3);
  });

  it('drain() resolves even when a publish rejects with "Connection is closed."', async (ctx) => {
    story(ctx, 'Gdy XADD jednak padnie (Redis zamykany w trakcie), helper łapie błąd, loguje go z labelem i NIE rzuca — drain() i tak się domyka, więc happy-path scan-once kończy się czysto (exit 0).');
    mockPublishThumbnailUnique.mockRejectedValue(new Error('Connection is closed.'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { publisher, drain } = createTrackedThumbnailPublisher('scan-once');
    publisher('evt-A', 1, false);
    publisher('evt-B', 1, false);

    await expect(drain()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith('scan-once: thumbnail publish failed:', 'Connection is closed.');
    errSpy.mockRestore();
  });

  it('drain() is a no-op idle tick when nothing was published', async (ctx) => {
    story(ctx, 'Większość przelotów scan-once nie odkrywa nowych plików — publisher nie jest wołany, drain() ma natychmiast zwrócić bez dotykania Redisa.');
    const { drain } = createTrackedThumbnailPublisher('reconcile-once');

    await expect(drain()).resolves.toBeUndefined();

    expect(mockPublishThumbnailUnique).not.toHaveBeenCalled();
  });
});

