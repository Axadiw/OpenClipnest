import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTranslation } from '../i18n';
import { paletteForCameras } from '../lib/cameraColors';
import { useSettings } from '../context/SettingsContext';
import { useRecordings } from '../hooks/useRecordings';
import { useShell } from './AuthedShell';
import { FilterBar } from './FilterBar';
import { EventList } from './EventList';
import { ProcessingStatusIndicator } from './ProcessingStatusIndicator';
import type { CameraEvent } from '../types';

export function GridView() {
  const { t } = useTranslation();
  const { settings, setThumbSize } = useSettings();
  const recordings = useRecordings();
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Same shared palette the timeline + Filters picker use, hashed over the
  // full camera list (`recordings.cameras`), so a camera's badge reads as the
  // identical hue in the grid, the filter, and the timeline.
  const cameraColorMap = useMemo(() => paletteForCameras(recordings.cameras), [recordings.cameras]);

  const [editMode, setEditMode] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [selectedEventsByDay, setSelectedEventsByDay] = useState<Map<string, CameraEvent[]>>(new Map());

  // Initial load + auto-refresh.
  useEffect(() => {
    recordings.loadCameras();
    recordings.loadEvents();
    const id = setInterval(() => {
      recordings.loadCameras();
      recordings.loadEvents(undefined, undefined, undefined, false);
    }, 60_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Snap edit mode + selection back to OFF on filter change.
  const filtersKey = JSON.stringify(recordings.filters);
  useEffect(() => {
    setEditMode(false);
    setSelectedDays(new Set());
    setSelectedEventsByDay(new Map());
  }, [filtersKey]);
  useEffect(() => {
    if (!editMode) {
      setSelectedDays(new Set());
      setSelectedEventsByDay(new Map());
    }
  }, [editMode]);

  useEffect(() => {
    shell.setBulkDeleteOnDone(() => async () => {
      setSelectedDays(new Set());
      setSelectedEventsByDay(new Map());
      await recordings.loadEvents(undefined, undefined, undefined, false);
    });
  }, [recordings, shell]);

  const handleToggleDaySelected = useCallback((dayKey: string, dayEvents: CameraEvent[]) => {
    setSelectedDays(prev => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
    setSelectedEventsByDay(prev => {
      const next = new Map(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.set(dayKey, dayEvents);
      return next;
    });
  }, []);

  const handleDeleteSelectedDays = useCallback(() => {
    if (selectedEventsByDay.size === 0) return;
    const ids: string[] = [];
    for (const evs of selectedEventsByDay.values()) {
      for (const ev of evs) ids.push(ev.id);
    }
    const dayLabel = `${selectedEventsByDay.size} ${t('events.daysWord')}`;
    shell.setBulkDelete({ ids, label: dayLabel });
  }, [selectedEventsByDay, shell, t]);

  const handleDeleteEvent = useCallback(async (event: CameraEvent) => {
    if (!window.confirm(t('events.confirmDelete'))) return;
    try {
      await api.deleteEvent(event.id);
      await recordings.loadEvents(undefined, undefined, undefined, false);
    } catch (err) {
      window.alert((err as Error).message || t('events.deleteFailed'));
    }
  }, [recordings, t]);

  const handleDeleteDay = useCallback((dayEvents: CameraEvent[]) => {
    if (dayEvents.length === 0) return;
    const label = new Date(dayEvents[0].timestamp).toLocaleDateString();
    shell.setBulkDelete({ ids: dayEvents.map(e => e.id), label });
  }, [shell]);

  // Reset every filter back to the pristine default (no cameras, range mode,
  // no dates/times). Shared by the FilterBar's Clear control AND the grid's
  // filtered empty-state Clear filters button so both do exactly the same
  // thing. Writing the defaults re-derives `filters` from the URL and triggers
  // the events refetch in useRecordings — no separate reload needed.
  const handleClearFilters = useCallback(() => {
    recordings.updateFilters({
      cameras: [], mode: 'range',
      dateFrom: '', dateTo: '', timeFrom: '', timeTo: '',
      rangeFrom: '', rangeTo: '',
    });
  }, [recordings]);

  const goTimeline = () => {
    try { localStorage.setItem('viewMode', 'timeline'); } catch { /* ignore */ }
    // Drop the modal-player params (`event`/`view`) so view-toggle doesn't
    // also carry "the video I had open" into the timeline's inline player.
    // Mirrors TimelineRoute.goGrid in the opposite direction — keep the
    // toggle a clean view switch.
    const next = new URLSearchParams(searchParams);
    next.delete('event');
    next.delete('view');
    const qs = next.toString();
    navigate(`/timeline${qs ? '?' + qs : ''}`);
  };

  return (
    <>
      <ProcessingStatusIndicator />
      <div className="toolbar">
        <FilterBar
          cameras={recordings.cameras}
          selectedCameras={recordings.filters.cameras}
          mode={recordings.filters.mode}
          dateFrom={recordings.filters.dateFrom}
          dateTo={recordings.filters.dateTo}
          timeFrom={recordings.filters.timeFrom}
          timeTo={recordings.filters.timeTo}
          rangeFrom={recordings.filters.rangeFrom}
          rangeTo={recordings.filters.rangeTo}
          onApply={(f) => recordings.updateFilters({
            cameras: f.selectedCameras,
            mode: f.mode,
            dateFrom: f.dateFrom,
            dateTo: f.dateTo,
            timeFrom: f.timeFrom,
            timeTo: f.timeTo,
            rangeFrom: f.rangeFrom,
            rangeTo: f.rangeTo,
          })}
          onClear={handleClearFilters}
        />
        <span className="toolbar-count">{t('events.total', { count: String(recordings.total) })}</span>
        <div className="thumb-size-toggle">
          <button className={`btn-icon-sm${settings.thumbSize === 'S' ? ' active' : ''}`} onClick={() => setThumbSize('S')} title={t('view.grid')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="0" y="0" width="3" height="3" rx=".5"/><rect x="4.33" y="0" width="3" height="3" rx=".5"/><rect x="8.66" y="0" width="3" height="3" rx=".5"/><rect x="13" y="0" width="3" height="3" rx=".5"/><rect x="0" y="4.33" width="3" height="3" rx=".5"/><rect x="4.33" y="4.33" width="3" height="3" rx=".5"/><rect x="8.66" y="4.33" width="3" height="3" rx=".5"/><rect x="13" y="4.33" width="3" height="3" rx=".5"/><rect x="0" y="8.66" width="3" height="3" rx=".5"/><rect x="4.33" y="8.66" width="3" height="3" rx=".5"/><rect x="8.66" y="8.66" width="3" height="3" rx=".5"/><rect x="13" y="8.66" width="3" height="3" rx=".5"/><rect x="0" y="13" width="3" height="3" rx=".5"/><rect x="4.33" y="13" width="3" height="3" rx=".5"/><rect x="8.66" y="13" width="3" height="3" rx=".5"/><rect x="13" y="13" width="3" height="3" rx=".5"/></svg>
          </button>
          <button className={`btn-icon-sm${settings.thumbSize === 'M' ? ' active' : ''}`} onClick={() => setThumbSize('M')} title={t('view.grid')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="0" y="0" width="4.67" height="4.67" rx=".7"/><rect x="5.67" y="0" width="4.67" height="4.67" rx=".7"/><rect x="11.33" y="0" width="4.67" height="4.67" rx=".7"/><rect x="0" y="5.67" width="4.67" height="4.67" rx=".7"/><rect x="5.67" y="5.67" width="4.67" height="4.67" rx=".7"/><rect x="11.33" y="5.67" width="4.67" height="4.67" rx=".7"/><rect x="0" y="11.33" width="4.67" height="4.67" rx=".7"/><rect x="5.67" y="11.33" width="4.67" height="4.67" rx=".7"/><rect x="11.33" y="11.33" width="4.67" height="4.67" rx=".7"/></svg>
          </button>
          <button className={`btn-icon-sm${settings.thumbSize === 'L' ? ' active' : ''}`} onClick={() => setThumbSize('L')} title={t('view.grid')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="0" y="0" width="7.5" height="7.5" rx="1"/><rect x="8.5" y="0" width="7.5" height="7.5" rx="1"/><rect x="0" y="8.5" width="7.5" height="7.5" rx="1"/><rect x="8.5" y="8.5" width="7.5" height="7.5" rx="1"/></svg>
          </button>
        </div>
        {editMode && selectedDays.size > 0 && (
          <button
            className="btn btn-sm btn-danger btn-delete-selected"
            onClick={handleDeleteSelectedDays}
            title={t('events.deleteSelectedDays', { count: String(selectedDays.size) })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            <span>{t('events.deleteSelectedDays', { count: String(selectedDays.size) })}</span>
          </button>
        )}
        <button
          className={`btn btn-sm btn-edit-mode${editMode ? ' active' : ''}`}
          onClick={() => setEditMode(v => !v)}
          title={editMode ? t('events.editModeExit') : t('events.editModeEnter')}
        >
          {editMode ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          )}
          <span>{editMode ? t('events.editModeExit') : t('events.editModeEnter')}</span>
        </button>
        <div className="view-toggle">
          <button className="btn btn-sm active" title={t('view.grid')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </button>
          <button className="btn btn-sm" onClick={goTimeline} title={t('view.timeline')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="6" x2="22" y2="6" opacity="0.3"/><line x1="2" y1="12" x2="22" y2="12" opacity="0.3"/><line x1="2" y1="18" x2="22" y2="18" opacity="0.3"/><rect x="4" y="4" width="7" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="10" width="5" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="6" y="16" width="9" height="4" rx="1" fill="currentColor" stroke="none"/></svg>
          </button>
        </div>
      </div>
      <EventList
        events={recordings.events}
        total={recordings.total}
        loading={recordings.loading}
        loadingMore={recordings.loadingMore}
        hasMore={recordings.hasMore}
        onLoadMore={recordings.loadMore}
        onPlay={(ev, view) => shell.openPlayer(ev, view, recordings.events)}
        thumbSize={settings.thumbSize}
        onDelete={editMode ? handleDeleteEvent : undefined}
        onDeleteDay={editMode ? handleDeleteDay : undefined}
        editMode={editMode}
        selectedDays={selectedDays}
        onToggleDaySelected={editMode ? handleToggleDaySelected : undefined}
        cameraColorMap={cameraColorMap}
        hasActiveFilter={recordings.hasActiveFilter}
        onClearFilters={handleClearFilters}
      />
    </>
  );
}
