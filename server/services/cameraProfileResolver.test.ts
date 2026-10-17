import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CameraEvent, UserCameraProfile } from '../types.js';

vi.mock('../db/queries/cameraProfiles.js', () => ({
  getCameraProfileSettings: vi.fn(),
  updateUserCameraProfile: vi.fn(),
}));

import { getCameraProfileSettings, updateUserCameraProfile } from '../db/queries/cameraProfiles.js';
import { enrichEventsWithViewMeta, enrichEventWithViewMeta, buildCustomProfile, getEffectiveProfiles, GLOBAL_CAMERA_PROFILES } from './cameraProfileResolver.js';
import { classifyFilename } from '../config/cameraProfiles.js';
import { _shutdownRegexWorker } from './untrustedRegex.js';

const settingsMock = getCameraProfileSettings as unknown as ReturnType<typeof vi.fn>;
const updateMock = updateUserCameraProfile as unknown as ReturnType<typeof vi.fn>;

function makeEvent(viewIds: string[]): CameraEvent {
  return {
    id: `ev-${viewIds.join('-')}`,
    camera: 'Cam_01',
    timestamp: '2026-05-28T08:00:00.000Z',
    date: '2026-05-28',
    views: viewIds.map(id => ({ id, videoRelPath: `p/${id}.mp4` })),
    thumbnail: 'thumb',
  };
}

describe('enrichEventsWithViewMeta', () => {
  beforeEach(() => settingsMock.mockReset());

  it("attaches iconKind+label from Reolink (clipnest-default) profile to '00' and '01' views", async () => {
    settingsMock.mockResolvedValue({ mode: 'reolink', profiles: [] });
    const events = [makeEvent(['00', '01'])];
    const out = await enrichEventsWithViewMeta(events, 'uuid-1');
    expect(out[0].views).toEqual([
      { id: '00', videoRelPath: 'p/00.mp4', label: 'profile.view.wide', iconKind: 'wide' },
      { id: '01', videoRelPath: 'p/01.mp4', label: 'profile.view.zoom', iconKind: 'zoom' },
    ]);
  });

  it("uses single-view 'generic' icon for hikvision mode '00' view", async () => {
    settingsMock.mockResolvedValue({ mode: 'hikvision', profiles: [] });
    const events = [makeEvent(['00'])];
    const out = await enrichEventsWithViewMeta(events, 'uuid-2');
    expect(out[0].views[0]).toMatchObject({ id: '00', iconKind: 'generic', label: 'profile.view.camera' });
  });

  it('falls back to original view when no profile matches the id', async () => {
    settingsMock.mockResolvedValue({ mode: 'reolink', profiles: [] });
    const events = [makeEvent(['xx-unknown'])];
    const out = await enrichEventsWithViewMeta(events, 'uuid-3');
    expect(out[0].views[0]).toEqual({ id: 'xx-unknown', videoRelPath: 'p/xx-unknown.mp4' });
  });

  it('returns empty input unchanged without hitting profile resolver', async () => {
    const out = await enrichEventsWithViewMeta([], 'uuid-4');
    expect(out).toEqual([]);
    expect(settingsMock).not.toHaveBeenCalled();
  });

  it('single-event variant also enriches', async () => {
    settingsMock.mockResolvedValue({ mode: 'reolink', profiles: [] });
    const out = await enrichEventWithViewMeta(makeEvent(['00']), 'uuid-6');
    expect(out.views[0]).toMatchObject({ iconKind: 'wide' });
  });

  it('custom profile enrichment uses the per-view iconKind from viewsConfig', async () => {
    const profile: UserCameraProfile = {
      id: 7,
      name: 'My Multi-view Cam',
      regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      viewDefault: '00',
      viewsConfig: [
        { id: '00', iconKind: 'thermal' },
        { id: '01', iconKind: 'doorbell' },
      ],
      priority: 10,
      enabled: true,
      createdAt: '2026-05-28T00:00:00.000Z',
    };
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [profile] });
    const out = await enrichEventsWithViewMeta([makeEvent(['00', '01'])], 'uuid-7');
    expect(out[0].views).toEqual([
      { id: '00', videoRelPath: 'p/00.mp4', label: 'My Multi-view Cam', iconKind: 'thermal' },
      { id: '01', videoRelPath: 'p/01.mp4', label: 'My Multi-view Cam', iconKind: 'doorbell' },
    ]);
  });
});

