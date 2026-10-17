import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useRecordings } from '../hooks/useRecordings';
import { TimelineView } from './TimelineView';
import { useShell } from './AuthedShell';

export function TimelineRoute() {
  const { t } = useTranslation();
  const recordings = useRecordings();
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    recordings.loadCameras();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goGrid = () => {
    try { localStorage.setItem('viewMode', 'grid'); } catch { /* ignore */ }
    // Drop timeline-only params: `date` (grid doesn't use it) and the
    // inline-player triple `event`/`view`/`t` (carrying those into grid
    // would auto-pop the modal player on top of the freshly-toggled view).
    const next = new URLSearchParams(searchParams);
    next.delete('date');
    next.delete('event');
    next.delete('view');
    next.delete('t');
    const qs = next.toString();
    navigate(`/grid${qs ? '?' + qs : ''}`);
  };

  return (
    <>
      <div className="toolbar">
        <div className="view-toggle" style={{ marginLeft: 'auto' }}>
          <button className="btn btn-sm" onClick={goGrid} title={t('view.grid')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </button>
          <button className="btn btn-sm active" title={t('view.timeline')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="6" x2="22" y2="6" opacity="0.3"/><line x1="2" y1="12" x2="22" y2="12" opacity="0.3"/><line x1="2" y1="18" x2="22" y2="18" opacity="0.3"/><rect x="4" y="4" width="7" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="10" width="5" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="6" y="16" width="9" height="4" rx="1" fill="currentColor" stroke="none"/></svg>
          </button>
        </div>
      </div>
      <TimelineView
        cameraFilter={recordings.filters.cameras}
        onPlay={shell.openPlayer}
        allCameras={recordings.cameras}
      />
    </>
  );
}
