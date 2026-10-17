import { useEffect } from 'react';
import { Outlet, ScrollRestoration } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { AuthProvider } from '../context/AuthContext';
import { SettingsProvider } from '../context/SettingsContext';
import { edition } from '../edition';

function BootOverlayCleanup() {
  useEffect(() => {
    const el = document.getElementById('boot-overlay');
    if (el) el.remove();
    document.documentElement.removeAttribute('data-auth-check');
  }, []);
  return null;
}

export function RootLayout() {
  return (
    <I18nProvider>
      <AuthProvider>
        <SettingsProvider>
          <BootOverlayCleanup />
          <ScrollRestoration />
          <Outlet />
          {edition.RootExtras && <edition.RootExtras />}
        </SettingsProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
