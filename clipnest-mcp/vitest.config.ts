import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // Load .env so DB-touching tests auto-discover the local postgres (mirrors
    // the root vitest.config.ts setup for server/**/*.test.ts tests).
    setupFiles: [new URL('../server/testing/load-env-for-tests.ts', import.meta.url).pathname],
    // The public origin the OAuth issuer, resource and discovery URLs derive
    // from (config.ts). Pinned so the tests read the same everywhere instead of
    // depending on the code's default or the developer's environment.
    env: { PUBLIC_MCP_URL: 'https://clipnest.example' },
  },
});
