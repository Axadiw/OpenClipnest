import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTranslation } from '../i18n';
import type { Notification, NotificationKind } from '../types';

const POLL_INTERVAL_MS = 60_000;
const KIND_ICON: Record<NotificationKind, string> = {
  storage_quota_exceeded: '💾',
  transfer_quota_exceeded: '📡',
  invalid_file: '⚠️',
  thumbnail_failed: '🖼️',
  user_banned: '🚫',
  auto_deleted_oldest: '🧹',
  duplicate_file: '🗂️',
  plan_change_cancelled: '↩️',
  content_deletion_scheduled: '⏳',
  content_deleted: '🗑️',
};

interface NotificationGroup {
  kind: NotificationKind;
  items: Notification[];
  latestAt: string;
  unreadCount: number;
}

function groupByKind(items: Notification[]): NotificationGroup[] {
  const byKind = new Map<NotificationKind, Notification[]>();
  for (const n of items) {
    const arr = byKind.get(n.kind) ?? [];
    arr.push(n);
    byKind.set(n.kind, arr);
  }
  const groups: NotificationGroup[] = [];
  for (const [kind, kindItems] of byKind) {
    kindItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    groups.push({
      kind,
      items: kindItems,
      latestAt: kindItems[0].createdAt,
      unreadCount: kindItems.filter(n => !n.readAt).length,
    });
  }
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return groups;
}

