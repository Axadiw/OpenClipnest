#!/usr/bin/env node
// Smoke test: install OpenClipnest from scratch exactly as the README says,
// then check that it works end to end.
//
//   node scripts/smoke-test.mjs                      fresh install
//   node scripts/smoke-test.mjs --upgrade-from v1.2  install that release,
//                                                    record, upgrade to this
//                                                    tree, check nothing broke
//   --keep        leave the stack running afterwards (for debugging)
//   --web-port N  host port for the web app (default 8080)
//   --no-https    skip the check of the built-in HTTPS, which needs the host
//                 ports 80 and 443
//
// Needs Docker (Compose v2.20+), curl and git. It uses its own compose
// project ("ocn-smoke") and its own settings file under .smoke/ (never the
// .env of a real install), and removes that project's volumes before and
// after, so it never touches a real install on the same machine.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.smoke');
const PROJECT = 'ocn-smoke';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const KEEP = args.includes('--keep');
const NO_HTTPS = args.includes('--no-https');
const UPGRADE_FROM = flag('--upgrade-from');
const WEB_PORT = flag('--web-port') ?? '8080';
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const FIXTURE = path.join(ROOT, 'scripts/fixtures/clip.mp4');
/** The release version docker-compose.yml builds the images with (x-version). */
const releaseVersion = () => readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').match(/^x-version: &version "([^"]+)"/m)?.[1];

// ── settings ───────────────────────────────────────────────────────────────

/** A secret made the way the README makes one: `openssl rand -hex 32`. */
const hexSecret = () => randomBytes(32).toString('hex');

/**
 * The settings a user writes into .env. The database password deliberately
 * carries `/`, `+` and `=` (what a base64 secret brings) so that the server's
 * handling of URL-unsafe credentials is exercised end to end — except when
 * upgrading from an earlier release, which has to start with the same
 * password and may predate that handling.
 */
export function smokeSettings({ webPort = '8080', urlSafeDatabasePassword = false, internalApiKey = false } = {}) {
  return {
    ACCOUNT_EMAIL: 'smoke@example.org',
    // A `$` on purpose: inside single quotes .env keeps it literal (README).
    ACCOUNT_PASSWORD: ['Smoke', 'Te$t', randomBytes(6).toString('hex')].join('-'),
    PUBLIC_URL: `http://127.0.0.1:${webPort}`,
    FTP_HOST: '127.0.0.1',
    DISK_LIMIT: '750MB',
    ENCRYPTION_KEY: hexSecret(),
    TOKEN_SECRET: hexSecret(),
    // Only releases before the generated key needed it; an upgrade keeps it in
    // .env, which also checks that a value there still takes precedence.
    ...(internalApiKey ? { INTERNAL_API_KEY: hexSecret() } : {}),
    DATABASE_PASSWORD: urlSafeDatabasePassword ? hexSecret() : `${randomBytes(24).toString('base64')}/+=`,
    STORAGE_USER: 'clipnest',
    STORAGE_PASSWORD: hexSecret(),
    COMPOSE_PROFILES: 'bundled-storage',
    WEB_PORT: webPort,
  };
}

