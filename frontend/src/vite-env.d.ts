/// <reference types="vite/client" />

// Injected at build time by Vite `define` from VITE_APP_VERSION.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Google Analytics 4 Measurement ID (Clipnest Cloud only). Baked
   *  in at Docker build time via `--build-arg GA_ID=...` →
   *  `ENV VITE_GA_ID=...`. When unset, src/utils/analytics.ts is a
   *  no-op and no gtag.js script is loaded. */
  readonly VITE_GA_ID?: string;
  /** Sentry DSN. Baked in at Docker build time via `--build-arg SENTRY_DSN=...`.
   *  When unset, src/utils/sentry.ts is a no-op. */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
