import { useState, useMemo } from 'react';
import { useTranslation } from '../i18n';

interface Props {
  /** Full camera list to show. The caller provides the desired order. */
  cameras: string[];
  /** Whether a given camera's checkbox is checked. */
  isChecked: (cam: string) => boolean;
  /** Toggle a single camera's checked state. */
  onToggle: (cam: string) => void;
  /** Check every camera. */
  onSelectAll: () => void;
  /** Uncheck every camera. */
  onSelectNone: () => void;
  /** When provided, render a color dot before each name. Both the timeline
   *  and the grid filter pass the shared per-camera palette. */
  colorMap?: Map<string, string>;
  /** Prefix for data-testids so each host keeps stable selectors. */
  testIdPrefix: string;
}

/**
 * Searchable, scrollable camera checkbox list. Presentational only — it owns
 * the search query, nothing else; the host supplies the checked-state and the
 * mutation callbacks. Renders just the inner body (search + actions + list);
 * the host owns the surrounding popover/section container.
 */
export function CameraChecklist({
  cameras, isChecked, onToggle, onSelectAll, onSelectNone, colorMap, testIdPrefix,
}: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cameras.filter(c => c.toLowerCase().includes(q));
  }, [cameras, search]);

  return (
    <>
      <input
        className="timeline-camfilter-search"
        type="search"
        placeholder={t('timeline.searchCameras')}
        value={search}
        onChange={e => setSearch(e.target.value)}
        data-testid={`${testIdPrefix}-search`}
      />
      <div className="timeline-camfilter-actions">
        <button type="button" className="btn btn-sm" onClick={onSelectAll} data-testid={`${testIdPrefix}-all`}>
          {t('timeline.selectAll')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onSelectNone} data-testid={`${testIdPrefix}-none`}>
          {t('timeline.selectNone')}
        </button>
      </div>
      <div className="timeline-camfilter-list">
        {matches.length === 0 && (
          <div className="timeline-camfilter-empty">{t('timeline.noCamerasMatch')}</div>
        )}
        {matches.map(cam => (
          <label key={cam} className="timeline-camfilter-item" data-testid={`${testIdPrefix}-item-${cam}`}>
            <input type="checkbox" checked={isChecked(cam)} onChange={() => onToggle(cam)} />
            {colorMap && <span className="timeline-camera-dot" style={{ background: colorMap.get(cam) }} />}
            <span className="timeline-cam-name">{cam}</span>
          </label>
        ))}
      </div>
    </>
  );
}
