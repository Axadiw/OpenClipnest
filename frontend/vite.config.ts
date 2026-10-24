import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, cpSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { swBundle } from './vite-plugin-sw';

// Injected at Docker build time via the VITE_APP_VERSION env var (set from
// --build-arg VERSION=...). Falls back to 'local-dev' for `npm run dev`.
const APP_VERSION = process.env.VITE_APP_VERSION || 'local-dev';

// CI e2e mode: the `e2e` job in ci.yml runs Playwright against Vite WITHOUT
// the API server running on :3000. Every unmocked /api/* request the
// frontend bootstrap fires (e.g. /api/v0/auth/me, /api/v0/version) then
// hits Vite's proxy and dies with ECONNREFUSED — spamming the log with
// hundreds of `[WebServer] Error: connect ECONNREFUSED 127.0.0.1:3000`
// lines and making the frontend's loading/retry state stall some specs.
//
// When E2E_NO_API_PROXY=1 is set we replace the proxy with a no-op
// middleware that returns 503 + an empty JSON body for /api/**. Tests
// that need specific endpoints still register page.route() handlers
// at the browser level — those intercept BEFORE Vite, so this middleware
// only catches calls the test didn't bother to mock.
const E2E_NO_API_PROXY = process.env.E2E_NO_API_PROXY === '1';

// Edition static assets. `public-cloud/` holds files only the Clipnest Cloud
// edition ships (marketing screenshots, OG image, sitemap, its robots policy);
// the directory does not exist in the self-hosted repo. In dev it is served
// next to `public/`; in a build it is copied over `dist/` after Vite's own
// public copy, so an edition file (robots.txt) wins over the shared one.
function editionStatic(dir: string): Plugin {
  const root = path.resolve(dir);
  const present = existsSync(root);
  return {
    name: 'edition-static',
    configureServer(server) {
      if (!present) return;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        const file = path.join(root, decodeURIComponent(url));
        if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (present) cpSync(root, path.resolve('dist'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    swBundle(),
    editionStatic('public-cloud'),
    {
      name: 'dev-favicon',
      transformIndexHtml(html: string): string {
        if (APP_VERSION !== 'local-dev') return html;
        // Remove all production favicon/touch-icon links
        const stripped = html.replace(/<link rel="(?:icon|apple-touch-icon)"[^>]*\/>\n?/g, '');
        // Inject a single dev SVG link just before </head>
        return stripped.replace(
          '</head>',
          '  <link rel="icon" type="image/svg+xml" href="/logo-dev.svg" />\n  </head>',
        );
      },
    },
    E2E_NO_API_PROXY && {
      name: 'e2e-api-stub',
      configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, next: () => void) => void) => void } }) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/api/')) {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"error":"e2e-no-api-proxy","status":503}');
            return;
          }
          next();
        });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: E2E_NO_API_PROXY ? undefined : {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
