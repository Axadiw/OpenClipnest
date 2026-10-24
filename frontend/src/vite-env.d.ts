/// <reference types="vite/client" />

// Injected at build time by Vite `define` from VITE_APP_VERSION.
declare const __APP_VERSION__: string;

// An edition declares its own build-time variables by merging into
// `ImportMetaEnv` from its own .d.ts.
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
