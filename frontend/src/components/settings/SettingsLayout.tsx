/**
 * User-facing Settings page (route layout).
 *
 * Sidebar with NavLink-driven tabs at /settings/general, /settings/cameras,
 * /settings/storage, /settings/profile. Admins only see general + profile —
 * the other two are filtered out of the sidebar. The profile tab exists only
 * when the edition has one.
 */
import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useAuth } from '../../context/AuthContext';
import { edition } from '../../edition';

type Tab = 'general' | 'cameras' | 'storage' | 'profile' | 'mcp-clients';

interface NavItem {
  id: Tab;
  labelKey: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'general',
    labelKey: 'settings.tabGeneral',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="18" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'cameras',
    labelKey: 'settings.tabCameras',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" />
      </svg>
    ),
  },
  {
    id: 'storage',
    labelKey: 'settings.tabStorage',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6" />
      </svg>
    ),
  },
  {
    id: 'profile',
    labelKey: 'settings.tabProfile',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: 'mcp-clients',
    labelKey: 'settings.tabMcpClients',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
];

export function SettingsLayout() {
  const { t } = useTranslation();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const visibleNavItems = (isAdmin
    ? NAV_ITEMS.filter(item => item.id === 'general' || item.id === 'profile')
    : NAV_ITEMS
  ).filter(item => item.id !== 'profile' || edition.ProfileTab !== null);

  const goBack = () => {
    if (isAdmin) navigate('/admin/overview');
    else {
      const stored = (() => { try { return localStorage.getItem('viewMode'); } catch { return null; } })();
      navigate(stored === 'timeline' ? '/timeline' : '/grid');
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="btn btn-sm settings-back-btn" onClick={goBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
          <span>{t('settings.back')}</span>
        </button>
        <h2>{t('settings.title')}</h2>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {visibleNavItems.map(item => (
            <NavLink
              key={item.id}
              to={item.id}
              className={({ isActive }) => `settings-nav-item${isActive ? ' active' : ''}`}
              aria-current={undefined}
            >
              <span className="settings-nav-icon">{item.icon}</span>
              <span className="settings-nav-label">{t(item.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="settings-body">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