/** A .env file as the README tells users to write it: NAME='value'. */
export function envFileText(settings) {
  return Object.entries(settings).map(([name, value]) => {
    if (/['\r\n]/.test(value)) throw new Error(`${name}: a .env value cannot contain a single quote or a line break`);
    return `${name}='${value}'`;
  }).join('\n') + '\n';
}

// Releases from before .env kept their settings in a SETTINGS block at the
// top of docker-compose.yml (`name: &name "…"` lines). Detected by the
// absence of .env.example; --upgrade-from fills that block instead.
const LEGACY_SETTINGS = {
  account_email: 'ACCOUNT_EMAIL',
  account_password: 'ACCOUNT_PASSWORD',
  public_url: 'PUBLIC_URL',
  ftp_host: 'FTP_HOST',
  disk_limit: 'DISK_LIMIT',
  encryption_key: 'ENCRYPTION_KEY',
  token_secret: 'TOKEN_SECRET',
  internal_api_key: 'INTERNAL_API_KEY',
  database_password: 'DATABASE_PASSWORD',
  storage_user: 'STORAGE_USER',
  storage_password: 'STORAGE_PASSWORD',
};

/** Fill the SETTINGS block of a pre-.env compose file. */
export function fillLegacySettings(text, settings) {
  let out = text;
  for (const [key, name] of Object.entries(LEGACY_SETTINGS)) {
    const re = new RegExp(`^(\\s*${key}:\\s*&${key}\\s*)"[^"]*"`, 'm');
    if (!re.test(out)) throw new Error(`setting "${key}" not found in docker-compose.yml`);
    // Compose expands `$` in the compose file itself, so a literal one is `$$`.
    const value = JSON.stringify(settings[name]).replace(/\$/g, () => '$$');
    out = out.replace(re, (_, head) => head + value);
  }
  if (settings.WEB_PORT !== '8080') out = out.replace('"8080:8080"', `"${settings.WEB_PORT}:8080"`);
  return out;
}

const SETTINGS = smokeSettings({ webPort: WEB_PORT, urlSafeDatabasePassword: Boolean(UPGRADE_FROM), internalApiKey: Boolean(UPGRADE_FROM) });

// ── helpers ────────────────────────────────────────────────────────────────
let step = 0;
const log = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ok — ${msg}`);
function fail(msg) { throw new Error(msg); }
function expect(cond, msg) { if (!cond) fail(msg); ok(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compose arguments for an install tree: its settings, written once per run. */
function composeFiles(dir) {
  const name = path.basename(dir);
  if (existsSync(path.join(dir, '.env.example'))) {
    const envFile = path.join(WORK, `${name}.env`);
    if (!existsSync(envFile)) writeFileSync(envFile, envFileText(SETTINGS), { mode: 0o600 });
    return ['-f', path.join(dir, 'docker-compose.yml'), '--env-file', envFile];
  }
  const file = path.join(WORK, `compose-${name}.yml`);
  if (!existsSync(file)) {
    writeFileSync(file, fillLegacySettings(readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), SETTINGS), { mode: 0o600 });
  }
  return ['-f', file];
}

function compose(dir, ...cmd) {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '--project-directory', dir, ...composeFiles(dir), ...cmd], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function composeOk(dir, ...cmd) {
  const r = compose(dir, ...cmd);
  if (r.code !== 0) fail(`docker compose ${cmd.join(' ')} failed:\n${r.out.slice(-4000)}`);
  return r.out;
}

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function waitHealthy(timeoutMs = 600_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/v0/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > until) fail('the stack did not become healthy in time');
    await sleep(2000);
  }
}

async function login(password = SETTINGS.ACCOUNT_PASSWORD) {
  const res = await api('POST', '/api/v0/auth/login', { body: { email: SETTINGS.ACCOUNT_EMAIL, password } });
  if (!res.ok) fail(`login failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

/** Upload the fixture the way a camera does: FTP, date folders, camera naming. */
function cameraUpload(camera, password = SETTINGS.ACCOUNT_PASSWORD, { tls = true } = {}) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const remote = `/${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}/${camera}_00_${ts}.mp4`;
  const r = spawnSync('curl', [
    '--silent', '--show-error', '--ftp-pasv', '--ftp-create-dirs', '--max-time', '120',
    ...(tls ? ['--ftp-ssl-reqd', '--insecure'] : []),
    '--user', `${SETTINGS.ACCOUNT_EMAIL}:${password}`,
    '-T', FIXTURE, `ftp://127.0.0.1:21${remote}`,
  ], { encoding: 'utf8' });
  if (r.status !== 0) fail(`camera upload failed (curl exit ${r.status}): ${r.stderr}`);
  return remote;
}

/** Sign in over FTPS and list the root, as a camera's connection test does. Returns curl's exit code (67 = login refused). */
function ftpLogin(password) {
  const r = spawnSync('curl', [
    '--silent', '--ftp-pasv', '--max-time', '60', '--ftp-ssl-reqd', '--insecure', '--list-only',
    '--user', `${SETTINGS.ACCOUNT_EMAIL}:${password}`, '-o', '/dev/null', 'ftp://127.0.0.1:21/',
  ], { encoding: 'utf8' });
  return r.status;
}

async function waitForPlayableEvent(token, camera, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await api('GET', '/api/v0/events?limit=50', { token });
    if (res.ok) {
      const { events = [] } = await res.json();
      const hit = events.find((e) => e.camera === camera);
      if (hit) return hit;
    }
    if (Date.now() > until) fail(`recording from "${camera}" never appeared in the grid`);
    await sleep(2000);
  }
}

