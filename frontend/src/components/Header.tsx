import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from '../i18n';
import { FRONTEND_VERSION } from '../api';
import { NotificationsBell } from './NotificationsBell';
import { usePwaInstall } from '../hooks/usePwaInstall';

interface Props {
  backendVersion?: string | null;
}

function formatVersion(v: string | null | undefined): string {
  if (v == null) return '…';
  return v;
}

// Warn only when both versions are known, non-local, and actually differ.
// Silent while loading (null), on fetch failure ('unknown'), or when either
// side is 'local-dev' (which wildcards the comparison during development).
function versionMismatch(fe: string, be: string | null | undefined): boolean {
  if (!be || be === 'unknown') return false;
  if (fe === 'local-dev' || be === 'local-dev') return false;
  return fe !== be;
}

export function Header({ backendVersion }: Props) {
  const { t } = useTranslation();
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { canPromptInstall, install } = usePwaInstall();

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // The logo points admins at the panel (their only home) and regular users at
  // the grid. Admins have no camera views, so sending them to /grid would just
  // get bounced by RequireNonAdmin — skip the round-trip. One derived value
  // feeds both href and navigate so they can't drift apart.
  const brandHref = isAdmin ? '/admin/overview' : '/grid';
  const handleBrandClick = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(brandHref);
  };

  return (
    <header className="app-header">
      <a className="header-brand" href={brandHref} onClick={handleBrandClick}>
        <img src="/logo.svg" alt="" className="header-logo" />
        <h1 className="header-title">{t('header.title')}</h1>
      </a>
      <div className="header-actions">
        {canPromptInstall && (
          <button
            className="btn btn-sm btn-install-pwa"
            onClick={() => { install(); }}
            title={t('pwa.installTitle')}
            data-testid="install-pwa-button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="btn-install-label">{t('pwa.installLabel')}</span>
          </button>
        )}
        {!isAdmin && <NotificationsBell />}
        <div className="menu-wrapper" ref={menuRef}>
          <button className="btn btn-sm" onClick={() => setMenuOpen(!menuOpen)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          {menuOpen && (
            <div className="dropdown-menu">
              {/* Settings — both admins and regular users get here.
                  Theme + language + passkey + change-password live inside
                  the Settings page for both. <button> (not <Link>) so the
                  existing `.dropdown-menu button` CSS + e2e selectors
                  keep working. */}
              <button onClick={() => { navigate('/settings'); setMenuOpen(false); }}>
                {t('menu.settings')}
              </button>
              {/* Admins additionally see the version line for ops awareness. */}
              {isAdmin && (
                <>
                  <hr />
                  <div className="dropdown-info dropdown-version" style={{ fontSize: '0.85em', opacity: 0.75 }}>
                    <div>{t('menu.versionFrontend')}: {formatVersion(FRONTEND_VERSION)}</div>
                    <div>{t('menu.versionBackend')}: {formatVersion(backendVersion)}</div>
                    {versionMismatch(FRONTEND_VERSION, backendVersion) && (
                      <div className="usage-warning" style={{ marginTop: 4 }}>
                        {t('menu.versionMismatch')}
                      </div>
                    )}
                  </div>
                  <hr />
                </>
              )}
              <button onClick={() => { logout(); setMenuOpen(false); navigate('/login'); }}>
                {t('menu.logout')} ({user?.email})
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
