import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — every external the worker entry touches is replaced before
// the module evaluates so its top-level `await initDb()` and `consume(...)`
// calls are no-ops (same strategy as thumbnail-worker-entry.test.ts).
const {
  mockInitDb,
  mockGetUserByInternalId,
  mockGetPushPrefs,
  mockGetPushDevicesForUser,
  mockPrunePushDeviceByToken,
  mockGenerateMediaToken,
  mockSendPush,
  mockConsume,
  mockStartHealthzServer,
} = vi.hoisted(() => {
  const make = () => vi.fn<(...args: unknown[]) => unknown>();
  return {
    mockInitDb: make(),
    mockGetUserByInternalId: make(),
    mockGetPushPrefs: make(),
    mockGetPushDevicesForUser: make(),
    mockPrunePushDeviceByToken: make(),
    mockGenerateMediaToken: make(),
    mockSendPush: make(),
    mockConsume: make(),
    mockStartHealthzServer: make(),
  };
});

vi.mock('./db/index.js', () => ({ initDb: (...a: unknown[]) => mockInitDb(...a) }));
vi.mock('./db/queries/users.js', () => ({
  getUserByInternalId: (...a: unknown[]) => mockGetUserByInternalId(...a),
}));
vi.mock('./db/queries/push.js', () => ({
  getPushPrefs: (...a: unknown[]) => mockGetPushPrefs(...a),
  getPushDevicesForUser: (...a: unknown[]) => mockGetPushDevicesForUser(...a),
  prunePushDeviceByToken: (...a: unknown[]) => mockPrunePushDeviceByToken(...a),
}));
vi.mock('./services/auth.js', () => ({
  generateMediaToken: (...a: unknown[]) => mockGenerateMediaToken(...a),
}));
vi.mock('./services/streamsClient.js', () => ({
  consume: (...a: unknown[]) => mockConsume(...a),
  scheduleStaleConsumerCleanup: () => () => {},
  STREAM_PUSH: 'stream:push',
  STREAM_DLQ_PUSH: 'stream:push-dlq',
  GROUP_PUSH_WORKERS: 'push-workers',
}));
vi.mock('./utils/healthz.js', () => ({
  startHealthzServer: (...a: unknown[]) => mockStartHealthzServer(...a),
}));
vi.mock('./config.js', () => ({
  CONFIG: { publicAppUrl: 'https://clipnest.video' },
  IS_K8S: false,
}));

// `consume()` must return a handle with `.stop()` (the entry calls
// `consumer.stop()` in its shutdown path).
mockConsume.mockReturnValue({ stop: vi.fn().mockResolvedValue(undefined) });
mockInitDb.mockResolvedValue(undefined);

const mod = await import('./push-worker-entry.js');
const { pushSkipReason, buildPushForJob, mintThumbnailUrl, processPushJob } = mod;
const { installPushTransport } = await import('./services/push/transport.js');

// A fake edition transport: the worker only cares about the send/prune
// contract, not which gateway is behind it.
let transportConfigured = true;
beforeEach(() => {
  vi.clearAllMocks();
  transportConfigured = true;
  installPushTransport({
    name: 'fake',
    configured: () => transportConfigured,
    describeMissing: () => 'fake',
    send: (...a: unknown[]) => mockSendPush(...a) as Promise<{ ok: boolean; status: number; shouldPrune: boolean }>,
    close: async () => {},
  });
});

describe('pushSkipReason', () => {
  const baseJob = { kind: 'new_recording' };

  it('delivers when no prefs set', () => {
    expect(pushSkipReason(baseJob, { snoozeUntil: null, categories: {} })).toBeNull();
  });

  it('skips when snoozed into the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(pushSkipReason(baseJob, { snoozeUntil: future, categories: {} })).toBe('snoozed');
  });

  it('delivers when the snooze window has passed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(pushSkipReason(baseJob, { snoozeUntil: past, categories: {} })).toBeNull();
  });

  it('skips when the kind category is explicitly disabled', () => {
    expect(
      pushSkipReason(baseJob, { snoozeUntil: null, categories: { new_recording: false } }),
    ).toBe('category_disabled');
  });

  it('delivers when a DIFFERENT category is disabled', () => {
    expect(
      pushSkipReason(baseJob, { snoozeUntil: null, categories: { thumbnail_failed: false } }),
    ).toBeNull();
  });

  it('delivers when the kind category is explicitly enabled', () => {
    expect(
      pushSkipReason(baseJob, { snoozeUntil: null, categories: { new_recording: true } }),
    ).toBeNull();
  });
});