describe('buildCustomProfile', () => {
  function makeProfile(overrides: Partial<UserCameraProfile> = {}): UserCameraProfile {
    return {
      id: 1,
      name: 'CustomCam',
      regex: '^(?<camera>.+)_(?<view>[^_]+)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      viewDefault: 'main',
      viewsConfig: [{ id: 'main', iconKind: 'generic' }],
      priority: 0,
      enabled: true,
      createdAt: '2026-05-28T00:00:00.000Z',
      ...overrides,
    };
  }

  it('builds views[] from viewsConfig, mapping each entry to {id, label=name, iconKind}', () => {
    const p = makeProfile({
      viewsConfig: [
        { id: 'wideview', iconKind: 'wide' },
        { id: 'teleview', iconKind: 'tele' },
        { id: 'ptzview', iconKind: 'ptz' },
      ],
      viewDefault: 'wideview',
    });
    const built = buildCustomProfile(p);
    expect(built.views).toEqual([
      { id: 'wideview', label: 'CustomCam', iconKind: 'wide' },
      { id: 'teleview', label: 'CustomCam', iconKind: 'tele' },
      { id: 'ptzview', label: 'CustomCam', iconKind: 'ptz' },
    ]);
  });

  it('falls back to a single generic view from viewDefault when viewsConfig is empty', () => {
    const p = makeProfile({ viewsConfig: [], viewDefault: 'fallbackid' });
    const built = buildCustomProfile(p);
    expect(built.views).toEqual([{ id: 'fallbackid', label: 'CustomCam', iconKind: 'generic' }]);
  });

  it('extract() returns the matched view group id over viewDefault', () => {
    const p = makeProfile({ viewDefault: 'main' });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('Garage_zoomlens_20240115143022.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toEqual({
      camera: 'Garage',
      view: 'zoomlens',
      tsRaw: '20240115143022',
      ext: 'mp4',
    });
  });

  // ts-relaxation: dashed/segmented timestamps strip down to a 14-digit run.
  it('normalizes an Axis dashed ts (YYYY-MM-DD_HH-MM-SS) to a 14-digit tsRaw', () => {
    const p = makeProfile({
      name: 'Axis',
      regex: '^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.(?<ext>mp4)$',
      viewDefault: '00',
      viewsConfig: [{ id: '00', iconKind: 'generic' }],
    });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('Parking_2024-01-15_14-30-22.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toEqual({
      camera: 'Parking',
      view: '00',
      tsRaw: '20240115143022',
      ext: 'mp4',
    });
  });

  it('normalizes a Foscam dashed ts (YYYYMMDD-HHMMSS) to a 14-digit tsRaw', () => {
    const p = makeProfile({
      name: 'Foscam',
      regex: '^(?<camera>MDAlarm)_(?<ts>\\d{8}-\\d{6})\\.(?<ext>mp4)$',
      viewDefault: '00',
      viewsConfig: [{ id: '00', iconKind: 'generic' }],
    });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('MDAlarm_20240115-143022.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toEqual({
      camera: 'MDAlarm',
      view: '00',
      tsRaw: '20240115143022',
      ext: 'mp4',
    });
  });

  it('still accepts a contiguous (?<ts>\\d{14}) as a no-op normalization', () => {
    const p = makeProfile({
      regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      viewDefault: '00',
    });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('Front_01_20240115143022.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toMatchObject({ tsRaw: '20240115143022', view: '01' });
  });

  it('rejects a ts group that is NOT 14 digits after stripping separators', () => {
    // \d{8} → 8 digits after strip → not 14 → extract returns null (no classification).
    const p = makeProfile({
      regex: '^(?<camera>.+)_(?<ts>\\d{8})\\.(?<ext>mp4)$',
      viewDefault: '00',
    });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('Cam_20240115.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toBeNull();
  });

  it('rejects a dashed ts whose digits do not total 14', () => {
    // YYYY-MM-DD (10 digits) → rejected.
    const p = makeProfile({
      regex: '^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2})\\.(?<ext>mp4)$',
      viewDefault: '00',
    });
    const built = buildCustomProfile(p);
    const m = built.regex.exec('Cam_2024-01-15.mp4');
    expect(m).not.toBeNull();
    expect(built.extract(m!)).toBeNull();
  });
});

describe('getEffectiveProfiles — empty-custom fallback', () => {
  beforeEach(() => settingsMock.mockReset());

  function customProfile(overrides: Partial<UserCameraProfile> = {}): UserCameraProfile {
    return {
      id: 1,
      name: 'CustomCam',
      regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      viewDefault: '00',
      viewsConfig: [{ id: '00', iconKind: 'generic' }],
      priority: 0,
      enabled: true,
      createdAt: '2026-05-28T00:00:00.000Z',
      ...overrides,
    };
  }

  it('falls back to global profiles when mode=custom but zero profiles exist', async () => {
    // Regression: a custom-mode user with no profiles resolved
    // to [] → parseS3Keys classified 0 files → 0 events, and a full rescan WIPED
    // the whole event history. Empty custom MUST fall back to global, not [].
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [] });
    const out = await getEffectiveProfiles('uuid-empty-custom');
    expect(out).toBe(GLOBAL_CAMERA_PROFILES);
  });

  it('falls back to global when every custom profile is disabled', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile({ enabled: false })] });
    const out = await getEffectiveProfiles('uuid-all-disabled');
    expect(out).toBe(GLOBAL_CAMERA_PROFILES);
  });

  it('uses custom profiles when at least one is enabled', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile({ id: 9, enabled: true })] });
    const out = await getEffectiveProfiles('uuid-ok');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('custom:9');
  });
});

