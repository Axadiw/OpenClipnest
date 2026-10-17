import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const mockGetUserQuota = vi.fn();
const mockGetAutoDeleteOldest = vi.fn();
const mockCreateNotification = vi.fn();
const mockHasRecentNotification = vi.fn();
const mockGetStorageWarnState = vi.fn();
const mockStorageWarning = vi.fn();

vi.mock('../db/queries/storage.js', () => ({
  getUserQuota: (...a: unknown[]) => mockGetUserQuota(...a),
  getAutoDeleteOldest: (...a: unknown[]) => mockGetAutoDeleteOldest(...a),
  getStorageWarnState: (...a: unknown[]) => mockGetStorageWarnState(...a),
}));
vi.mock('../db/queries/notifications.js', () => ({
  createNotification: (...a: unknown[]) => mockCreateNotification(...a),
  hasRecentNotification: (...a: unknown[]) => mockHasRecentNotification(...a),
}));

import { reconcileUserQuota } from './quota-reconciler.js';
import { installEditionHooks } from '../hooks.js';

const NO_AUTO_DELETE_STATE = {
  email: 'user@test.com',
  autoDeleteOldest: false,
  autoDeleteAfterDays: null,
  storageWarnEmailSentAt: null,
};

beforeEach(() => {
  mockGetUserQuota.mockReset();
  mockGetAutoDeleteOldest.mockReset();
  mockCreateNotification.mockReset();
  mockHasRecentNotification.mockReset();
  mockGetStorageWarnState.mockReset();
  mockStorageWarning.mockReset();

  mockCreateNotification.mockResolvedValue({});
  // Default: no recent storage warning on record, so the 95% path is free to
  // emit. The dedup test flips this to true.
  mockHasRecentNotification.mockResolvedValue(false);
  // The edition's warning channel (Clipnest Cloud: email). The hook owns its
  // cooldown, so by default it reports "delivered".
  mockStorageWarning.mockResolvedValue(true);
  installEditionHooks({ storageWarning: mockStorageWarning });
});