export function NotificationsBell() {
  const { t, language } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<NotificationKind>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(() => {
    api.getUnreadNotificationCount()
      .then(r => setCount(r.count))
      .catch(() => { /* silent */ });
  }, []);

  const loadList = useCallback(() => {
    setLoading(true);
    api.listNotifications({ limit: 50 })
      .then(r => setItems(r.notifications))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshCount();
    const id = window.setInterval(refreshCount, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    loadList();
    setExpandedKinds(new Set());
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, loadList]);

  const markOne = async (id: string) => {
    try {
      await api.markNotificationRead(id);
      setItems(prev => prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
      refreshCount();
    } catch { /* ignore */ }
  };

  const markAll = async () => {
    try {
      await api.markAllNotificationsRead();
      const now = new Date().toISOString();
      setItems(prev => prev.map(n => n.readAt ? n : { ...n, readAt: now }));
      setCount(0);
    } catch { /* ignore */ }
  };

  const deleteOne = async (id: string, wasUnread: boolean) => {
    try {
      await api.deleteNotification(id);
      setItems(prev => prev.filter(n => n.id !== id));
      if (wasUnread) refreshCount();
    } catch { /* ignore */ }
  };

  const deleteAllRead = async () => {
    try {
      await api.deleteReadNotifications();
      setItems(prev => prev.filter(n => !n.readAt));
    } catch { /* ignore */ }
  };

  const toggleGroup = (kind: NotificationKind) => {
    setExpandedKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const deleteGroup = async (group: NotificationGroup) => {
    const confirmed = window.confirm(t('notifications.confirmDeleteGroup', { count: group.items.length }));
    if (!confirmed) return;
    const ids = group.items.map(n => n.id);
    const hadUnread = group.unreadCount > 0;
    setItems(prev => prev.filter(n => n.kind !== group.kind));
    try {
      await Promise.all(ids.map(id => api.deleteNotification(id).catch(() => null)));
    } finally {
      if (hadUnread) refreshCount();
    }
  };

  // Notifications that reference a concrete event (thumbnail_failed,
  // invalid_file, auto_deleted_oldest) carry its id in `details.eventId`.
  // Clicking the row routes to the existing player deep-link so the user
  // can jump straight to the affected recording.
  const eventIdFromDetails = (n: Notification): string | null => {
    const raw = (n.details as { eventId?: unknown } | null)?.eventId;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const getFilenameFromDetails = (n: Notification): string | null => {
    const raw = (n.details as { filename?: unknown } | null)?.filename;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const getDisplayMessage = (n: Notification): React.ReactNode => {
    // Stored in English for push and older clients; shown here in the
    // interface language from the plan name.
    if (n.kind === 'plan_change_cancelled') {
      const plan = (n.details as { plan?: unknown } | null)?.plan;
      return typeof plan === 'string' && plan ? t('notifications.planChangeCancelled', { plan }) : n.message;
    }
    if (n.kind === 'content_deletion_scheduled') {
      const d = n.details as { at?: unknown; final?: unknown } | null;
      if (typeof d?.at !== 'string') return n.message;
      // The deletion happens on a UTC day: name it in the interface language, as a UTC date.
      const at = new Date(d.at);
      if (Number.isNaN(at.getTime())) return n.message;
      let date: string;
      try {
        date = at.toLocaleDateString(language, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
      } catch {
        return n.message;
      }
      return t(d.final === true ? 'notifications.contentDeletionTomorrow' : 'notifications.contentDeletionScheduled', { date });
    }
    if (n.kind === 'content_deleted') return t('notifications.contentDeleted');
    if (n.kind !== 'invalid_file') return n.message;
    const filename = getFilenameFromDetails(n);
    if (!filename) return n.message;
    return `${n.message.replace(/\.$/, '')} (${filename}).`;
  };

  const openEvent = async (n: Notification) => {
    const eventId = eventIdFromDetails(n);
    if (!eventId) return;
    if (!n.readAt) {
      await markOne(n.id);
    }
    setOpen(false);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('event', eventId);
      next.set('view', 'wide');
      return next;
    }, { preventScrollReset: true });
  };

  const groups = useMemo(() => groupByKind(items), [items]);

  const renderItem = (n: Notification, opts: { inGroup: boolean }) => {
    const linkedEvent = eventIdFromDetails(n);
    return (
      <div
        key={n.id}
        className={`notification-item${n.readAt ? ' notification-read' : ''}${linkedEvent ? ' notification-linked' : ''}${opts.inGroup ? ' notification-item-grouped' : ''}`}
        onClick={() => !n.readAt && markOne(n.id)}
      >
        <span className="notification-icon">{KIND_ICON[n.kind] ?? '🔔'}</span>
        <div className="notification-body">
          <div className="notification-message">{getDisplayMessage(n)}</div>
          <div className="notification-time">{new Date(n.createdAt).toLocaleString()}</div>
          {linkedEvent && (
            <button
              className="btn btn-sm notification-open"
              onClick={(e) => { e.stopPropagation(); openEvent(n); }}
            >
              {t('notifications.openEvent')}
            </button>
          )}
        </div>
        <button
          className="btn btn-sm notification-delete"
          aria-label={t('notifications.delete')}
          title={t('notifications.delete')}
          onClick={(e) => { e.stopPropagation(); deleteOne(n.id, !n.readAt); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div className="notifications-wrapper" ref={wrapperRef}>
      <button
        className="btn btn-sm notifications-bell"
        onClick={() => setOpen(!open)}
        aria-label={t('notifications.title')}
        title={t('notifications.title')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        {count > 0 && <span className="notifications-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="dropdown-menu notifications-dropdown">
          <div className="notifications-header">
            <strong>{t('notifications.title')}</strong>
            <span className="notifications-actions">
              {items.some(n => !n.readAt) && (
                <button className="btn btn-sm" onClick={markAll}>{t('notifications.markAllRead')}</button>
              )}
              {items.some(n => !!n.readAt) && (
                <button className="btn btn-sm" onClick={deleteAllRead}>{t('notifications.deleteAllRead')}</button>
              )}
            </span>
          </div>
          {loading && <div className="dropdown-info">{t('events.loading')}</div>}
          {!loading && items.length === 0 && (
            <div className="dropdown-info">{t('notifications.empty')}</div>
          )}
          {!loading && groups.map(group => {
            if (group.items.length === 1) {
              return renderItem(group.items[0], { inGroup: false });
            }
            const expanded = expandedKinds.has(group.kind);
            const kindLabel = t(`notifications.kind.${group.kind}`);
            const newestLabel = t('notifications.newestAt', {
              time: new Date(group.latestAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
            return (
              <div key={group.kind} className={`notification-group${expanded ? ' notification-group-expanded' : ''}`}>
                <div
                  className={`notification-group-header${group.unreadCount > 0 ? '' : ' notification-group-allread'}`}
                  onClick={() => toggleGroup(group.kind)}
                  role="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? t('notifications.collapseGroup') : t('notifications.expandGroup')}
                >
                  <span className="notification-icon">{KIND_ICON[group.kind] ?? '🔔'}</span>
                  <div className="notification-body">
                    <div className="notification-group-title">
                      <span className="notification-group-label">{kindLabel}</span>
                      <span className="notification-group-count">{group.items.length}</span>
                      {group.unreadCount > 0 && group.unreadCount < group.items.length && (
                        <span className="notification-group-unread" title={String(group.unreadCount)}>
                          {group.unreadCount}
                        </span>
                      )}
                    </div>
                    <div className="notification-time">{newestLabel}</div>
                  </div>
                  <span className={`notification-group-chevron${expanded ? ' notification-group-chevron-open' : ''}`} aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18"/>
                    </svg>
                  </span>
                  <button
                    className="btn btn-sm notification-delete"
                    aria-label={t('notifications.deleteAllOfKind')}
                    title={t('notifications.deleteAllOfKind')}
                    onClick={(e) => { e.stopPropagation(); deleteGroup(group); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                </div>
                {expanded && (
                  <div className="notification-group-children">
                    {group.items.map(n => renderItem(n, { inGroup: true }))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
