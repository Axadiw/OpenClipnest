import { useEffect, useRef } from 'react';
import { reportPlayback } from '../api';

interface Sent {
  key: string | null;
  started: boolean;
  completed: boolean;
}

/**
 * Reports playback starts and completions for a `<video>` element.
 *
 * Two events, deliberately distinct:
 *   started   — the first `playing` for a given recording. A "start" is one
 *               person opening one recording, so pausing, resuming and seeking
 *               must not re-fire it.
 *   completed — the native `ended` event. Literal on purpose: closing the tab
 *               at 98% is not watching to the end, and any percentage
 *               threshold would be an invented number nobody could interpret.
 *
 * `recordingKey` (the event id) is what counting is keyed on, NOT the video
 * `src`. The src changes for things that are still the same viewing: switching
 * between the wide and zoom view of one recording, and the stall-retry hook's
 * cache-busting reload. Keying on it would report a fresh playback for each,
 * and a flaky uplink would then read as engagement.
 *
 * `bindToken` is separate and exists only to re-attach the listeners when the
 * element or its source is swapped — the timeline remounts its `<video>` on
 * every click-to-seek. The already-sent flags live in a ref keyed by
 * `recordingKey`, so re-binding does not reset them.
 *
 * Shared by the grid player and the timeline's inline player because they are
 * separate `<video>` elements; a beacon wired into only one of them would
 * silently under-count whichever surface people actually use.
 */
export function usePlaybackBeacon(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  recordingKey: string | null,
  bindToken?: unknown,
): void {
  const sentRef = useRef<Sent>({ key: null, started: false, completed: false });

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !recordingKey) return;

    const stateForThisRecording = (): Sent => {
      if (sentRef.current.key !== recordingKey) {
        sentRef.current = { key: recordingKey, started: false, completed: false };
      }
      return sentRef.current;
    };

    const onPlaying = () => {
      const s = stateForThisRecording();
      if (s.started) return;
      s.started = true;
      reportPlayback('started');
    };
    const onEnded = () => {
      const s = stateForThisRecording();
      // Replaying the same clip must not count again: it would add a completion
      // with no matching start and push the completion rate above 100%.
      if (s.completed) return;
      s.completed = true;
      reportPlayback('completed');
    };

    v.addEventListener('playing', onPlaying);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('ended', onEnded);
    };
  }, [videoRef, recordingKey, bindToken]);
}
