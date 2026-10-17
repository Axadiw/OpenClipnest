import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

interface AuthImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  eventId: string;
}

export function AuthImage({ eventId, ...props }: AuthImageProps) {
  const [src, setSrc] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSrc(undefined);
    api.fetchThumbnailBlob(eventId)
      .then(url => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        urlRef.current = url;
        setSrc(url);
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [eventId]);

  if (failed) return <div className="no-thumbnail"><ThumbnailPlaceholder /></div>;
  if (!src) return <div className="no-thumbnail"><ThumbnailPlaceholder loading /></div>;
  return <img src={src} {...props} />;
}

function ThumbnailPlaceholder({ loading }: { loading?: boolean }) {
  return (
    <div className="thumb-placeholder">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={loading ? 0.3 : 0.5}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
        <polygon points="9.5 8 9.5 14 15 11 9.5 8" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}