async function expectPlayable(token, event) {
  const thumb = await api('GET', `/api/v0/events/${event.id}/thumbnail`, { token });
  expect(thumb.ok && /image\//.test(thumb.headers.get('content-type') ?? ''), 'thumbnail is served');
  const video = await api('GET', `/api/v0/events/${event.id}/video/00`, { token, headers: { range: 'bytes=0-1023' } });
  expect(video.status === 206, 'video answers a Range request with 206 (seeking works)');
  expect((await video.arrayBuffer()).byteLength === 1024, 'the requested byte range is returned');
}

/**
 * `?fmt=clean` is the stream the web app and the apps request. The fixture is
 * a non-fragmented MP4 (moov before mdat); for such a file no clean-frame
 * sidecar is ever built, so the server answers with the original recording.
 * What this proves: with the clean stream switched on, a request for it plays
 * (no error when the file has no sidecar) and HEAD and GET agree on its
 * length, which players rely on to read the end of a clip. What it does not
 * prove: the clean-frame reconstruction itself — that needs a fragmented
 * recording, which this fixture is not.
 */
async function expectCleanPlayable(token, event) {
  const url = `/api/v0/events/${event.id}/video/00?fmt=clean`;
  const head = await api('HEAD', url, { token });
  expect(head.status === 200, `HEAD of the clean stream answers 200 (got ${head.status})`);
  const video = await api('GET', url, { token, headers: { range: 'bytes=0-1023' } });
  expect(video.status === 206, `the clean stream answers a Range request with 206 (got ${video.status})`);
  const total = Number((video.headers.get('content-range') ?? '').split('/')[1]);
  expect(total > 0 && total === Number(head.headers.get('content-length')), 'HEAD and GET agree on the length of the clean stream');
  const body = Buffer.from(await video.arrayBuffer());
  expect(body.length === 1024 && body.toString('latin1', 4, 8) === 'ftyp', 'the clean stream starts with an MP4 header');
}

function teardown(dir) {
  compose(dir, 'down', '-v', '--remove-orphans');
}

// ── scenarios ──────────────────────────────────────────────────────────────
async function checkInstall(dir) {
  log('edition and feature surface');
  const cfg = await (await api('GET', '/api/v0/config')).json();
  expect(cfg.edition === 'selfhost', 'the server reports the self-hosted edition');
  expect(Boolean(releaseVersion()) && cfg.version === releaseVersion(), `the server reports the release version of docker-compose.yml (${cfg.version})`);
  expect(cfg.features.registration === false, 'registration is off');
  expect(cfg.ftps.host === SETTINGS.FTP_HOST, 'the configured FTP host is reported');
  expect(cfg.ftps.port === 21, 'the FTP port is reported');
  for (const [method, p] of [['POST', '/api/v0/register'], ['GET', '/api/v0/plans'], ['GET', '/api/v0/users'],
    ['GET', '/api/v0/admin/invites'], ['GET', '/api/v0/legal/controller'],
    ['POST', '/api/v0/auth/forgot-password']]) {
    const res = await api(method, p, { body: method === 'POST' ? {} : undefined });
    expect(res.status === 404, `${method} ${p} does not exist`);
  }
  // The native apps' sign-in pre-flight: always a password on this edition.
  const begin = await (await api('POST', '/api/v0/auth/login/begin', { body: { email: SETTINGS.ACCOUNT_EMAIL } })).json();
  expect(begin.mode === 'password', 'the apps\' sign-in pre-flight answers password');
  const metrics = compose(dir, 'exec', '-T', 'clipnest-api', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:3000/metrics');
  expect(metrics.code !== 0, 'no /metrics endpoint');

  log('sign in with the account from the configuration');
  const token = await login();
  ok('signed in (the password contains a `$`, kept literal by .env)');
  const second = compose(dir, 'exec', '-T', '-e', 'CLIPNEST_BOOTSTRAP_PASSWORD=Another-Passw0rd-1', 'clipnest-api',
    'node', 'dist/scripts/bootstrap-admin.js', 'second@example.org');
  expect(second.code === 5, 'a second account cannot be created');

  log('disk limit from the configuration');
  const usage = await (await api('GET', '/api/v0/usage', { token })).json();
  expect(usage.disk.limitBytes === 750e6, `disk limit is 750 MB (got ${usage.disk.limitBytes})`);
  expect(usage.transfer.limitBytes === 0, 'transfer is unlimited');

  log('a camera uploads a recording (FTPS)');
  cameraUpload('Driveway');
  const event = await waitForPlayableEvent(token, 'Driveway');
  ok('the recording appeared in the grid');
  await expectPlayable(token, event);
  await expectCleanPlayable(token, event);

  log('a camera without TLS support uploads over plain FTP');
  cameraUpload('Garden', SETTINGS.ACCOUNT_PASSWORD, { tls: false });
  const garden = await waitForPlayableEvent(token, 'Garden');
  ok('the recording appeared in the grid');

  log('delete a recording');
  const del = await api('DELETE', `/api/v0/events/${garden.id}`, { token });
  expect(del.ok, 'delete accepted');
  const after = await (await api('GET', '/api/v0/events?limit=50', { token })).json();
  expect(!after.events.some((e) => e.id === garden.id), 'it is gone from the grid');

  return { token, event };
}

async function checkPasswords(dir) {
  log('the password cannot be changed in the app');
  const token = await login();
  const changed = await api('PUT', '/api/v0/auth/password', {
    token, body: { currentPassword: SETTINGS.ACCOUNT_PASSWORD, newPassword: 'Changed-Passw0rd-22' },
  });
  expect(changed.status === 404, `no password-change endpoint (got ${changed.status})`);

  log('a password set behind the configuration\'s back');
  const reset = compose(dir, 'exec', '-T', '-e', 'CLIPNEST_NEW_PASSWORD=Changed-Passw0rd-22', 'clipnest-api',
    'node', 'dist/scripts/reset-password.js', SETTINGS.ACCOUNT_EMAIL);
  expect(reset.code === 0, 'reset-password ran');
  await login('Changed-Passw0rd-22');

  log('the password from the configuration is applied again on restart');
  composeOk(dir, 'restart', 'clipnest-api');
  await waitHealthy();
  await login();
  ok('the configured password signs in');
  const stale = await api('POST', '/api/v0/auth/login', { body: { email: SETTINGS.ACCOUNT_EMAIL, password: 'Changed-Passw0rd-22' } });
  expect(stale.status === 401, 'the other password did not survive the restart');
}

// The README promises that FTP and web sign-in are locked out separately and
// that reset-user-ban.js clears a lockout.
async function checkLockouts(dir) {
  log('a camera with an outdated password cannot lock the owner out of the web app');
  for (let i = 1; i <= 5; i++) {
    expect(ftpLogin('Outdated-Passw0rd-1') === 67, `FTP login with an outdated password is refused (${i}/5)`);
  }
  await sleep(1000);
  expect(ftpLogin(SETTINGS.ACCOUNT_PASSWORD) === 67, 'after 5 failures FTP sign-in is locked, even with the right password');
  await login();
  ok('the web sign-in still works');

  log('a lockout is cleared by hand');
  const cleared = compose(dir, 'exec', '-T', 'clipnest-api', 'node', 'dist/scripts/reset-user-ban.js', SETTINGS.ACCOUNT_EMAIL);
  expect(cleared.code === 0, 'reset-user-ban ran');
  expect(ftpLogin(SETTINGS.ACCOUNT_PASSWORD) === 0, 'FTP sign-in works again');
}

/** curl to the stack's HTTPS side: `localhost` is this machine, and Caddy's own CA is not trusted. */
function httpsCurl(...a) {
  const r = spawnSync('curl', [
    '--silent', '--show-error', '--insecure', '--max-time', '30',
    '--resolve', 'localhost:443:127.0.0.1', '--resolve', 'localhost:80:127.0.0.1', ...a,
  ], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// The README's steps for the built-in HTTPS, with the one domain a test can
// use: `localhost`, for which Caddy makes a certificate from its own CA instead
// of asking Let's Encrypt. Proves that PUBLIC_URL and COMPOSE_PROFILES are all
// it takes, that http:// is sent to https://, and that sign-in and video Range
// requests come through the proxy.
async function checkHttps(dir, event) {
  log('turn on HTTPS: "https" in COMPOSE_PROFILES, PUBLIC_URL=https://localhost');
  writeFileSync(path.join(WORK, `${path.basename(dir)}.env`),
    envFileText({ ...SETTINGS, PUBLIC_URL: 'https://localhost', COMPOSE_PROFILES: 'bundled-storage,https' }), { mode: 0o600 });
  composeOk(dir, 'up', '-d');
  await waitHealthy();
  const until = Date.now() + 120_000;
  for (;;) {
    const r = httpsCurl('--fail', '--output', '/dev/null', 'https://localhost/api/v0/healthz');
    if (r.code === 0) break;
    if (Date.now() > until) fail(`HTTPS did not come up: ${r.err}\n${compose(dir, 'logs', '--tail', '40', 'caddy').out}`);
    await sleep(2000);
  }
  ok('the proxy answers on https://localhost');

  const cfg = JSON.parse(httpsCurl('https://localhost/api/v0/config').out);
  expect(cfg.edition === 'selfhost', 'the API answers through the proxy');
  const redirect = httpsCurl('--output', '/dev/null', '--write-out', '%{http_code} %{redirect_url}', 'http://localhost/grid?cameras=Driveway');
  expect(redirect.out === '308 https://localhost/grid?cameras=Driveway', `http:// is sent to https:// (got "${redirect.out}")`);
  expect(/^strict-transport-security:/im.test(httpsCurl('--head', 'https://localhost/').out), 'the web app sends Strict-Transport-Security');

  const signIn = httpsCurl('--request', 'POST', '--header', 'content-type: application/json',
    '--data', JSON.stringify({ email: SETTINGS.ACCOUNT_EMAIL, password: SETTINGS.ACCOUNT_PASSWORD }), 'https://localhost/api/v0/auth/login');
  const token = JSON.parse(signIn.out || '{}').token;
  expect(Boolean(token), 'signing in works over HTTPS');
  const range = httpsCurl('--header', `authorization: Bearer ${token}`, '--header', 'range: bytes=0-1023',
    '--output', '/dev/null', '--write-out', '%{http_code} %{size_download}', `https://localhost/api/v0/events/${event.id}/video/00`);
  expect(range.out === '206 1024', `a video Range request comes through the proxy (got "${range.out}")`);
}

async function freshInstall() {
  log('install from scratch');
  teardown(ROOT);
  composeOk(ROOT, 'up', '-d', '--build');
  await waitHealthy();
  ok('the stack is up');

  const { event } = await checkInstall(ROOT);
  await checkPasswords(ROOT);
  await checkLockouts(ROOT);

  log('restart the whole stack');
  composeOk(ROOT, 'restart');
  await waitHealthy();
  const token = await login();
  const events = await (await api('GET', '/api/v0/events?limit=50', { token })).json();
  expect(events.events.some((e) => e.id === event.id), 'the recording survived the restart');
  await expectPlayable(token, event);

  if (!NO_HTTPS) await checkHttps(ROOT, event);
}

async function upgradeFrom(ref) {
  const prev = path.join(WORK, 'previous');
  log(`install the previous release (${ref})`);
  spawnSync('git', ['worktree', 'remove', '--force', prev], { cwd: ROOT });
  execFileSync('git', ['worktree', 'add', '--detach', prev, ref], { cwd: ROOT, stdio: 'inherit' });
  teardown(prev);
  composeOk(prev, 'up', '-d', '--build');
  await waitHealthy();
  let token = await login();
  cameraUpload('Driveway');
  const event = await waitForPlayableEvent(token, 'Driveway');
  await expectPlayable(token, event);

  log('upgrade to this version (same data, same configuration)');
  composeOk(ROOT, 'up', '-d', '--build', '--remove-orphans');
  await sleep(5000);
  await waitHealthy();
  token = await login();
  ok('the same password still signs in');
  const events = await (await api('GET', '/api/v0/events?limit=50', { token })).json();
  expect(events.events.some((e) => e.id === event.id), 'the recording made before the upgrade is still in the grid');
  await expectPlayable(token, event);
  await expectCleanPlayable(token, event);
  const usage = await (await api('GET', '/api/v0/usage', { token })).json();
  expect(usage.disk.limitBytes === 750e6, 'the configured disk limit was kept');

  log('a camera uploads after the upgrade');
  await sleep(1100); // camera file names carry a one-second timestamp
  cameraUpload('Porch');
  await expectPlayable(token, await waitForPlayableEvent(token, 'Porch'));
  spawnSync('git', ['worktree', 'remove', '--force', prev], { cwd: ROOT });
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  let failed = false;
  try {
    if (UPGRADE_FROM) await upgradeFrom(UPGRADE_FROM); else await freshInstall();
    console.log('\nSMOKE TEST PASSED');
  } catch (err) {
    failed = true;
    console.error(`\nSMOKE TEST FAILED: ${err.message}`);
    console.error(compose(ROOT, 'logs', '--tail', '60', 'clipnest-api', 'clipnest-ftps', 'clipnest-thumbnail-worker').out.slice(-8000));
  } finally {
    if (!KEEP) { teardown(ROOT); rmSync(WORK, { recursive: true, force: true }); }
  }
  process.exit(failed ? 1 : 0);
}

// Imported by the tests for its helpers; only a direct run installs anything.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
