import { useEffect, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n';

interface CameraRow {
  camera: string;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface Props {
  onPickCamera?: (camera: string) => void;
}

export function CamerasSection({ onPickCamera }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CameraRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getCamerasDetailed()
      .then(r => setRows(r.cameras))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="settings-error">{error}</div>;
  if (!rows) return <div className="spinner" />;
  if (rows.length === 0) return <div className="settings-empty">{t('settings.camerasEmpty')}</div>;

  const clickable = !!onPickCamera;
  return (
    // The wrapper is what keeps the 4-column table from being clipped on a
    // narrow viewport: the page itself doesn't scroll horizontally, so
    // without it the rightmost "Events" column is simply cut off. Camera
    // names and localised headers are unbounded, so a scroll container is
    // the only width-independent guarantee — mobile cell padding is
    // tightened in CSS so it rarely has to actually scroll.
    <div className="cameras-table-wrap">
      <table className="cameras-table">
        <thead>
          <tr>
            <th>{t('settings.cameraName')}</th>
            <th>{t('settings.firstEvent')}</th>
            <th>{t('settings.lastEvent')}</th>
            <th>{t('settings.eventCount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.camera}
              className={clickable ? 'cameras-row-clickable' : undefined}
              onClick={clickable ? () => onPickCamera!(r.camera) : undefined}
              title={clickable ? t('settings.openInEvents', { camera: r.camera }) : undefined}
            >
              <td>{r.camera}</td>
              <td>{fmt(r.firstEventAt)}</td>
              <td>{fmt(r.lastEventAt)}</td>
              <td>{r.eventCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
