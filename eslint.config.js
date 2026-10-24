import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import safeql from '@ts-safeql/eslint-plugin/config';
import process from 'node:process';

export default tseslint.config(
  // Everything here is gitignored, so CI's fresh checkout never sees any of
  // it — these entries exist purely so `npx eslint .` stays usable locally.
  //
  // `mobile-android/**/build/` is Gradle output. Running the Android unit
  // tests locally writes an HTML test report whose bundled report.js trips
  // no-undef six times — a lint "failure" that is nothing but a local build
  // artifact.
  //
  // `.claude/worktrees/` is where agent worktrees get checked out, each a
  // full copy of this repo. With ~20 of them present, `npx eslint .` reported
  // 12,170 problems where exactly one was real; 11,511 came from the copies
  // and 105 from `dist-mcp/`. Linting the same source twenty times over also
  // means a genuine regression scrolls past unseen, which is the actual cost.
  //
  // `dist-mcp/` is the compiled MCP server, the one build output that was
  // missing here while `dist/` and `frontend/dist/` were already covered.
  //
  // Only directories that actually contain lintable files are listed. The
  // other gitignored ones present locally — certs, e2e-videos, logs,
  // minio-data, playwright-report, test-reports, test-results, .run-dev —
  // hold no .js/.ts at all, so ignoring them would be config nobody can
  // verify. Add one if that ever changes.
  {
    ignores: [
      'dist/',
      'dist-mcp/',
      'frontend/dist/',
      'node_modules/',
      'frontend/node_modules/',
      'tools/',
      'mobile-android/**/build/',
      '.claude/worktrees/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // Error monitoring is an edition concern. The shared tree reports through
    // server/errorReporting.ts and frontend/src/lib/errorReporting.ts; only an
    // edition's own directory may talk to a monitoring SDK.
    files: ['server/**/*.ts', 'clipnest-mcp/**/*.ts', 'frontend/src/**/*.{ts,tsx}'],
    ignores: ['server/cloud/**', 'frontend/src/cloud/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@sentry/*'], message: 'Report through errorReporting (the edition installs the reporter).' }],
      }],
    },
  },
  {
    // Service worker scripts under public/ run in a ServiceWorker global
    // scope, not the regular browser window — they need both the SW
    // globals (self, caches) and the shared fetch/Response/TransformStream
    // APIs the no-undef rule otherwise flags.
    files: ['frontend/public/**/*.js'],
    languageOptions: {
      globals: {
        // ServiceWorkerGlobalScope basics
        self: 'readonly',
        caches: 'readonly',
        // Fetch / streams API used inside the SW
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        TransformStream: 'readonly',
        ReadableStream: 'readonly',
        // Standard
        Uint8Array: 'readonly',
        Map: 'readonly',
        Promise: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Event: 'readonly',
      },
    },
  },
  {
    // Node-side build scripts (prerender, etc.) — they use the Node
    // global pool (process, console, setTimeout, …). Without this
    // override no-undef flags every one of them. Covers both the
    // frontend prerender scripts and the root-level diagnostic /
    // measurement scripts under `scripts/` (e.g. storage Range probes).
    files: ['frontend/scripts/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}', 'oss/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Map: 'readonly',
        Promise: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  ...(process.env.DATABASE_URL
    ? [safeql.configs.connections({
        databaseUrl: process.env.DATABASE_URL,
        targets: [
          // Drizzle's sql tag
          { tag: 'sql', transform: '{type}[]' },
        ],
      })]
    : []),
  {
    // Stream-publish hygiene: enforce SETNX-dedup wrappers for "job" streams.
    //
    // The bare `publish(STREAM_THUMBNAIL_GENERATE, …)` pattern was hit
    // twice in the project's history (faststart, then thumbnail — 2 M-entry
    // stream backlog, 425 k consumer-group lag, smoke red for hours).
    // Fix in both cases: route through a `*Unique` wrapper that SETNX-locks
    // `<stream>-published:<id>` with a TTL before the XADD, so the
    // per-minute reconciler can't flood the worker queue with duplicates of
    // events already in flight.
    //
    // Trigger streams (scan-trigger / delete-notify / ftps-prefix-deleted)
    // and DLQ streams are out of scope — they're fire-once events, not
    // per-resource jobs, and dedup would change semantics.
    //
    // streamsClient.ts itself is excluded because the `*Unique` wrappers
    // legitimately call the bare `publish` after acquiring the SETNX lock.
    files: ['server/**/*.ts'],
    ignores: [
      'server/services/streamsClient.ts',
      'server/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='publish'][arguments.0.name='STREAM_THUMBNAIL_GENERATE']",
          message: "Use publishThumbnailUnique(eventId, ownerId) instead of publish(STREAM_THUMBNAIL_GENERATE, …). Bare publish floods stream:thumbnail with duplicates from the per-minute reconciler — see streamsClient.ts:publishThumbnailUnique.",
        },
      ],
    },
  },
);
