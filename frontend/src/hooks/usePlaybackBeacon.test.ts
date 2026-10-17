import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';

const reportPlayback = vi.fn();
vi.mock('../api', () => ({ reportPlayback: (kind: string) => reportPlayback(kind) }));

import { usePlaybackBeacon } from './usePlaybackBeacon';

interface Props { key: string | null; bind: unknown }

function mount(video: HTMLVideoElement | null, recordingKey: string | null, bind: unknown = 'src') {
  const ref = createRef<HTMLVideoElement>() as React.RefObject<HTMLVideoElement | null>;
  ref.current = video;
  const hook = renderHook(
    ({ key, bind: b }: Props) => usePlaybackBeacon(ref, key, b),
    { initialProps: { key: recordingKey, bind } },
  );
  return { ...hook, ref };
}

const kinds = () => reportPlayback.mock.calls.map(c => c[0]);

describe('usePlaybackBeacon', () => {
  beforeEach(() => reportPlayback.mockClear());

  it('reports a start on the first play and a completion when the clip ends', () => {
    const v = document.createElement('video');
    mount(v, 'ev-1');

    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('ended'));

    expect(kinds()).toEqual(['started', 'completed']);
  });

  it('counts one start per recording, not one per press of play', () => {
    // Pausing, resuming and seeking all re-fire `playing`. Without the guard a
    // single scrubbed-through clip would report a dozen playbacks and the daily
    // figure would measure fidgeting rather than viewing.
    const v = document.createElement('video');
    mount(v, 'ev-1');

    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('playing'));

    expect(reportPlayback).toHaveBeenCalledTimes(1);
  });

  it('does not re-count a replay of the same clip', () => {
    // `ended` fires again on replay. Counting it would add a completion with no
    // matching start and push the completion rate above 100% — a number that
    // reads as a broken dashboard.
    const v = document.createElement('video');
    mount(v, 'ev-1');

    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('ended'));
    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('ended'));

    expect(kinds()).toEqual(['started', 'completed']);
  });

  it('stays one playback when the source is swapped for the same recording', () => {
    // Switching between the wide and zoom view, and the stall-retry hook's
    // cache-busting reload, both replace the src while the user keeps watching
    // the same recording. A src-keyed beacon would report each as a new
    // playback, so a flaky uplink would read as engagement.
    const v = document.createElement('video');
    const { rerender } = mount(v, 'ev-1', 'src-a');

    v.dispatchEvent(new Event('playing'));
    rerender({ key: 'ev-1', bind: 'src-b' });
    v.dispatchEvent(new Event('playing'));

    expect(reportPlayback).toHaveBeenCalledTimes(1);
  });

  it('re-attaches its listeners when the element is remounted mid-recording', () => {
    // The timeline drops and recreates its <video> on every click-to-seek. If
    // the hook did not rebind, the beacon would go quiet for the rest of the
    // session after the first seek.
    const first = document.createElement('video');
    const { rerender, ref } = mount(first, 'ev-1', 'seek-0');

    const replacement = document.createElement('video');
    ref.current = replacement;
    rerender({ key: 'ev-1', bind: 'seek-12' });

    replacement.dispatchEvent(new Event('ended'));

    expect(kinds()).toEqual(['completed']);
  });

  it('counts the next recording separately', () => {
    const v = document.createElement('video');
    const { rerender } = mount(v, 'ev-1');

    v.dispatchEvent(new Event('playing'));
    rerender({ key: 'ev-2', bind: 'src' });
    v.dispatchEvent(new Event('playing'));

    expect(kinds()).toEqual(['started', 'started']);
  });

  it('stays silent with no recording — a mounted player nobody opened is not a playback', () => {
    const v = document.createElement('video');
    mount(v, null);

    v.dispatchEvent(new Event('playing'));

    expect(reportPlayback).not.toHaveBeenCalled();
  });
});
