import { describe, it, expect } from 'vitest';
import { slugify, formatScreenshotFilename, viewportSize, validateConfigEntry } from './helpers.js';
import { story } from '../../testing/story.js';

describe('slugify', () => {
  it('takes the first few meaningful words and kebab-cases them', () => {
    expect(slugify('Per-camera storage visualization plus iOS-style controls in settings.')).toBe('per-camera-storage-visualization-plus');
  });

  it('strips punctuation and trailing dots', () => {
    expect(slugify('Group same-kind notification entries in bell dropdown.')).toBe('group-same-kind-notification-entries');
  });

  it('lowercases', () => {
    expect(slugify('FIX BIG BAD BUG')).toBe('fix-big-bad-bug');
  });

  it('caps total length at 40 chars without breaking a word in the middle', () => {
    const out = slugify('Distinguish New features pill from Bugfixes pill with coral tint and screenshots');
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });

  it('drops short noise words like "a", "the", "to" before counting the 4 words', () => {
    expect(slugify('Add a bottom margin to the processing-status banner')).toBe('add-bottom-margin-processing-status');
  });

  it('falls back to "feature" when the input is empty or unspeakable', () => {
    expect(slugify('')).toBe('feature');
    expect(slugify('!!!')).toBe('feature');
  });
});

describe('formatScreenshotFilename', () => {
  it('combines tag + 1-based bullet index + slug + .png', () => {
    expect(formatScreenshotFilename('v0.10.125', 1, 'storage-bars')).toBe('v0.10.125-1-storage-bars.png');
    expect(formatScreenshotFilename('v0.10.125', 12, 'mobile-nav')).toBe('v0.10.125-12-mobile-nav.png');
  });

  it('the resulting filename matches the backend regex', (ctx) => {
    story(ctx, 'Filename muszą być akceptowane przez `SCREENSHOT_FILENAME_RE` w server/routes/admin/changelog.ts. Test pilnuje, że klient (skrypt) i serwer (endpoint) mówią tym samym formatem.');
    const re = /^v\d+\.\d+\.\d+-\d+-[a-z0-9-]+\.png$/;
    expect(re.test(formatScreenshotFilename('v0.10.125', 1, 'storage-bars'))).toBe(true);
    expect(re.test(formatScreenshotFilename('v9.99.999', 42, 'a-b-c-d'))).toBe(true);
  });

  it('throws on a slug that the backend would reject', () => {
    expect(() => formatScreenshotFilename('v0.10.125', 1, 'Has Spaces')).toThrow();
    expect(() => formatScreenshotFilename('v0.10.125', 1, 'has_underscore')).toThrow();
    expect(() => formatScreenshotFilename('not-a-tag', 1, 'foo')).toThrow();
  });
});

describe('viewportSize', () => {
  it('desktop is 1280x800', () => {
    expect(viewportSize('desktop')).toEqual({ width: 1280, height: 800 });
  });
  it('mobile is 390x844 (iPhone 14)', () => {
    expect(viewportSize('mobile')).toEqual({ width: 390, height: 844 });
  });
  it('throws for unknown', () => {
    expect(() => viewportSize('tablet' as never)).toThrow();
  });
});

describe('validateConfigEntry', () => {
  const ok = {
    tag: 'v0.10.125',
    bulletIndex: 1,
    slug: 'storage-bars',
    url: '/admin?tab=changelog',
    selector: '.admin-changelog',
    viewport: 'desktop' as const,
  };

  it('accepts a well-formed entry', () => {
    expect(() => validateConfigEntry(ok)).not.toThrow();
  });

  it('rejects external URLs', (ctx) => {
    story(ctx, 'Skrypt musi mieć fixed-base local URL — żeby model nie zrobił screenshota np. produkcji albo cudzej strony przez przypadek. URL z config-a to PATH (zaczyna się od /), nie pełny http://...');
    expect(() => validateConfigEntry({ ...ok, url: 'http://evil.example/' })).toThrow();
    expect(() => validateConfigEntry({ ...ok, url: '//evil.example/' })).toThrow();
  });

  it('rejects URLs without a leading slash', () => {
    expect(() => validateConfigEntry({ ...ok, url: 'admin' })).toThrow();
  });

  it('rejects empty selector', () => {
    expect(() => validateConfigEntry({ ...ok, selector: '' })).toThrow();
  });

  it('rejects bullet indexes <= 0', () => {
    expect(() => validateConfigEntry({ ...ok, bulletIndex: 0 })).toThrow();
    expect(() => validateConfigEntry({ ...ok, bulletIndex: -1 })).toThrow();
  });
});
