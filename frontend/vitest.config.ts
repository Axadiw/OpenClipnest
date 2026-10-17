import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    // Same JSON reporter as the server — reused from ../server/testing/. The
    // STORY_REPORT_OUTPUT env var (set in package.json `test` script) steers
    // the output to the repo-root test-results/vitest-frontend.json.
    reporters: process.env.CI
      ? ['default']
      : ['default', '../server/testing/json-story-reporter.ts'],
  },
});
