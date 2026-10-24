import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const dropRecording = vi.fn();
vi.mock('../lib/scrubCache/client', () => ({ dropRecording: (u: string) => dropRecording(u) }));
const { useScrubCacheLifetime } = await import('./useScrubCacheLifetime');

const A1 = '/api/v0/events/a/video/00?media_token=T1&fmt=clean';
const A2 = '/api/v0/events/a/video/00?media_token=T2&fmt=clean&retry=1';
const B = '/api/v0/events/b/video/00?media_token=T3&fmt=clean';

describe('useScrubCacheLifetime', () => {
  it('drops on key change and unmount, not on a new token for the same clip', () => {
    const { rerender, unmount } = renderHook(({ url }) => useScrubCacheLifetime(url), { initialProps: { url: A1 as string | null } });
    rerender({ url: A2 });
    expect(dropRecording).not.toHaveBeenCalled();
    rerender({ url: B });
    expect(dropRecording.mock.calls).toEqual([[A1]]);
    rerender({ url: null });
    expect(dropRecording.mock.calls).toEqual([[A1], [B]]);
    rerender({ url: A1 });
    unmount();
    expect(dropRecording.mock.calls).toEqual([[A1], [B], [A1]]);
  });
});
