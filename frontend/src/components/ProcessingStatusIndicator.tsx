import { useEffect, useState, useCallback } from 'react';
import { api, type ProcessingStatus } from '../api';
import { useTranslation } from '../i18n';

const POLL_INTERVAL_MS = 15_000;

/**
 * Polls /api/v0/users/me/processing-status every 15s and renders an
 * expandable "Processing N files…" badge while the scanner has work in
 * flight; clicking the badge reveals a scrollable list of pending files
 * (capped server-side at PROCESSING_LIST_LIMIT).
 *
 * Renders nothing when the counter is zero so the toolbar stays clean.
 * Permanent failures used to render here as a dismissable list; retired
 * 2026-05-13 (tombstoned events are hidden from the grid).
 */
export function ProcessingStatusIndicator() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.fetchProcessingStatus();
      setStatus(next);
    } catch {
      // Silent: indicator is non-critical, retry on next tick.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const id = setInterval(() => {
      if (!cancelled) refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh]);

  if (!status) return null;
  const { inProgressCount, inProgressFiles } = status;
  if (inProgressCount === 0) return null;

  const canExpand = inProgressFiles.length > 0;
  const truncated = inProgressCount > inProgressFiles.length;

  return (
    <div className="processing-status" data-testid="processing-status">
      <button
        type="button"
        className="processing-status-inprogress"
        onClick={() => canExpand && setExpanded(e => !e)}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        aria-controls={canExpand ? 'processing-status-files' : undefined}
        data-testid="processing-status-toggle"
      >
        <span className="processing-status-spinner" aria-hidden="true" />
        <span className="processing-status-label">
          {t('processing.inProgress', { count: String(inProgressCount) })}
        </span>
        {canExpand && (
          <span
            className={`processing-status-chevron${expanded ? ' is-open' : ''}`}
            aria-hidden="true"
          >
            ▾
          </span>
        )}
      </button>
      {expanded && canExpand && (
        <ul
          id="processing-status-files"
          className="processing-status-files"
          data-testid="processing-status-files"
        >
          {inProgressFiles.map((f, idx) => (
            <li
              key={`${f.filename}-${f.uploadedAt}-${idx}`}
              className="processing-status-file"
            >
              <span className="processing-status-file-name">{f.filename}</span>
            </li>
          ))}
          {truncated && (
            <li className="processing-status-file processing-status-file-more">
              {t('processing.andMore', {
                count: String(inProgressCount - inProgressFiles.length),
              })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
