import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { story } from '../testing/story.js';

// Loading the flat eslint config + typescript-eslint parser on the first
// lintText() is slow (several seconds), and under CI load it has blown the
// default 5 s vitest timeout → flaky deploy-blocker. Mitigated two ways:
// share ONE ESLint instance across the cases (config loads once, not per
// test) and give each case a generous timeout. The lint is deterministic —
// this is purely cold-start latency, not flaky logic, so no retries.
const LINT_TIMEOUT_MS = 30_000;

// Self-test for the no-restricted-syntax rule in eslint.config.js that forbids
// bare `publish(STREAM_THUMBNAIL_GENERATE, …)` outside streamsClient.ts.
// The rule was added after a per-minute reconciler flooded stream:thumbnail
// with 425k duplicate entries; the dedup must always go through
// `publishThumbnailUnique`. This test asserts the lint catches future
// re-introductions at PR review time, not after-the-fact in production smoke.

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeEslint() {
  return new ESLint({ cwd: REPO_ROOT });
}

async function lintAt(eslint: ESLint, code: string, virtualFilePath: string) {
  const results = await eslint.lintText(code, {
    filePath: path.resolve(REPO_ROOT, virtualFilePath),
  });
  return results[0]?.messages ?? [];
}

describe('eslint guard — bare publish to job streams', () => {
  let eslint: ESLint;
  // One shared instance — the first lintText() loads the config; the rest
  // reuse it. Generous hook timeout for that one cold load.
  beforeAll(() => { eslint = makeEslint(); }, LINT_TIMEOUT_MS);

  it('flags bare publish(STREAM_THUMBNAIL_GENERATE, ...) outside streamsClient.ts', { timeout: LINT_TIMEOUT_MS }, async (ctx) => {
    story(ctx, 'Reconciler-flood incydent (425k stream:thumbnail backlog) wracał już dwa razy. Lint pilnuje że ktoś przy code review zobaczy regres przed merge, a nie dopiero po wybuchu na prod-smoke.');
    const messages = await lintAt(
      eslint,
      `import { publish, STREAM_THUMBNAIL_GENERATE } from './streamsClient.js';
       export function bad(eventId: string, ownerId: number) {
         return publish(STREAM_THUMBNAIL_GENERATE, { eventId, ownerId: String(ownerId) });
       }`,
      'server/services/scanner.ts',
    );
    const ourErr = messages.find(m => m.ruleId === 'no-restricted-syntax' && m.message.includes('publishThumbnailUnique'));
    expect(ourErr, `expected the rule to fire; got: ${JSON.stringify(messages)}`).toBeDefined();
  });

  it('allows bare publish() inside streamsClient.ts itself', { timeout: LINT_TIMEOUT_MS }, async (ctx) => {
    story(ctx, '`publishThumbnailUnique` musi wewnętrznie wołać bare `publish` po acquired SETNX-locku. Bez tego wyjątku reguła by się sama strzeliła w stopę.');
    const messages = await lintAt(
      eslint,
      `declare const STREAM_THUMBNAIL_GENERATE: string;
       declare function publish(s: string, p: Record<string, string>): Promise<string>;
       export async function publishThumbnailUnique(eventId: string, ownerId: number) {
         await publish(STREAM_THUMBNAIL_GENERATE, { eventId, ownerId: String(ownerId) });
       }`,
      'server/services/streamsClient.ts',
    );
    const ourErr = messages.find(m => m.ruleId === 'no-restricted-syntax');
    expect(ourErr, `streamsClient.ts must be exempt; got: ${JSON.stringify(messages)}`).toBeUndefined();
  });

  it('allows publish() to non-job streams (scan-trigger / delete-notify / DLQ)', { timeout: LINT_TIMEOUT_MS }, async (ctx) => {
    story(ctx, 'Trigger-streams i DLQ to fire-once eventy, nie per-resource jobs — dedup zmieniłby ich semantykę. Reguła nie może pomylić się i obejmować wszystko.');
    const messages = await lintAt(
      eslint,
      `import { publish, STREAM_SCAN_TRIGGER, STREAM_DELETE_NOTIFY, STREAM_DLQ_THUMBNAIL } from './services/streamsClient.js';
       export async function ok() {
         await publish(STREAM_SCAN_TRIGGER, { userUuid: 'u', s3Key: 'k' });
         await publish(STREAM_DELETE_NOTIFY, { userUuid: 'u', s3Key: 'k' });
         await publish(STREAM_DLQ_THUMBNAIL, { eventId: 'x', ownerId: '1' });
       }`,
      'server/scanner-entry.ts',
    );
    const ourErr = messages.find(m => m.ruleId === 'no-restricted-syntax');
    expect(ourErr, `non-job streams must not be flagged; got: ${JSON.stringify(messages)}`).toBeUndefined();
  });
});
