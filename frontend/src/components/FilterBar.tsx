import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import { paletteForCameras } from '../lib/cameraColors';
import { TimelineDatePicker } from './TimelineDatePicker';
import { CameraChecklist } from './CameraChecklist';

type TimeMode = 'daily' | 'range';
/** Every Filters field that the heat-map calendar can write into. Daily
 *  mode writes a YYYY-MM-DD string into dateFrom/dateTo and auto-fills
 *  the paired timeFrom/timeTo; range mode writes a datetime-local string
 *  into rangeFrom/rangeTo with the time half merged in. */
type DatePickerField = 'dateFrom' | 'dateTo' | 'rangeFrom' | 'rangeTo';

/** Split a datetime-local string ("YYYY-MM-DDTHH:MM") into its date and
 *  time halves. Empty input yields empty halves so the UI can render
 *  placeholders instead of "1970-01-01". */
function getDatePart(dt: string): string {
  if (!dt) return '';
  const i = dt.indexOf('T');
  return i < 0 ? dt : dt.slice(0, i);
}

function getTimePart(dt: string): string {
  if (!dt) return '';
  const i = dt.indexOf('T');
  return i < 0 ? '' : dt.slice(i + 1);
}

/** Format a Date as YYYY-MM-DD in the local timezone — matches the format
 *  the backend filter expects on the URL and the way TimelineDatePicker
 *  emits dates back to us. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse a datetime-local string into a Date so we can seed the
 *  calendar's "selected" highlight. Falls back to today when nothing
 *  has been picked yet. */
