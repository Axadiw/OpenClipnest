import { useEffect, useLayoutEffect, useRef } from 'react';
import { dropRecording } from '../lib/scrubCache/client';
import { videoCacheKey } from '../sw/videoRequest';

/**
 * Frees a recording's cached bytes in the service worker when its player closes or switches
 * to another recording/view. Keyed on the cache key, not the URL: a fresh media token, a
 * stall retry or the timeline's per-seek remount of the same clip keep the bytes.
 */
export function useScrubCacheLifetime(videoUrl: string | null): void {
  const key = videoUrl ? videoCacheKey(videoUrl) : null;
  const urlRef = useRef(videoUrl);
  // Layout effects run before passive ones, so the effect below sees this render's URL.
  useLayoutEffect(() => {
    urlRef.current = videoUrl;
  });
  useEffect(() => {
    const url = urlRef.current;
    if (!key || !url) return;
    return () => dropRecording(url);
  }, [key]);
}