describe('buildPushForJob — new_recording payload shape', () => {
  const job = {
    userId: 7,
    notificationId: '42',
    kind: 'new_recording',
    title: 'New recording',
    message: 'New recording from Driveway',
    details: { eventId: 'evt-123', camera: 'Driveway' },
  };

  it('sets mutable-content + thread-id + thumbnailUrl when a URL is provided', () => {
    const opts = buildPushForJob(job, { thumbnailUrl: 'https://clipnest.video/api/v0/events/evt-123/thumbnail?media_token=tok' });
    expect(opts.title).toBe('New recording');
    expect(opts.body).toBe('New recording from Driveway');
    expect(opts.kind).toBe('new_recording');
    expect(opts.threadId).toBe('Driveway');
    expect(opts.mutableContent).toBe(true);
    // new_recording carries the Play + Mute… action set.
    expect(opts.category).toBe('recording');
    expect(opts.custom).toMatchObject({
      eventId: 'evt-123',
      camera: 'Driveway',
      thumbnailUrl: 'https://clipnest.video/api/v0/events/evt-123/thumbnail?media_token=tok',
      notificationId: '42',
    });
  });

  it('omits mutable-content when no thumbnail URL is available', () => {
    const opts = buildPushForJob(job, {});
    expect(opts.mutableContent).toBe(false);
    expect((opts.custom ?? {}).thumbnailUrl).toBeUndefined();
  });

  it('builds a plain payload for a non-new_recording kind', () => {
    const opts = buildPushForJob({
      userId: 7,
      notificationId: '9',
      kind: 'storage_quota_exceeded',
      title: 'Storage full',
      message: 'You are over quota',
      details: {},
    });
    expect(opts.threadId).toBeUndefined();
    expect(opts.mutableContent).toBeUndefined();
    expect(opts.custom).toEqual({ notificationId: '9' });
    // Other suppressible kinds carry the Mute…-only action set.
    expect(opts.category).toBe('mutable');
  });

  it('sets no category for user_banned (cannot be muted)', () => {
    const opts = buildPushForJob({
      userId: 7,
      notificationId: '10',
      kind: 'user_banned',
      title: 'Account suspended',
      message: 'Your account was suspended',
      details: {},
    });
    expect(opts.category).toBeUndefined();
  });

  it.each(['content_deletion_scheduled', 'content_deleted'])('sets no category for %s (an account notice about its data)', (kind) => {
    const opts = buildPushForJob({
      userId: 7,
      notificationId: '11',
      kind,
      title: 'Recordings will be deleted',
      message: 'Your recordings will be permanently deleted on 5 November 2026.',
      details: { locKey: 'notif.content_deletion_scheduled.first', locArgs: ['2026-11-05'] },
    });
    expect(opts.category).toBeUndefined();
    expect(opts.locKey).toBe('notif.content_deletion_scheduled.first');
    expect(opts.titleLocKey).toBe(`notif.${kind}.title`);
    expect(opts.locArgs).toEqual(['2026-11-05']);
  });

  it('plan_change_cancelled keeps the Mute… action', () => {
    const opts = buildPushForJob({
      userId: 7, notificationId: '12', kind: 'plan_change_cancelled', title: 'Plan change cancelled',
      message: 'Your switch to Basic was cancelled because your recordings no longer fit in it.',
      details: { plan: 'Basic', locKey: 'notif.plan_change_cancelled.plan', locArgs: ['Basic'] },
    });
    expect(opts.category).toBe('mutable');
  });
});

describe('mintThumbnailUrl', () => {
  it('returns undefined for non-new_recording kinds', async () => {
    const url = await mintThumbnailUrl({
      userId: 1, notificationId: '1', kind: 'thumbnail_failed', title: 't', message: 'm', details: { eventId: 'x' },
    });
    expect(url).toBeUndefined();
    expect(mockGenerateMediaToken).not.toHaveBeenCalled();
  });

  it('returns undefined when details has no eventId', async () => {
    const url = await mintThumbnailUrl({
      userId: 1, notificationId: '1', kind: 'new_recording', title: 't', message: 'm', details: {},
    });
    expect(url).toBeUndefined();
  });

  it('mints a media token and builds an absolute thumbnail URL', async () => {
    mockGetUserByInternalId.mockResolvedValue({
      internalId: 7, id: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGeneration: 3,
    });
    mockGenerateMediaToken.mockReturnValue('signed.media.token');

    const url = await mintThumbnailUrl({
      userId: 7, notificationId: '1', kind: 'new_recording', title: 't', message: 'm',
      details: { eventId: 'evt-abc', camera: 'Front' },
    });

    expect(mockGenerateMediaToken).toHaveBeenCalledWith(
      { userId: 7, userUuid: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGen: 3 },
      'evt-abc',
    );
    expect(url).toBe(
      'https://clipnest.video/api/v0/events/evt-abc/thumbnail?media_token=signed.media.token',
    );
  });
});