function parseAnchorDate(dt: string): Date {
  const date = getDatePart(dt);
  if (!date) return new Date();
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export interface Filters {
  selectedCameras: string[];
  mode: TimeMode;
  dateFrom: string;
  dateTo: string;
  timeFrom: string;
  timeTo: string;
  rangeFrom: string;
  rangeTo: string;
}

/** Draft camera selection is tri-state so the checklist can tell "all"
 *  apart from "none" — which the include-list `Filters.selectedCameras`
 *  (where `[]` means all) cannot. `null` = all shown (no filter), `[]` =
 *  none checked, `[a,b]` = an explicit partial subset. Seeded from props
 *  only (never from the camera list) so the grid's 60s camera refresh
 *  can't reset an in-progress edit. */
type DraftFilters = Omit<Filters, 'selectedCameras'> & { shown: string[] | null };

interface Props extends Filters {
  cameras: string[];
  onApply: (filters: Filters) => void;
  onClear: () => void;
}

function extractFilters(p: {
  selectedCameras: string[]; mode: TimeMode;
  dateFrom: string; dateTo: string; timeFrom: string; timeTo: string;
  rangeFrom: string; rangeTo: string;
}): Filters {
  return {
    selectedCameras: p.selectedCameras,
    mode: p.mode,
    dateFrom: p.dateFrom, dateTo: p.dateTo,
    timeFrom: p.timeFrom, timeTo: p.timeTo,
    rangeFrom: p.rangeFrom, rangeTo: p.rangeTo,
  };
}

function extractDraft(p: Filters): DraftFilters {
  return {
    shown: p.selectedCameras.length ? p.selectedCameras : null,
    mode: p.mode,
    dateFrom: p.dateFrom, dateTo: p.dateTo,
    timeFrom: p.timeFrom, timeTo: p.timeTo,
    rangeFrom: p.rangeFrom, rangeTo: p.rangeTo,
  };
}

// Normalize the tri-state to the include list the API expects: both "all"
// (null) and "none" ([]) emit [] (backend treats empty as all — the grid
// can't show zero cameras); a partial subset emits itself.
function draftToFilters(d: DraftFilters): Filters {
  return {
    selectedCameras: d.shown ?? [],
    mode: d.mode,
    dateFrom: d.dateFrom, dateTo: d.dateTo,
    timeFrom: d.timeFrom, timeTo: d.timeTo,
    rangeFrom: d.rangeFrom, rangeTo: d.rangeTo,
  };
}

function shallowFiltersEqual(a: Filters, b: Filters): boolean {
  return a.mode === b.mode
    && a.dateFrom === b.dateFrom && a.dateTo === b.dateTo
    && a.timeFrom === b.timeFrom && a.timeTo === b.timeTo
    && a.rangeFrom === b.rangeFrom && a.rangeTo === b.rangeTo
    && a.selectedCameras.length === b.selectedCameras.length
    && a.selectedCameras.every((c, i) => c === b.selectedCameras[i]);
}

export function FilterBar(props: Props) {
  const { cameras, onApply, onClear } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftFilters>(() => extractDraft(props));
  // Which calendar popover (any of the four date fields) is currently
  // open. Only one calendar can be open at a time so they don't overlap.
  const [datePicker, setDatePicker] = useState<DatePickerField | null>(null);
  // Same shared palette the timeline uses, hashed over the same full camera
  // list (both the grid filter and the timeline are fed `recordings.cameras`),
  // so a camera reads as the same hue in both places.
  const cameraColorMap = useMemo(() => paletteForCameras(cameras), [cameras]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // Refs to each calendar trigger button + the portal wrapper that hosts
  // the open calendar. The calendar can NOT live inside the filter panel
  // (which has overflow:auto) without being clipped — so we portal it to
  // body and position it via getBoundingClientRect.
  const dateTriggerRefs = useRef<Record<DatePickerField, HTMLButtonElement | null>>({
    dateFrom: null, dateTo: null, rangeFrom: null, rangeTo: null,
  });
  const calendarPortalRef = useRef<HTMLDivElement>(null);
  const [datePickerPos, setDatePickerPos] = useState<{ top: number; left: number } | null>(null);

  // Re-sync draft when props change (external URL navigation)
  useEffect(() => {
    setDraft(extractDraft(props));
  }, [
    props.selectedCameras, props.mode,
    props.dateFrom, props.dateTo, props.timeFrom, props.timeTo,
    props.rangeFrom, props.rangeTo,
  ]);  

  // When panel closes, discard the draft by re-syncing from props
  useEffect(() => {
    if (!open) {
      setDraft(extractDraft(props));
      setDatePicker(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The four fields live in two different modes. Drop a stale picker when
  // the user flips modes so the calendar doesn't survive an invisible
  // re-anchor (e.g. dateFrom-picker still open after switching to range).
  useEffect(() => {
    if (!datePicker) return;
    const isDaily = datePicker === 'dateFrom' || datePicker === 'dateTo';
    if ((isDaily && draft.mode !== 'daily') || (!isDaily && draft.mode !== 'range')) {
      setDatePicker(null);
    }
  }, [draft.mode, datePicker]);

  // Anchor the portal-rendered calendar to the trigger button. The popover
  // itself adds the 6 px gap via its own `top: calc(100% + 6px)` rule, so
  // we only pin the wrapper's top-left to the trigger's bottom-left.
  // Recompute on scroll/resize so the calendar follows the trigger when
  // the user moves the page underneath it.
  useLayoutEffect(() => {
    if (!datePicker) { setDatePickerPos(null); return; }
    const recompute = () => {
      const btn = dateTriggerRefs.current[datePicker];
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setDatePickerPos({ top: rect.bottom, left: rect.left });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [datePicker]);

  const dirty = !shallowFiltersEqual(draftToFilters(draft), extractFilters(props));

  const dailyActive = draft.mode === 'daily'
    ? (draft.dateFrom ? 1 : 0) + (draft.dateTo ? 1 : 0) + (draft.timeFrom ? 1 : 0) + (draft.timeTo ? 1 : 0)
    : 0;
  const rangeActive = draft.mode === 'range'
    ? (draft.rangeFrom ? 1 : 0) + (draft.rangeTo ? 1 : 0)
    : 0;
  const cameraCount = draft.shown === null ? 0 : draft.shown.length;
  const activeCount = cameraCount + dailyActive + rangeActive;

  // Both bounds set + timeFrom > timeTo: the user is asking for an over-midnight
  // window (e.g. 22:00 → 02:00). Server interprets this as wrap-around; surface
  // a hint so the UI explains it instead of looking like a typo.
  const wrapAround = draft.mode === 'daily' && draft.timeFrom && draft.timeTo && draft.timeFrom > draft.timeTo;

  // Folds a calendar-picked date into the right Filters field.
  //  - rangeFrom/rangeTo:  merge into datetime-local; preserve a typed time
  //                        or fall back to 00:00 (from) / 23:59 (to).
  //  - dateFrom/dateTo:    write the date directly; auto-fill the paired
  //                        timeFrom/timeTo only when empty (same boundary
  //                        defaults so the two modes feel symmetric).
  // The auto-fill never clobbers a non-empty time — the user's typed value
  // wins on subsequent date changes.
  const handleDatePick = (field: DatePickerField, d: Date) => {
    const ymdStr = ymd(d);
    if (field === 'rangeFrom' || field === 'rangeTo') {
      setDraft(prev => {
        const currentTime = getTimePart(prev[field]);
        const defaultTime = field === 'rangeFrom' ? '00:00' : '23:59';
        const nextTime = currentTime || defaultTime;
        return { ...prev, [field]: `${ymdStr}T${nextTime}` };
      });
    } else {
      const timeField = field === 'dateFrom' ? 'timeFrom' : 'timeTo';
      const defaultTime = field === 'dateFrom' ? '00:00' : '23:59';
      setDraft(prev => ({
        ...prev,
        [field]: ymdStr,
        [timeField]: prev[timeField] || defaultTime,
      }));
    }
    setDatePicker(null);
  };

  // Time-input change for range mode only takes effect once a date has
  // been picked — the input is disabled in that state, so this guard is
  // defensive. Without a date, "T08:00" isn't a valid datetime-local for
  // the API.
  const handleRangeTimeChange = (field: 'rangeFrom' | 'rangeTo', time: string) => {
    setDraft(prev => {
      const currentDate = getDatePart(prev[field]);
      if (!currentDate) return prev;
      return { ...prev, [field]: `${currentDate}T${time}` };
    });
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      // The portal-rendered calendar lives outside panelRef but is still
      // logically part of the filter UI — clicking inside it must NOT
      // close the panel.
      if (calendarPortalRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Track the trigger position so the portal-rendered panel stays anchored
  // when the user scrolls or resizes. The mobile breakpoint pins the panel
  // to viewport edges via CSS, so left is irrelevant there.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelPos({ top: rect.bottom + 4, left: rect.left });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [open]);

  return (
    <div className="filter-wrapper" ref={wrapperRef}>
      <button ref={triggerRef} className="btn btn-sm btn-filter" onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        {t('filter.title')}
        {activeCount > 0 && <span className="badge">{activeCount}</span>}
      </button>
      {open && createPortal(
        <div ref={panelRef} className="filter-panel" style={{ top: panelPos.top, left: panelPos.left }}>
          <div className="filter-group filter-group--cameras">
            <label>{t('filter.cameras')}</label>
            <CameraChecklist
              cameras={cameras}
              isChecked={(c) => draft.shown === null || draft.shown.includes(c)}
              onToggle={(c) => setDraft(d => {
                const cur = d.shown === null ? cameras : d.shown;
                const next = cur.includes(c) ? cur.filter(x => x !== c) : [...cur, c];
                // Collapse "all checked" back to the canonical null so the
                // badge/apply read it as "no filter".
                return { ...d, shown: next.length === cameras.length ? null : next };
              })}
              onSelectAll={() => setDraft(d => ({ ...d, shown: null }))}
              onSelectNone={() => setDraft(d => ({ ...d, shown: [] }))}
              colorMap={cameraColorMap}
              testIdPrefix="filter-camfilter"
            />
          </div>
          <div className="filter-group">
            <div className="filter-mode-toggle" role="tablist" aria-label={t('filter.modeLabel')}>
              <button
                type="button"
                role="tab"
                aria-selected={draft.mode === 'daily'}
                className={`chip ${draft.mode === 'daily' ? 'active' : ''}`}
                onClick={() => setDraft(d => ({ ...d, mode: 'daily' }))}
              >
                {t('filter.modeDaily')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={draft.mode === 'range'}
                className={`chip ${draft.mode === 'range' ? 'active' : ''}`}
                onClick={() => setDraft(d => ({ ...d, mode: 'range' }))}
              >
                {t('filter.modeRange')}
              </button>
            </div>
          </div>
          {draft.mode === 'daily' ? (
            <>
              <div className="filter-row">
                {(['dateFrom', 'dateTo'] as const).map(field => {
                  const labelKey = field === 'dateFrom' ? 'filter.dateFrom' : 'filter.dateTo';
                  const dateValue = draft[field];
                  return (
                    <div className="filter-group" key={field}>
                      <label>{t(labelKey)}</label>
                      <button
                        type="button"
                        ref={el => { dateTriggerRefs.current[field] = el; }}
                        className="btn btn-sm filter-date-trigger"
                        onClick={() => setDatePicker(p => p === field ? null : field)}
                        title={t('timeline.pickDate')}
                        aria-label={t(labelKey)}
                        aria-expanded={datePicker === field}
                        data-testid={`filter-date-trigger-${field}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                        </svg>
                        <span>{dateValue || t('timeline.pickDate')}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="filter-row">
                <div className="filter-group">
                  <label>{t('filter.timeFrom')}</label>
                  <input
                    type="time"
                    value={draft.timeFrom}
                    onChange={e => setDraft(d => ({ ...d, timeFrom: e.target.value }))}
                    aria-label={t('filter.timeFrom')}
                  />
                </div>
                <div className="filter-group">
                  <label>{t('filter.timeTo')}</label>
                  <input
                    type="time"
                    value={draft.timeTo}
                    onChange={e => setDraft(d => ({ ...d, timeTo: e.target.value }))}
                    aria-label={t('filter.timeTo')}
                  />
                </div>
              </div>
              {wrapAround && (
                <div className="filter-hint">
                  {t('filter.timeWrapHint', { from: draft.timeFrom, to: draft.timeTo })}
                </div>
              )}
            </>
          ) : (
            <>
              {(['rangeFrom', 'rangeTo'] as const).map(field => {
                const labelKey = field === 'rangeFrom' ? 'filter.rangeFrom' : 'filter.rangeTo';
                const dateValue = getDatePart(draft[field]);
                const timeValue = getTimePart(draft[field]);
                return (
                  <div className="filter-row" key={field}>
                    <div className="filter-group">
                      <label>{t(labelKey)}</label>
                      <button
                        type="button"
                        ref={el => { dateTriggerRefs.current[field] = el; }}
                        className="btn btn-sm filter-date-trigger"
                        onClick={() => setDatePicker(p => p === field ? null : field)}
                        title={t('timeline.pickDate')}
                        aria-label={t(labelKey)}
                        aria-expanded={datePicker === field}
                        data-testid={`filter-date-trigger-${field}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                        </svg>
                        <span>{dateValue || t('timeline.pickDate')}</span>
                      </button>
                      <input
                        type="time"
                        value={timeValue}
                        onChange={e => handleRangeTimeChange(field, e.target.value)}
                        aria-label={`${t(labelKey)} ${field === 'rangeFrom' ? t('filter.timeFrom') : t('filter.timeTo')}`}
                        disabled={!dateValue}
                      />
                    </div>
                  </div>
                );
              })}
            </>
          )}
          <div className="filter-row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onApply(draftToFilters(draft))}
              disabled={!dirty}
            >
              {t('filter.apply')}
            </button>
            {activeCount > 0 && (
              <button className="btn btn-sm" onClick={onClear}>{t('filter.clear')}</button>
            )}
          </div>
        </div>,
        document.body,
      )}
      {open && datePicker && datePickerPos && createPortal(
        <div
          ref={calendarPortalRef}
          style={{
            position: 'fixed',
            top: datePickerPos.top,
            left: datePickerPos.left,
            zIndex: 60,
          }}
        >
          <TimelineDatePicker
            selectedDate={parseAnchorDate(draft[datePicker])}
            onSelect={d => handleDatePick(datePicker, d)}
            onClose={() => setDatePicker(null)}
            placement="below"
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
