import { useState, useCallback } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n';

interface Props {
  eventIds: string[];
  label: string;
  onClose: () => void;
  onDone: (deleted: number) => void;
}

const CHUNK_SIZE = 100;

export function BulkDeleteDialog({ eventIds, label, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [deleted, setDeleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const total = eventIds.length;

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    let done = 0;
    try {
      for (let i = 0; i < eventIds.length; i += CHUNK_SIZE) {
        const chunk = eventIds.slice(i, i + CHUNK_SIZE);
        const r = await api.bulkDeleteEvents(chunk);
        done += r.deleted;
        setDeleted(done);
      }
      onDone(done);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed');
      setRunning(false);
    }
  }, [eventIds, onClose, onDone]);

  const percent = total > 0 ? Math.round((deleted / total) * 100) : 0;

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal bulk-delete-modal" onClick={e => e.stopPropagation()}>
        <h3>{t('events.bulkDeleteTitle')}</h3>
        <p>{t('events.bulkDeleteConfirm', { label, count: String(total) })}</p>
        {running && (
          <div className="bulk-progress" data-testid="bulk-delete-progress">
            <div className="bulk-progress-bar" style={{ width: `${percent}%` }} />
            <span className="bulk-progress-label">{deleted} / {total} ({percent}%)</span>
          </div>
        )}
        {error && <div className="error-msg">{error}</div>}
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={running}>{t('plans.cancel')}</button>
          <button className="btn btn-sm btn-danger" onClick={start} disabled={running}>{t('events.delete')}</button>
        </div>
      </div>
    </div>
  );
}