describe('reconcileUserQuota', () => {
  it('skips when plan has no disk limit', async (ctx) => {
    story(ctx, 'Plan bez limitu dysku (np. „nieograniczony") nie generuje żadnych alertów o kwocie — user z takim planem nigdy nie zobaczy zbędnego powiadomienia „brak miejsca".');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 0, diskLimitBytes: 0, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    const r = await reconcileUserQuota(1);
    expect(r.skipped).toBe(true);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockStorageWarning).not.toHaveBeenCalled();
  });

  it('no-op when usage below 90% threshold', async (ctx) => {
    story(ctx, 'Użytkownik z 10% zapełnienia dysku nie dostaje żadnego powiadomienia ani maila — zapobiega spamowaniu alertami, gdy nic wymagającego uwagi się nie dzieje.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 100, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    const r = await reconcileUserQuota(1);
    expect(r.notified).toBe(false);
    expect(r.warnEmailSent).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockStorageWarning).not.toHaveBeenCalled();
  });

  it('hands the 90% warning to the edition hook when both auto-delete flags are off', async (ctx) => {
    story(ctx, 'Użytkownik bez żadnego auto-usuwania, który przekroczył 90% limitu, dostaje ostrzeżenie kanałem edycji (w Cloud: mail) — musi wiedzieć, że kamery niedługo przestaną nagrywać.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 920, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue(NO_AUTO_DELETE_STATE);
    const r = await reconcileUserQuota(1);
    expect(r.warnEmailSent).toBe(true);
    expect(mockStorageWarning).toHaveBeenCalledWith({
      userId: 1, email: 'user@test.com', lastWarnedAt: null,
      diskUsageBytes: 920, diskLimitBytes: 1000, percent: 0.92,
    });
    // below 95% — no in-app notification
    expect(r.notified).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('reports warnEmailSent=false when the hook declines (its cooldown)', async (ctx) => {
    story(ctx, 'Cooldown należy do kanału edycji — gdy hook odmówi (np. mail poszedł 3 dni temu), reconciler tylko odnotowuje brak wysyłki i dalej robi swoje.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 920, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    const recentlySent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    mockGetStorageWarnState.mockResolvedValue({ ...NO_AUTO_DELETE_STATE, storageWarnEmailSentAt: recentlySent });
    mockStorageWarning.mockResolvedValue(false);
    const r = await reconcileUserQuota(1);
    expect(r.warnEmailSent).toBe(false);
    expect(mockStorageWarning).toHaveBeenCalledWith(expect.objectContaining({ lastWarnedAt: recentlySent }));
  });

  it('sends nothing on an edition without a warning channel (self-hosted)', async (ctx) => {
    story(ctx, 'Self-hosted nie ma maila: brak hooka oznacza brak ostrzeżenia, ale reszta logiki (powiadomienie w aplikacji przy 95%) działa bez zmian.');
    installEditionHooks(undefined);
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 960, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue(NO_AUTO_DELETE_STATE);
    mockGetAutoDeleteOldest.mockResolvedValue(false);
    const r = await reconcileUserQuota(1);
    expect(r.warnEmailSent).toBe(false);
    expect(r.notified).toBe(true);
  });

  it('suppresses warning email when auto_delete_oldest is ON', async (ctx) => {
    story(ctx, 'User z włączonym auto-delete-oldest nie dostaje maila ostrzegawczego — eviction zadziała automatycznie, mail byłby zbędnym szumem.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 920, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue({ ...NO_AUTO_DELETE_STATE, autoDeleteOldest: true });
    mockGetAutoDeleteOldest.mockResolvedValue(true);
    const r = await reconcileUserQuota(1);
    expect(r.warnEmailSent).toBe(false);
    expect(mockStorageWarning).not.toHaveBeenCalled();
  });

  it('suppresses warning email when auto_delete_after_days is set', async (ctx) => {
    story(ctx, 'User z włączonym usuwaniem po N dniach nie dostaje maila ostrzegawczego — ma skonfigurowane automatyczne zarządzanie, mail byłby zbędny.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 920, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue({ ...NO_AUTO_DELETE_STATE, autoDeleteAfterDays: 30 });
    mockGetAutoDeleteOldest.mockResolvedValue(false);
    const r = await reconcileUserQuota(1);
    expect(r.warnEmailSent).toBe(false);
    expect(mockStorageWarning).not.toHaveBeenCalled();
  });

  it('emits storage_quota_exceeded notification at 95% when auto-delete OFF', async (ctx) => {
    story(ctx, 'User z wyłączonym auto-delete dostaje twarde powiadomienie o braku miejsca — musi sam zwolnić dysk, zanim kamery znowu zaczną nagrywać.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 960, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue(NO_AUTO_DELETE_STATE);
    mockGetAutoDeleteOldest.mockResolvedValue(false);
    const r = await reconcileUserQuota(1);
    expect(r.notified).toBe(true);
    expect(r.warnEmailSent).toBe(true); // also the 90% warning since both flags off
    expect(mockCreateNotification).toHaveBeenCalledWith(1, 'storage_quota_exceeded', expect.any(String), expect.any(Object));
  });

  it('stays silent when auto-delete is ON, even past the plan limit', async (ctx) => {
    story(ctx, 'Phase D: user z auto-delete na tak nie dostaje notyfikacji — eviction działa w tle, feed nie jest zaśmiecany rutynowym opróżnianiem dysku. Zwracamy notified:false jako sygnał zamierzonego silence.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 1200, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    mockGetStorageWarnState.mockResolvedValue({ ...NO_AUTO_DELETE_STATE, autoDeleteOldest: true });
    mockGetAutoDeleteOldest.mockResolvedValue(true);
    const r = await reconcileUserQuota(1);
    expect(r.overLimit).toBe(true);
    expect(r.notified).toBe(false);
    expect(r.warnEmailSent).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockStorageWarning).not.toHaveBeenCalled();
  });

  it('suppresses the 95% notification when a recent one already exists (dedup)', async (ctx) => {
    story(ctx, 'User siedzący ponad 95% nie dostaje świeżego powiadomienia przy każdym uploadzie ani co tick crona — reconcileUserQuota jest teraz wołane z trzech triggerów (inline upload, zmiana planu, backstop co 1 min), więc bez dedupu backstop sam mintowałby nowy wiersz co tick. Okno 7 dni (jak cooldown maila) daje najwyżej jedno powiadomienie na okno.');
    mockGetUserQuota.mockResolvedValue({ diskUsageBytes: 960, diskLimitBytes: 1000, transferUsageBytes: 0, transferLimitBytes: 0, transferResetAt: null });
    // Hook cooldown is the hook's business; only the in-app notification
    // dedup is under test here.
    mockGetStorageWarnState.mockResolvedValue({ ...NO_AUTO_DELETE_STATE, storageWarnEmailSentAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    mockGetAutoDeleteOldest.mockResolvedValue(false);
    mockHasRecentNotification.mockResolvedValue(true);
    const r = await reconcileUserQuota(1);
    expect(r.notified).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockHasRecentNotification).toHaveBeenCalledWith(1, 'storage_quota_exceeded', expect.any(Number));
  });
});
