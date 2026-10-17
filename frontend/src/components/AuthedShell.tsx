import { useState, useEffect, useMemo, useRef, createContext, useContext, useCallback } from 'react';
import { Outlet, useSearchParams, useLocation } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useTranslation } from '../i18n';
import { Header } from './Header';
import { BulkDeleteDialog } from './BulkDeleteDialog';
import { VideoPlayer } from './VideoPlayer';
import { Toast, type ToastTone } from './Toast';
import { RateLimitToast } from './RateLimitToast';
import { edition } from '../edition';
import { resolveView } from '../utils/format';
import type { CameraEvent, ViewId } from '../types';

interface BulkDelete { ids: string[]; label: string }

// `bulkDeleteOnDone` is a CALLBACK SLOT that child routes (GridView)
// register into so the shared shell (BulkDeleteDialog) can notify them
// when a side-effect lands. The original implementation backed it with
// `useState`, but the setter was called in a `useEffect` whose deps
// included a freshly-allocated `recordings` object on every parent
// render — that turned every shell registration into a parent re-
// render which re-fired the effect which re-registered: a tight
// infinite render loop that pinned the React Scheduler at ~100% CPU
// even on `/grid` with zero events (2026-05-16 Firefox profile).
//
// Refs are the right primitive: writing to one doesn't schedule a
// render, so the registration effect can fire as often as it likes
// without feeding back into the parent.
interface ShellContextValue {
  setBulkDelete: (b: BulkDelete | null) => void;
  setPlayerEvents: (e: CameraEvent[]) => void;
  openPlayer: (event: CameraEvent, view: ViewId, eventsList?: CameraEvent[]) => void;
  closePlayer: () => void;
  bulkDeleteOnDone: () => void;
  setBulkDeleteOnDone: (fn: () => () => void) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside AuthedShell');
  return ctx;
}

export function AuthedShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const [playerEvent, setPlayerEvent] = useState<CameraEvent | null>(null);
  const [playerView, setPlayerView] = useState<ViewId>('00');
  const [playerEvents, setPlayerEvents] = useState<CameraEvent[]>([]);
  const [bulkDelete, setBulkDelete] = useState<BulkDelete | null>(null);
  const bulkDeleteOnDoneRef = useRef<() => void>(() => {});

  // Stable wrappers — registered consumers (GridView) call these via
  // the context. Wrappers themselves never change identity, so passing
  // them as deps to a downstream `useEffect` no longer feeds the
  // infinite-render-loop that the useState-backed setters did.
  const bulkDeleteOnDone = useCallback(() => bulkDeleteOnDoneRef.current(), []);
  const setBulkDeleteOnDone = useCallback((fn: () => () => void) => { bulkDeleteOnDoneRef.current = fn(); }, []);
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone } | null>(null);

  // Backend version for the admin menu.
  useEffect(() => {
    api.getVersion()
      .then(({ version }) => {
        setBackendVersion(version);
        console.info(`[Clipnest] Backend version: ${version}`);
      })
      .catch(() => setBackendVersion('unknown'));
  }, []);

  // Player state driven by `?event=&view=` — single source of truth.
  // Both initial deep-link load AND subsequent navigation (back/forward,
  // notification click, click on event in grid) flow through here.
  const eventParam = searchParams.get('event');
  const viewParam = searchParams.get('view');
  useEffect(() => {
    // On /timeline the inline player owns ?event=&view=, so skip the modal
    // player path. Without this gate, clicking a bar in timeline would write
    // event/view to URL → this effect would mount the modal over the inline
    // player. Cleared explicitly so a /grid → /timeline navigation that
    // preserves event/view in the URL doesn't leave a stale modal behind.
    if (location.pathname === '/timeline') {
      setPlayerEvent(null);
      return;
    }
    if (!eventParam || !viewParam || viewParam.length > 16) {
      setPlayerEvent(null);
      return;
    }
    let cancelled = false;
    api.getEvent(eventParam).then(({ event }) => {
      if (cancelled) return;
      const resolved = resolveView(viewParam, event);
      if (!resolved) { setPlayerEvent(null); return; }
      setPlayerEvent(event);
      setPlayerView(resolved);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setPlayerEvent(null);
      // Only a confirmed 404 means the recording is gone; 5xx / network / abort
      // is a transient failure — don't tell the user "this was deleted" then.
      // For 404 we also clear the URL so back/refresh doesn't re-trigger the
      // dead deeplink; for transient errors we keep ?event= so the user can
      // retry by refreshing.
      const isGone = err instanceof ApiError && err.status === 404;
      if (isGone) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.delete('event');
          next.delete('view');
          return next;
        }, { replace: true, preventScrollReset: true });
      }
      setToast({
        msg: t(isGone ? 'events.notFoundOrDeleted' : 'events.couldNotLoad'),
        tone: isGone ? 'warn' : 'error',
      });
    });
    return () => { cancelled = true; };
  }, [eventParam, viewParam, location.pathname, setSearchParams, t]);

  const openPlayer = useCallback((event: CameraEvent, view: ViewId, eventsList?: CameraEvent[]) => {
    if (eventsList) setPlayerEvents(eventsList);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('event', event.id);
      next.set('view', view);
      return next;
    }, { preventScrollReset: true });
  }, [setSearchParams]);

  const closePlayer = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('event');
      next.delete('view');
      return next;
    }, { preventScrollReset: true });
  }, [setSearchParams]);

  const isTimeline = location.pathname === '/timeline';

  // Without this memo a fresh `value={{...}}` literal would land on every
  // AuthedShell render, propagating a "new context value" to every
  // `useShell()` consumer and forcing them to re-render — exactly the
  // anti-pattern that the React docs warn about and that the 2026-05-16
  // profile caught. All fields here are stable refs/callbacks.
  const shellValue = useMemo<ShellContextValue>(() => ({
    setBulkDelete,
    setPlayerEvents,
    openPlayer,
    closePlayer,
    bulkDeleteOnDone,
    setBulkDeleteOnDone,
  }), [openPlayer, closePlayer, bulkDeleteOnDone, setBulkDeleteOnDone]);

  return (
    <ShellContext.Provider value={shellValue}>
      <div className={`app${isTimeline ? ' app-timeline' : ''}`}>
        <Header backendVersion={backendVersion} />
        <Outlet />
        {playerEvent && (
          <VideoPlayer
            event={playerEvent}
            view={playerView}
            events={playerEvents}
            onClose={closePlayer}
            onNavigate={(ev, view) => openPlayer(ev, view, playerEvents)}
          />
        )}
        {edition.ShellExtras && <edition.ShellExtras />}
        {bulkDelete && (
          <BulkDeleteDialog
            eventIds={bulkDelete.ids}
            label={bulkDelete.label}
            onClose={() => setBulkDelete(null)}
            onDone={async () => {
              await bulkDeleteOnDone();
              setBulkDelete(null);
            }}
          />
        )}
        {toast && (
          <Toast
            message={toast.msg}
            tone={toast.tone}
            onClose={() => setToast(null)}
          />
        )}
        <RateLimitToast />
      </div>
      {edition.Footer && <edition.Footer />}
    </ShellContext.Provider>
  );
}
