import { describe, it, expect, afterAll } from 'vitest';
import {
  buildGlobalProfiles,
  classifyFilename,
  VENDOR_PROFILE_TEMPLATES,
  type CameraProfile,
} from './cameraProfiles.js';
import {
  MAX_UNTRUSTED_INPUT,
  assertUntrustedRegexSafe,
  _shutdownRegexWorker,
} from '../services/untrustedRegex.js';

const TRUSTED = buildGlobalProfiles(['mp4', 'jpg'], []);

function customProfile(id: number, source: string, untrusted: boolean): CameraProfile {
  return {
    name: `custom:${id}`,
    regex: new RegExp(source, 'i'),
    untrusted,
    custom: { id },
    views: [{ id: '00', label: 'Cam', iconKind: 'generic' }],
    extract: (m) => {
      const g = m.groups ?? {};
      if (!g.camera || !g.ts || !g.ext) return null;
      return { camera: g.camera, view: '00', tsRaw: g.ts, ext: g.ext.toLowerCase() };
    },
  };
}

describe('classifyFilename', () => {
  it('matches a trusted built-in profile', () => {
    const r = classifyFilename('Front_00_20260101120000.mp4', TRUSTED);
    expect(r).toMatchObject({ camera: 'Front', view: '00', tsRaw: '20260101120000', ext: 'mp4' });
  });

  it('SKIPS a profile still flagged untrusted (must be vetted first)', () => {
    // The regex would match, but classifyFilename refuses untrusted profiles so
    // an un-vetted (potentially catastrophic) regex never runs on the event loop.
    const profiles = [customProfile(1, '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', true)];
    expect(classifyFilename('Garden_20260101120000.mp4', profiles)).toBeNull();
  });

  it('runs a vetted custom profile (untrusted=false) natively', () => {
    const profiles = [customProfile(2, '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', false)];
    const r = classifyFilename('Garden_20260101120000.mp4', profiles);
    expect(r).toMatchObject({ camera: 'Garden', tsRaw: '20260101120000', ext: 'mp4' });
  });

  it('returns null for an over-long basename (input length cap)', () => {
    const r = classifyFilename('x'.repeat(MAX_UNTRUSTED_INPUT + 1) + '.mp4', TRUSTED);
    expect(r).toBeNull();
  });
});

describe('VENDOR_PROFILE_TEMPLATES', () => {
  // The worker-thread regex guard keeps a process alive; close it after these tests.
  afterAll(async () => { await _shutdownRegexWorker(); });

  it('ships the four canonical vendors in order', () => {
    expect(VENDOR_PROFILE_TEMPLATES.map(t => t.name)).toEqual(['Reolink', 'Hikvision', 'Axis', 'Foscam']);
  });

  it('every template regex compiles and has the required named groups', () => {
    for (const tpl of VENDOR_PROFILE_TEMPLATES) {
      const re = new RegExp(tpl.regex, 'i');
      expect(re.source).toContain('?<camera>');
      expect(re.source).toContain('?<ts>');
      expect(re.source).toContain('?<ext>');
      expect(tpl.viewsConfig.length).toBeGreaterThanOrEqual(1);
    }
  });

  // Seeded templates are stored as UNTRUSTED user regexes, so each MUST clear
  // the ReDoS guard or the POST that seeds them would 400.
  it('every template regex passes assertUntrustedRegexSafe', async () => {
    for (const tpl of VENDOR_PROFILE_TEMPLATES) {
      const reason = await assertUntrustedRegexSafe(tpl.regex, 'i');
      expect(reason, `${tpl.name}: ${reason}`).toBeNull();
    }
  });
});
