import { describe, it, expect } from 'vitest';
import { videoCacheKey, upstreamUrl, parseRange, parseContentRange } from './videoRequest';

describe('videoRequest', () => {
  it('token and retry are stripped from key', () => {
    const a = videoCacheKey('/api/v0/events/abc/video/00?media_token=T1&fmt=clean');
    expect(a).toBe('abc/00/clean');
    expect(videoCacheKey('/api/v0/events/abc/video/00?media_token=T2&fmt=clean&retry=3&scrub=1')).toBe(a);
  });

  it('keys absolute URLs the same as relative ones', () => {
    expect(videoCacheKey('https://clipnest.example/api/v0/events/abc/video/01?fmt=clean&media_token=T')).toBe('abc/01/clean');
  });

  it('ignores non-clean and non-video URLs', () => {
    expect(videoCacheKey('/api/v0/events/abc/video/00?media_token=T')).toBeNull();
    expect(videoCacheKey('/api/v0/events/abc/video/00/original?media_token=T&fmt=clean')).toBeNull();
    expect(videoCacheKey('/api/v0/events/abc/thumbnail?fmt=clean')).toBeNull();
  });

  it('parses ranges', () => {
    expect(parseRange('bytes=0-')).toEqual({ start: 0, end: null });
    expect(parseRange('bytes=0-1')).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=-500')).toBeNull();
    expect(parseRange('bytes=0-1,5-9')).toBeNull();
    expect(parseRange('bytes=9-5')).toBeNull();
    expect(parseRange(null)).toBeNull();
    expect(parseContentRange('bytes 10-19/100')).toEqual({ start: 10, end: 19, total: 100 });
    expect(parseContentRange('bytes */100')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });

  it('upstreamUrl drops only scrub and keeps the token encoding', () => {
    expect(upstreamUrl('/api/v0/events/abc/video/00?media_token=a%2Bb&fmt=clean&scrub=1&retry=2'))
      .toBe('/api/v0/events/abc/video/00?media_token=a%2Bb&fmt=clean&retry=2');
    expect(upstreamUrl('https://h/api/v0/events/abc/video/00?scrub=1')).toBe('https://h/api/v0/events/abc/video/00');
    expect(upstreamUrl('/x?fmt=clean')).toBe('/x?fmt=clean');
  });
});
