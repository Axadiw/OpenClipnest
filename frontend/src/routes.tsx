import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RootLayout } from './components/RootLayout';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { RootRedirect } from './components/RootRedirect';
import { RequireAuth } from './components/RequireAuth';
import { RequireAnonymous } from './components/RequireAnonymous';
import { lazyEl } from './routeUtils';
import { edition } from './edition';

// Eagerly imported: the route gates above plus the authed app shell and the
// LCP-critical grid. Everything else is code-split via React.lazy below so the
// initial entry chunk that /grid downloads stays small — heavy deps (the video
// player + react-zoom-pan-pinch, and whatever the edition adds) only load when
// their route is actually visited.
import { AuthedShell } from './components/AuthedShell';
import { GridView } from './components/GridView';

// --- Lazy route components -------------------------------------------------
// react-router `element` wants a default export; these components are named
// exports, so wrap each in a `{ default: ... }` re-map.

// Auth flows (secondary — not the first paint).
const LoginPage = lazy(() => import('./components/LoginPage').then(m => ({ default: m.LoginPage })));
const NotFoundPage = lazy(() => import('./components/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const OAuthConsentPage = lazy(() => import('./components/OAuthConsentPage').then(m => ({ default: m.OAuthConsentPage })));
const TvAuthorizePage = lazy(() => import('./components/TvAuthorizePage').then(m => ({ default: m.TvAuthorizePage })));

// Authed views other than the grid. Timeline pulls in the video player +
// react-zoom-pan-pinch.
const TimelineRoute = lazy(() => import('./components/TimelineRoute').then(m => ({ default: m.TimelineRoute })));

const SettingsLayout = lazy(() => import('./components/settings/SettingsLayout').then(m => ({ default: m.SettingsLayout })));
const GeneralTab = lazy(() => import('./components/settings/GeneralTab').then(m => ({ default: m.GeneralTab })));
const CamerasTab = lazy(() => import('./components/settings/CamerasTab').then(m => ({ default: m.CamerasTab })));
const StorageTab = lazy(() => import('./components/settings/StorageTab').then(m => ({ default: m.StorageTab })));
const McpClientsTab = lazy(() => import('./components/settings/McpClientsTab').then(m => ({ default: m.McpClientsTab })));

const RequireOwner = edition.RequireOwner;

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    // Catches route errors before they reach React Router's default dev error
    // page — chiefly a failed lazy() import on a stale chunk after a deploy
    // (auto-reload), but also any other route render/loader crash (friendly
    // recovery card). Renders outside RootLayout, hence its self-contained copy.
    errorElement: <RouteErrorBoundary />,
    children: [
      // Smart redirect for "/" — anon: the edition's visitor home (or /login);
      // authed: operator home / grid / timeline.
      { path: '/', element: <RootRedirect /> },

      // Edition routes: marketing / legal / help / email flows (cloud).
      ...edition.publicRoutes,

      // AUTH flows. /login (+ the edition's /register) force-anonymous so a
      // logged-in user hitting /login bounces back to where they came from.
      {
        element: <RequireAnonymous />,
        children: [
          { path: '/login', element: lazyEl(<LoginPage />) },
          ...edition.anonymousRoutes,
        ],
      },

      // AUTHED views — grid, timeline, settings (+ the edition's admin panel).
      // Shared shell renders header + global modals (player, change-password,
      // bulk-delete).
      {
        element: <RequireAuth />,
        children: [
          // Standalone authed pages (no app chrome — system-modal-like flows).
          { path: '/oauth/consent', element: lazyEl(<OAuthConsentPage />) },
          // Apple-TV device-code authorization. RequireAuth bounces an anon
          // visitor to /login and back here with ?code= preserved.
          { path: '/tv', element: lazyEl(<TvAuthorizePage />) },

          {
            element: <AuthedShell />,
            children: [
              // Camera views — gated by the edition's owner gate: in Clipnest
              // Cloud admins are system operators, not camera owners, so an
              // admin hitting /grid or /timeline is bounced to "/" → the panel.
              // Self-hosted has one account and no gate.
              {
                element: <RequireOwner />,
                children: [
                  // GridView stays eager — it's the LCP-critical first authed paint.
                  { path: '/grid', element: <GridView /> },
                  { path: '/timeline', element: lazyEl(<TimelineRoute />) },
                ],
              },

              // Settings — shared between user + admin (admin sees only general/profile).
              { path: '/settings', element: <Navigate to="/settings/general" replace /> },
              {
                path: '/settings',
                element: lazyEl(<SettingsLayout />),
                children: [
                  { path: 'general', element: lazyEl(<GeneralTab />) },
                  { path: 'cameras', element: lazyEl(<CamerasTab />) },
                  { path: 'storage', element: lazyEl(<StorageTab />) },
                  ...(edition.ProfileTab ? [{ path: 'profile', element: lazyEl(<edition.ProfileTab />) }] : []),
                  { path: 'mcp-clients', element: lazyEl(<McpClientsTab />) },
                  ...(edition.settingsTabs ?? []).map((tab) => ({ path: tab.path, element: tab.element })),
                ],
              },

              ...edition.shellRoutes,
            ],
          },
        ],
      },

      // 404
      { path: '*', element: lazyEl(<NotFoundPage />) },
    ],
  },
]);
