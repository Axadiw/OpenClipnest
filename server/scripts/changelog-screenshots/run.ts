// Changelog screenshot runner. Invoked by /deploy Phase 1.5 with a JSON
// config on stdin describing which bullets need screenshots:
//
//   echo '[{"tag":"v0.10.125","bulletIndex":1,"slug":"foo","url":"/admin?tab=changelog","selector":".admin-changelog","viewport":"desktop"}]' \
//     | npx tsx server/scripts/changelog-screenshots/run.ts
//
// Outputs one JSON line per entry on stdout (NDJSON), so callers can
// stream-parse without waiting for the whole batch:
//
//   {"tag":"v0.10.125","bulletIndex":1,"slug":"foo","status":"ok","file":"docs/changelog/screenshots/v0.10.125-1-foo.png"}
//   {"tag":"v0.10.125","bulletIndex":2,"slug":"bar","status":"skipped","reason":"locator-miss"}
//
// Hard requirements: local Vite dev server up on :5173 and local API up
// on :3000. The script does NOT boot them — that's the caller's job.
//
// Auth: takes admin email + password from env. Real login (POST
// /api/v0/auth/login/begin then /api/v0/auth/login). Token is shoved
// into localStorage on each context so the SPA boots already
// authenticated and the admin-only routes work.

import { promises as fs } from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { validateConfigEntry, formatScreenshotFilename, viewportSize, type ConfigEntry } from './helpers.js';

const FRONTEND_URL = process.env.CHANGELOG_BASE_URL ?? 'http://localhost:5173';
const API_URL = process.env.CHANGELOG_API_BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = process.env.CHANGELOG_OUT_DIR ?? path.resolve(process.cwd(), 'docs/changelog/screenshots');
const ADMIN_EMAIL = process.env.CHANGELOG_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CHANGELOG_ADMIN_PASSWORD;
const CONCURRENCY = Number(process.env.CHANGELOG_SCREENSHOT_CONCURRENCY ?? '4');
const PAGE_TIMEOUT_MS = 15_000;
const MAX_PNG_BYTES = 500 * 1024;

interface Result {
  tag: string;
  bulletIndex: number;
  slug: string;
  status: 'ok' | 'fallback-fullpage' | 'skipped';
  file?: string;
  reason?: string;
}

function emit(r: Result) {
  process.stdout.write(JSON.stringify(r) + '\n');
}

async function readStdinJson<T>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) throw new Error('empty stdin (expected JSON config)');
  return JSON.parse(raw) as T;
}

async function login(): Promise<string> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('CHANGELOG_ADMIN_EMAIL and CHANGELOG_ADMIN_PASSWORD must be set');
  }
  // Two-step: /login/begin returns mode, /login submits credentials.
  const begin = await fetch(`${API_URL}/api/v0/auth/login/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL }),
  });
  if (!begin.ok) throw new Error(`login/begin failed: HTTP ${begin.status}`);
  const beginBody = await begin.json() as { mode?: string };
  if (beginBody.mode !== 'password') {
    throw new Error(`local admin must be password-mode for screenshots; got ${beginBody.mode}`);
  }
  const login = await fetch(`${API_URL}/api/v0/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const body = await login.json() as { token?: string };
  if (!body.token) throw new Error('login response missing token');
  return body.token;
}

async function captureOne(browser: Browser, token: string, entry: ConfigEntry): Promise<Result> {
  const filename = formatScreenshotFilename(entry.tag, entry.bulletIndex, entry.slug);
  const out = path.join(OUT_DIR, filename);
  const size = viewportSize(entry.viewport);

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: size });
    // Seed the SPA with a logged-in token before any page script runs.
    await context.addInitScript((t) => {
      localStorage.setItem('clipnest-token', t);
      localStorage.setItem('clipnest-remember', '1');
    }, token);
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.goto(`${FRONTEND_URL}${entry.url}`, { waitUntil: 'networkidle' });

    let mode: 'ok' | 'fallback-fullpage' = 'ok';
    try {
      const locator = page.locator(entry.selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5_000 });
      await locator.screenshot({ path: out });
    } catch {
      mode = 'fallback-fullpage';
      await page.screenshot({ path: out, fullPage: false });
    }
    const stat = await fs.stat(out);
    if (stat.size > MAX_PNG_BYTES) {
      await fs.unlink(out).catch(() => {});
      return { tag: entry.tag, bulletIndex: entry.bulletIndex, slug: entry.slug, status: 'skipped', reason: `png-too-large (${stat.size} > ${MAX_PNG_BYTES})` };
    }
    return { tag: entry.tag, bulletIndex: entry.bulletIndex, slug: entry.slug, status: mode, file: path.relative(process.cwd(), out) };
  } catch (err) {
    return { tag: entry.tag, bulletIndex: entry.bulletIndex, slug: entry.slug, status: 'skipped', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const config = await readStdinJson<ConfigEntry[]>();
  if (!Array.isArray(config) || config.length === 0) {
    process.stderr.write('changelog-screenshots: empty config, nothing to do\n');
    return;
  }
  for (const entry of config) validateConfigEntry(entry);

  // Health checks before doing any heavy lifting. Fail loudly if either
  // service is not up — caller's job to start them.
  for (const [label, url] of [['frontend', FRONTEND_URL], ['api', `${API_URL}/api/v0/health`]]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!r.ok && r.status !== 401) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      throw new Error(`${label} health check failed at ${url}: ${err instanceof Error ? err.message : err}`, { cause: err });
    }
  }

  const token = await login();
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const results = await runWithConcurrency(config, CONCURRENCY, (entry) => captureOne(browser, token, entry));
    for (const r of results) emit(r);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  process.stderr.write(`changelog-screenshots: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
