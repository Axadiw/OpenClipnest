import { useTranslation } from '../i18n';
import { CameraConnectionDetails } from './CameraConnectionDetails';

interface Props {
  /** True when the grid is empty *because* active filters hid every recording,
   *  not because the account has none. Switches the copy from the first-time
   *  "No recordings yet" onboarding hint to a "nothing matched your filters"
   *  message plus a Clear filters action. Mirrors the iOS EventsGridView
   *  `store.hasActiveFilter` branch. */
  filtered?: boolean;
  /** Resets every filter (cameras + dates/times) and reloads. Only rendered as
   *  the Clear filters button in `filtered` mode; a no-op variant without it
   *  still shows the filtered copy. */
  onClearFilters?: () => void;
}

export function EmptyRecordings({ filtered = false, onClearFilters }: Props) {
  const { t } = useTranslation();

  if (filtered) {
    return (
      <div className="empty-recordings" data-testid="empty-recordings">
        <div className="empty-recordings-card">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          <h2 className="empty-recordings-title">{t('events.emptyFiltered.title')}</h2>
          <p className="empty-recordings-body">{t('events.emptyFiltered.body')}</p>
          {onClearFilters && (
            <button className="btn btn-sm empty-recordings-clear" data-testid="clear-filters" onClick={onClearFilters}>
              {t('events.clearFilters')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="empty-recordings" data-testid="empty-recordings">
      <div className="empty-recordings-card">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <h2 className="empty-recordings-title">{t('events.emptyFirstTime.title')}</h2>
        <p className="empty-recordings-body">{t('events.emptyFirstTime.body')}</p>
        <CameraConnectionDetails />
      </div>
    </div>
  );
}
