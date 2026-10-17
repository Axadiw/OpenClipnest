// frontend/src/editions/types.ts
//
// The seam between the shared core and an *edition* of the web app. The core
// renders the recordings app (grid, timeline, player, settings) and asks the
// edition for everything else: marketing/legal pages, registration, admin
// surfaces, the sign-in methods beyond email + password, analytics. Clipnest
// Cloud fills every slot; the self-hosted edition (editions/selfhost.tsx)
// leaves them empty. `src/edition.ts` is the one file that differs per edition.
import type { ComponentType, ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { OAuthResult } from '../api';
import type { Language } from '../i18n';

export interface PasskeyChallenge {
  sessionId: string;
  options: unknown;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; isAdmin: boolean; active: boolean };
}

/** Callbacks a sign-in slot uses to talk to the shared login form. */
export interface LoginSlotCallbacks {
  onSuccess: (result: LoginResult) => void;
  onError: (message: string) => void;
  onRateLimit: (retryAfterSeconds: number) => void;
  onBan: (ban: { until: string | null; reason: string | null; indefinite: boolean }) => void;
}

export interface PasskeyLoginSlot {
  /** Ask the server how this email signs in; a challenge means "passkey". May throw ApiError. */
  begin: (email: string) => Promise<PasskeyChallenge | null>;
  Stage: ComponentType<LoginSlotCallbacks & { email: string; challenge: PasskeyChallenge; onUseBackup: () => void; onBack: () => void }>;
  BackupStage: ComponentType<{ email: string; onCancel: () => void }>;
}

export interface FrontendEdition {
  name: 'selfhost' | 'cloud';
  /** Root-level routes: marketing, legal, help, email flows … */
  publicRoutes: RouteObject[];
  /** Routes under the force-anonymous gate (registration). */
  anonymousRoutes: RouteObject[];
  /** Routes inside the authed app shell (admin panel). */
  shellRoutes: RouteObject[];
  /** What an anonymous visitor sees at "/". null ⇒ straight to /login. */
  AnonymousHome: ComponentType | null;
  /** Where an operator (admin) account lands after sign-in; null ⇒ same as an owner. */
  operatorHome: string | null;
  /** Rendered beneath the authed app (cloud: the marketing footer). */
  Footer: ComponentType | null;
  /** Wraps standalone flow pages such as OAuth consent. */
  FlowLayout: ComponentType<{ children: ReactNode }>;
  /** Mounted once at the root, outside the router outlet (cloud: cookie banner). */
  RootExtras: ComponentType | null;
  /** Route gate keeping operator accounts out of the recording views (renders an Outlet). */
  RequireOwner: ComponentType;
  login: {
    OAuthButtons: ComponentType<{ onResult: (r: OAuthResult) => void; onConsentChange: (consenting: boolean) => void }> | null;
    BanNotice: ComponentType<{ until: string | null; reason: string | null; indefinite: boolean }> | null;
    /** Links under the email form (register, forgot password, home). */
    EmailStageLinks: ComponentType | null;
    passkey: PasskeyLoginSlot | null;
  };
  /**
   * The Settings → Profile tab (password, sign-in methods, account). null ⇒
   * no tab and no route: the account is defined by the install's
   * configuration, not edited in the app.
   */
  ProfileTab: ComponentType | null;
  /** Mounted inside the authed shell next to the player (cloud: account modals). */
  ShellExtras: ComponentType | null;
  /** Extra translations merged over the core catalogs at boot. */
  i18n: Partial<Record<Language, Record<string, string>>>;
  /** Boot-time side effects (error monitoring, analytics). */
  init: () => void;
}