describe('getEffectiveProfiles — untrusted custom-profile vetting (regression 2026-06-22)', () => {
  // Root cause: R3 deleted the scanner's vetUntrustedProfiles step, which flipped
  // safe user regexes to `untrusted: false`. classifyFilename SKIPS any profile
  // still flagged untrusted (ReDoS guard), so every upload from a custom-mode user
  // resolved to NO match → processing_state='unrecognized' → invisible, no banner.
  beforeEach(() => { settingsMock.mockReset(); updateMock.mockReset(); });
  afterAll(async () => { await _shutdownRegexWorker(); });

  function customProfile(overrides: Partial<UserCameraProfile> = {}): UserCameraProfile {
    return {
      id: 6,
      name: 'Reolink',
      regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4|m4v|mov|mkv|webm|avi|ts|3gp|jpg|jpeg|png)$',
      viewDefault: '00',
      viewsConfig: [{ id: '00', iconKind: 'wide' }, { id: '01', iconKind: 'zoom' }],
      priority: 10,
      enabled: true,
      createdAt: '2026-05-30T00:00:00.000Z',
      ...overrides,
    };
  }

  it('vets a safe custom regex (untrusted→false) so classifyFilename matches it', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile()] });
    const profiles = await getEffectiveProfiles('uuid-reolink-custom');
    expect(profiles).toHaveLength(1);
    expect(profiles[0].untrusted).toBe(false);
    // The exact prod failure: an un-vetted (untrusted) profile is skipped by
    // classifyFilename → null → 'unrecognized'. After vetting it matches.
    const classified = classifyFilename('Driveway_01_20260622094644.mp4', profiles);
    expect(classified).toMatchObject({ camera: 'Driveway', view: '01', tsRaw: '20260622094644', ext: 'mp4' });
  });

  it('disables a catastrophic-backtracking custom regex and falls back to global (never resolves to [])', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile({ id: 13, regex: '(a+)+$' })] });
    const profiles = await getEffectiveProfiles('uuid-redos');
    expect(profiles).toBe(GLOBAL_CAMERA_PROFILES);
    expect(updateMock).toHaveBeenCalledWith(13, 'uuid-redos', { enabled: false });
  });

  it('keeps the safe profile and disables ONLY the catastrophic one when both are present', async () => {
    settingsMock.mockResolvedValue({
      mode: 'custom',
      profiles: [
        customProfile({ id: 6 }), // safe Reolink
        // Distinct catastrophic source from the redos test above so it's a
        // cache MISS here and the disable side-effect actually fires (the
        // vetting cache is keyed by regex source, not profile id).
        customProfile({ id: 14, name: 'Bad', regex: '(\\d+)+$', priority: 20 }),
      ],
    });
    const profiles = await getEffectiveProfiles('uuid-mixed');
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('custom:6');
    expect(profiles[0].untrusted).toBe(false);
    expect(updateMock).toHaveBeenCalledWith(14, 'uuid-mixed', { enabled: false });
    expect(updateMock).not.toHaveBeenCalledWith(6, expect.anything(), expect.anything());
    // The surviving safe profile still classifies.
    expect(classifyFilename('Front_00_20260622094413.mp4', profiles))
      .toMatchObject({ camera: 'Front', view: '00' });
  });

  it('a vetted profile whose regex does not match the file still yields no classification (the genuine unrecognized path is preserved)', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile()] });
    const profiles = await getEffectiveProfiles('uuid-nomatch');
    expect(profiles[0].untrusted).toBe(false);
    // The Reolink regex requires a _00_/_01_ view segment; this name has none.
    expect(classifyFilename('RandomClip.mp4', profiles)).toBeNull();
  });

  it('is idempotent across repeated resolves (vetting cache-hit path)', async () => {
    settingsMock.mockResolvedValue({ mode: 'custom', profiles: [customProfile({ id: 6 })] });
    const first = await getEffectiveProfiles('uuid-cache');
    const second = await getEffectiveProfiles('uuid-cache');
    expect(first[0].untrusted).toBe(false);
    expect(second[0].untrusted).toBe(false);
    expect(second[0].name).toBe(first[0].name);
  });
});
