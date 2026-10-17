import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    globals: true,
    // Loads .env so DB-touching tests can auto-discover the local docker
    // postgres (DATABASE_URL is derived from POSTGRES_* vars in .env). CI
    // sets DATABASE_URL directly, which this setup respects without
    // overwriting.
    setupFiles: ['./server/testing/load-env-for-tests.ts'],
    // Hook timeout bumped from the 10s default to 60s. Several test files
    // (db.migrate, db.schema-roundtrip, db.getEvents-sql, routes/mcpClients,
    // routes/oauthConsent, scripts/oauthSweep) run a scratch-schema migrate
    // in beforeAll — drizzle's migrator applies the baseline SQL with a
    // schema rewrite for each statement, which takes 3-10s on CI's Postgres
    // 14 (vs sub-second locally on Postgres 16) and 10s leaves no headroom
    // when several files initialise in parallel.
    hookTimeout: 60_000,
    // Dual reporter: default console output PLUS a custom JSON dump with
    // per-test story annotations (see server/testing/json-story-reporter.ts).
    // The JSON output path is controlled by STORY_REPORT_OUTPUT — set it in
    // the npm script so it lands at repo-root test-results/.
    reporters: process.env.CI
      ? ['default']
      : ['default', './server/testing/json-story-reporter.ts'],
  },
});
