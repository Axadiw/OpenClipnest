import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  eventId: string;
  visible: boolean;
  className?: string;
}

// Renders the event's thumbnail behind the <video> with a heavy CSS blur,
// so the user gets an immediate sense of "the right clip is loading" instead
// of staring at a flat black rectangle while the mp4 buffers. Falls back to
// a solid black layer when the thumbnail isn't available yet (404 / 403 /
// not generated) — same baseline as before.
export function BlurredThumbnailBackdrop({ eventId, visible, className }: Props) {
  const [src, setSrc] = useState<string | undefined>();
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    api.fetchThumbnailBlob(eventId)
      .then(url => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        urlRef.current = url;
        setSrc(url);
      })
      .catch(() => { /* thumbnail not ready — keep solid-black fallback */ });
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [eventId]);

  const classes = ['blurred-thumbnail-backdrop'];
  if (!visible) classes.push('is-hidden');
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')} aria-hidden="true" data-testid="blurred-thumbnail-backdrop">
      {src && <img src={src} alt="" />}
    </div>
  );
}