describe('processPushJob', () => {
  const job = {
    userId: 7,
    notificationId: '42',
    kind: 'new_recording',
    title: 'New recording',
    message: 'New recording from Driveway',
    details: { eventId: 'evt-123', camera: 'Driveway' },
  };

  it('skips entirely when snoozed (no device lookup, no send)', async () => {
    mockGetPushPrefs.mockResolvedValue({
      snoozeUntil: new Date(Date.now() + 60_000).toISOString(),
      categories: {},
    });
    await processPushJob(job);
    expect(mockGetPushDevicesForUser).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it('no-ops when the user has no devices', async () => {
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([]);
    await processPushJob(job);
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it('sends to every ios device with the thumbnail payload', async () => {
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([
      { deviceToken: 'tokA', platform: 'ios', environment: 'production' },
      { deviceToken: 'tokB', platform: 'ios', environment: 'production' },
    ]);
    mockGetUserByInternalId.mockResolvedValue({
      internalId: 7, id: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGeneration: 1,
    });
    mockGenerateMediaToken.mockReturnValue('tok');
    mockSendPush.mockResolvedValue({ ok: true, status: 200, shouldPrune: false });

    await processPushJob(job);

    expect(mockSendPush).toHaveBeenCalledTimes(2);
    expect(mockSendPush.mock.calls[0][0]).toMatchObject({ deviceToken: 'tokA', platform: 'ios' });
    const [, opts] = mockSendPush.mock.calls[0];
    expect((opts as { mutableContent?: boolean }).mutableContent).toBe(true);
    expect((opts as { custom?: Record<string, unknown> }).custom?.thumbnailUrl).toContain(
      '/api/v0/events/evt-123/thumbnail?media_token=tok',
    );
    expect(mockPrunePushDeviceByToken).not.toHaveBeenCalled();
  });

  it('prunes a token APNs reports as dead (410)', async () => {
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([
      { deviceToken: 'deadTok', platform: 'ios', environment: 'production' },
    ]);
    mockGetUserByInternalId.mockResolvedValue({
      internalId: 7, id: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGeneration: 1,
    });
    mockGenerateMediaToken.mockReturnValue('tok');
    mockSendPush.mockResolvedValue({ ok: false, status: 410, reason: 'Unregistered', shouldPrune: true });
    mockPrunePushDeviceByToken.mockResolvedValue(undefined);

    await processPushJob(job);

    expect(mockPrunePushDeviceByToken).toHaveBeenCalledWith('deadTok');
  });

  it('does not prune on a transient (non-prune) failure', async () => {
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([
      { deviceToken: 'tok', platform: 'ios', environment: 'production' },
    ]);
    mockGetUserByInternalId.mockResolvedValue({
      internalId: 7, id: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGeneration: 1,
    });
    mockGenerateMediaToken.mockReturnValue('tok');
    mockSendPush.mockResolvedValue({ ok: false, status: 503, reason: 'ServiceUnavailable', shouldPrune: false });

    await processPushJob(job);

    expect(mockPrunePushDeviceByToken).not.toHaveBeenCalled();
  });

  it('hands every device to the transport, whichever platform (routing is the transport\'s job)', async () => {
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([
      { deviceToken: 'androidTok', platform: 'android', environment: 'production' },
    ]);
    mockGetUserByInternalId.mockResolvedValue({
      internalId: 7, id: 'uuid-7', email: 'u@example.com', isAdmin: false, tokenGeneration: 1,
    });
    mockGenerateMediaToken.mockReturnValue('tok');
    mockSendPush.mockResolvedValue({ ok: true, status: 200, shouldPrune: false });
    await processPushJob(job);
    expect(mockSendPush).toHaveBeenCalledTimes(1);
    expect(mockSendPush.mock.calls[0][0]).toMatchObject({ deviceToken: 'androidTok', platform: 'android' });
  });

  it('sends nothing when the edition transport is not configured', async () => {
    transportConfigured = false;
    mockGetPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: {} });
    mockGetPushDevicesForUser.mockResolvedValue([
      { deviceToken: 'tok', platform: 'ios', environment: 'production' },
    ]);
    await processPushJob(job);
    expect(mockSendPush).not.toHaveBeenCalled();
  });
});
