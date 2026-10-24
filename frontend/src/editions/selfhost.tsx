// frontend/src/editions/selfhost.tsx
//
// The self-hosted edition: the shared recordings app and nothing else. One
// account, email + password sign-in, no marketing or admin surfaces.
import { Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { FrontendEdition } from './types';
import { registerTranslations } from '../i18n';
import { selfhostTranslations } from './selfhostTranslations';

function FlowLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-form flow-card">{children}</div>
    </div>
  );
}

registerTranslations(selfhostTranslations);

export const edition: FrontendEdition = {
  name: 'selfhost',
  publicRoutes: [],
  anonymousRoutes: [],
  shellRoutes: [],
  AnonymousHome: null,
  operatorHome: null,
  Footer: null,
  FlowLayout,
  RootExtras: null,
  RequireOwner: Outlet,
  login: { OAuthButtons: null, BanNotice: null, EmailStageLinks: null, passkey: null },
  // The account (e-mail, password) comes from the compose configuration.
  ProfileTab: null,
  settingsTabs: [],
  LockedBannerAction: null,
  ShellExtras: null,
  i18n: selfhostTranslations,
  init: () => {},
};
