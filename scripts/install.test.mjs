// Tests for the install contract: .env.example, the secret one-liner in the
// README, docker-compose.yml in both storage modes and with the built-in HTTPS,
// the HTTPS proxy's start script, and the settings file the smoke test writes.
//
//   node --test 'scripts/*.test.mjs'
//
// The compose checks run `docker compose config`, which needs the Docker CLI
// with Compose but no running daemon; they are skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFileText, fillLegacySettings, smokeSettings } from './smoke-test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const ENV_EXAMPLE = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const SECRETS = ['ENCRYPTION_KEY', 'TOKEN_SECRET', 'DATABASE_PASSWORD', 'STORAGE_PASSWORD'];

/** The README's command that fills in the secrets, verbatim. */
const FILL_SECRETS = (() => {
  const line = README.split('\n').map((l) => l.trim()).find((l) => l.startsWith('for n in ENCRYPTION_KEY'));
  assert.ok(line, 'README.md has the command that fills in the secrets');
  return line;
})();

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocn-install-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** .env.example with the secrets filled in by the README's command. */
function filledExample() {
  return withTempDir((dir) => {
    writeFileSync(path.join(dir, '.env'), ENV_EXAMPLE);
    const r = spawnSync('sh', ['-c', FILL_SECRETS], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(path.join(dir, '.env'), 'utf8');
  });
}

/** Set NAME='value' lines (they must already exist, possibly commented out). */
function setValues(envText, values) {
  let out = envText;
  for (const [name, value] of Object.entries(values)) {
    const re = new RegExp(`^#?${name}=.*$`, 'm');
    assert.match(out, re, `${name} is listed in .env.example`);
    out = out.replace(re, () => `${name}='${value}'`);
  }
  return out;
}

const ACCOUNT = {
  ACCOUNT_EMAIL: 'me@example.org',
  ACCOUNT_PASSWORD: 'Correct-Horse-9',
  PUBLIC_URL: 'http://192.168.1.10:8080',
  FTP_HOST: '192.168.1.10',
};

// ── the README and .env.example ────────────────────────────────────────────

test('the secret command fills every empty secret with 64 hex characters', () => {
  const env = filledExample();
  for (const name of SECRETS) assert.match(env, new RegExp(`^${name}='[0-9a-f]{64}'$`, 'm'), name);
  // Every other line is untouched.
  const others = (text) => text.split('\n').filter((l) => !SECRETS.some((n) => l.startsWith(`${n}=`)));
  assert.deepEqual(others(env), others(ENV_EXAMPLE));
});

test('running the secret command again changes nothing (an existing key is never replaced)', () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, '.env'), ENV_EXAMPLE);
    spawnSync('sh', ['-c', FILL_SECRETS], { cwd: dir });
    const first = readFileSync(path.join(dir, '.env'), 'utf8');
    const r = spawnSync('sh', ['-c', FILL_SECRETS], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), first);
  });
});

test('.env.example shows the same secret command as the README', () => {
  assert.ok(ENV_EXAMPLE.includes(FILL_SECRETS));
});

// ── docker-compose.yml ─────────────────────────────────────────────────────

const COMPOSE = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const skip = COMPOSE ? false : 'docker compose is not available';

/**
 * `docker compose config` for a .env text. The shell environment is kept out
 * of it (it would override .env). Values come back with `$` written as `$$`.
 */
function composeConfig(envText) {
  return withTempDir((dir) => {
    const envFile = path.join(dir, 'test.env');
    writeFileSync(envFile, envText);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? dir };
    if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
    const r = spawnSync('docker', [
      'compose', '-f', path.join(ROOT, 'docker-compose.yml'), '--project-directory', ROOT,
      '--env-file', envFile, 'config', '--format', 'json',
    ], { encoding: 'utf8', env });
    return { ok: r.status === 0, error: r.stderr, config: r.status === 0 ? JSON.parse(r.stdout) : null };
  });
}
const literal = (value) => String(value).replaceAll('$$', '$');
const published = (service) => service.ports.map((p) => `${p.host_ip ?? ''}:${p.published}->${p.target}`);

test('bundled storage: .env.example filled in as the README says', { skip }, () => {
  const { ok, error, config } = composeConfig(setValues(filledExample(), ACCOUNT));
  assert.ok(ok, error);
  const services = Object.keys(config.services);
  for (const s of ['minio', 'init-storage', 'init-certs', 'clipnest-api', 'clipnest-ftps', 'clipnest-frontend']) assert.ok(services.includes(s), s);
  const api = config.services['clipnest-api'].environment;
  assert.equal(api.CLIPNEST_CLEAN_FRAME_ENABLED, 'true');
  assert.equal(api.CLIPNEST_S3_ENDPOINT, 'https://minio:9000');
  assert.equal(api.NODE_EXTRA_CA_CERTS, '/certs/ca.crt');
  assert.equal(api.CLIPNEST_DISK_LIMIT, '');
  assert.equal(api.CLIPNEST_PUSH_RELAY_URL, '');
  assert.match(api.JWT_SECRET, /^[0-9a-f]{64}$/);
  // The internal key is not in .env: every service reads the generated file.
  assert.ok(!/^INTERNAL_API_KEY=/m.test(ENV_EXAMPLE));
  for (const name of ['clipnest-api', 'clipnest-ftps', 'clipnest-mcp', 'clipnest-thumbnail-worker', 'clipnest-scheduler', 'clipnest-push-worker']) {
    const env = config.services[name].environment;
    assert.equal(env.CLIPNEST_INTERNAL_API_KEY, '', name);
    assert.equal(env.CLIPNEST_INTERNAL_API_KEY_FILE, '/certs/internal-api-key', name);
    assert.ok(config.services[name].volumes.some((v) => v.source === 'certs' && v.target === '/certs'), `${name} mounts the certs volume`);
  }
  const ftps = config.services['clipnest-ftps'].environment;
  assert.equal(ftps.CLIPNEST_S3_ENDPOINT, 'https://minio:9000');
  assert.equal(ftps.CLIPNEST_S3_CA_BUNDLE, '/certs/ca.crt');
  assert.equal(ftps.FTP_PASV_URL, '192.168.1.10');
  const data = config.services.minio.volumes.find((v) => v.target === '/data');
  assert.deepEqual([data.type, data.source], ['volume', 'recordings']);
  assert.deepEqual(published(config.services['clipnest-frontend']), [':8080->8080']);
  assert.ok(published(config.services['clipnest-ftps']).includes(':21->21'));
});

test('own object storage: no bundled MinIO, the FTP certificates are still made', { skip }, () => {
  const env = setValues(filledExample(), {
    ...ACCOUNT,
    COMPOSE_PROFILES: '',
    STORAGE_USER: 'AKIAEXAMPLE',
    STORAGE_ENDPOINT: 'https://s3.example.com',
    STORAGE_RECORDINGS_BUCKET: 'clips-recordings',
    STORAGE_THUMBNAILS_BUCKET: 'clips-thumbnails',
    STORAGE_SIDECARS_BUCKET: 'clips-sidecars',
    STORAGE_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
  });
  const { ok, error, config } = composeConfig(env);
  assert.ok(ok, error);
  const services = Object.keys(config.services);
  assert.ok(!services.includes('minio') && !services.includes('init-storage'));
  assert.ok(services.includes('init-certs'));
  assert.ok(Object.keys(config.services['clipnest-ftps'].depends_on).includes('init-certs'));
  const ftps = config.services['clipnest-ftps'].environment;
  assert.equal(ftps.CLIPNEST_S3_ENDPOINT, 'https://s3.example.com');
  assert.equal(ftps.CLIPNEST_S3_CA_BUNDLE, '/etc/ssl/certs/ca-certificates.crt');
  assert.equal(ftps.CLIPNEST_S3_RECORDINGS_BUCKET, 'clips-recordings');
  assert.equal(ftps.CLIPNEST_S3_ACCESS_KEY, 'AKIAEXAMPLE');
  const api = config.services['clipnest-api'].environment;
  assert.equal(api.CLIPNEST_S3_ENDPOINT, 'https://s3.example.com');
  assert.equal(api.CLIPNEST_S3_THUMBNAILS_BUCKET, 'clips-thumbnails');
  assert.equal(api.CLIPNEST_S3_SIDECARS_BUCKET, 'clips-sidecars');
  assert.equal(api.NODE_EXTRA_CA_CERTS, '/etc/ssl/certs/ca-certificates.crt');
});

test('an INTERNAL_API_KEY kept in .env from an earlier release still applies', { skip }, () => {
  const key = 'a'.repeat(64);
  const { ok, error, config } = composeConfig(`${setValues(filledExample(), ACCOUNT)}INTERNAL_API_KEY='${key}'\n`);
  assert.ok(ok, error);
  assert.equal(config.services['clipnest-api'].environment.CLIPNEST_INTERNAL_API_KEY, key);
  assert.equal(config.services['clipnest-ftps'].environment.CLIPNEST_INTERNAL_API_KEY, key);
});

test('an empty required setting stops compose with a message that names it', { skip }, () => {
  const { ok, error } = composeConfig(setValues(filledExample(), { ...ACCOUNT, ACCOUNT_PASSWORD: '' }));
  assert.ok(!ok);
  assert.match(error, /ACCOUNT_PASSWORD is not set/);
});

test('a .env without the COMPOSE_PROFILES line is refused', { skip }, () => {
  const env = setValues(filledExample(), ACCOUNT).replace(/^COMPOSE_PROFILES=.*\n/m, '');
  const { ok, error } = composeConfig(env);
  assert.ok(!ok);
  assert.match(error, /COMPOSE_PROFILES is not set/);
});

test('optional ports and a host directory for the recordings', { skip }, () => {
  const env = setValues(filledExample(), { ...ACCOUNT, WEB_PORT: '127.0.0.1:8081', FTP_PORT: '2121', RECORDINGS_DIR: '/srv/clipnest' });
  const { ok, error, config } = composeConfig(env);
  assert.ok(ok, error);
  assert.deepEqual(published(config.services['clipnest-frontend']), ['127.0.0.1:8081->8080']);
  assert.ok(published(config.services['clipnest-ftps']).includes(':2121->21'));
  assert.equal(config.services['clipnest-api'].environment.PUBLIC_FTPS_PORT, '2121');
  const data = config.services.minio.volumes.find((v) => v.target === '/data');
  assert.deepEqual([data.type, data.source], ['bind', '/srv/clipnest']);
});

test('the images are built with the release version, the same for every service', { skip }, () => {
  const { ok, error, config } = composeConfig(setValues(filledExample(), ACCOUNT));
  assert.ok(ok, error);
  const version = config.services['clipnest-api'].build.args.VERSION;
  assert.match(version, /^v\d+\.\d+\.\d+$/);
  for (const s of ['clipnest-frontend', 'clipnest-thumbnail-worker', 'clipnest-scheduler', 'clipnest-push-worker', 'clipnest-mcp']) {
    assert.equal(config.services[s].build.args.VERSION, version, s);
  }
});

test('HTTPS is built in: the "https" profile adds the proxy on ports 80 and 443, and nothing else changes', { skip }, () => {
  const base = setValues(filledExample(), { ...ACCOUNT, PUBLIC_URL: 'https://clips.example.com' });

  const off = composeConfig(base);
  assert.ok(off.ok, off.error);
  assert.ok(!Object.keys(off.config.services).includes('caddy'), 'off unless asked for');

  const on = composeConfig(setValues(base, { COMPOSE_PROFILES: 'bundled-storage,https' }));
  assert.ok(on.ok, on.error);
  assert.ok(Object.keys(on.config.services).includes('minio'), 'the bundled storage still runs');
  const caddy = on.config.services.caddy;
  assert.deepEqual(published(caddy).sort(), [':443->443', ':80->80']);
  assert.equal(caddy.environment.PUBLIC_URL, 'https://clips.example.com');
  const mounted = caddy.volumes.map((v) => v.target);
  for (const target of ['/https-proxy.sh', '/etc/caddy/Caddyfile', '/data', '/config']) assert.ok(mounted.includes(target), target);
  assert.deepEqual(Object.keys(caddy.depends_on), ['clipnest-frontend']);
  // The web app itself still listens on its own port, for the proxy and for the LAN.
  assert.deepEqual(published(on.config.services['clipnest-frontend']), [':8080->8080']);
});

test('HTTPS also works with your own object storage', { skip }, () => {
  const env = setValues(filledExample(), {
    ...ACCOUNT,
    PUBLIC_URL: 'https://clips.example.com',
    COMPOSE_PROFILES: 'https',
    STORAGE_ENDPOINT: 'https://s3.example.com',
    STORAGE_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
  });
  const { ok, error, config } = composeConfig(env);
  assert.ok(ok, error);
  const services = Object.keys(config.services);
  assert.ok(services.includes('caddy'));
  assert.ok(!services.includes('minio'));
});

test('README.md and .env.example tell the same HTTPS steps as docker-compose.yml', () => {
  const profiles = "COMPOSE_PROFILES='bundled-storage,https'";
  assert.ok(README.includes(profiles), 'README.md names the profile');
  assert.ok(ENV_EXAMPLE.includes("'bundled-storage,https'"), '.env.example names the profile');
  assert.ok(README.includes("PUBLIC_URL='https://clips.example.com'"));
  assert.match(README, /docker compose logs caddy/);
});

test('the smoke test\'s .env keeps $ and URL-unsafe characters literal', { skip }, () => {
  const settings = smokeSettings({ webPort: '8090' });
  assert.match(settings.DATABASE_PASSWORD, /\/\+=$/);
  const { ok, error, config } = composeConfig(envFileText(settings));
  assert.ok(ok, error);
  const api = config.services['clipnest-api'].environment;
  assert.match(settings.ACCOUNT_PASSWORD, /^Smoke-Te\$t-[0-9a-f]{12}$/);
  assert.equal(literal(api.CLIPNEST_BOOTSTRAP_PASSWORD), settings.ACCOUNT_PASSWORD);
  assert.equal(literal(api.POSTGRES_PASSWORD), settings.DATABASE_PASSWORD);
  assert.equal(literal(config.services['clipnest-db'].environment.POSTGRES_PASSWORD), settings.DATABASE_PASSWORD);
  assert.deepEqual(published(config.services['clipnest-frontend']), [':8090->8080']);
});

// ── the HTTPS proxy's start script ─────────────────────────────────────────

const HTTPS_PROXY = path.join(ROOT, 'docker/https-proxy.sh');

/** Runs docker/https-proxy.sh with a stand-in for the caddy binary that reports what it was given. */
function runHttpsProxy(publicUrl) {
  return withTempDir((dir) => {
    writeFileSync(path.join(dir, 'caddy'), '#!/bin/sh\necho "host=$HTTPS_HOST"\necho "args=$*"\n', { mode: 0o755 });
    const env = { PATH: `${dir}:${process.env.PATH}` };
    if (publicUrl !== undefined) env.PUBLIC_URL = publicUrl;
    const r = spawnSync('sh', [HTTPS_PROXY], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  });
}

test('the HTTPS proxy takes the domain from PUBLIC_URL, so it is written once', () => {
  for (const [url, host] of [
    ['https://clips.example.com', 'clips.example.com'],
    ['https://clips.example.com/', 'clips.example.com'],
    ['https://nas-1.home.example.org', 'nas-1.home.example.org'],
    ['https://localhost', 'localhost'],
  ]) {
    const r = runHttpsProxy(url);
    assert.equal(r.code, 0, `${url}: ${r.err}`);
    assert.match(r.out, new RegExp(`^host=${host}$`, 'm'), url);
    assert.match(r.out, /^args=run --config \/etc\/caddy\/Caddyfile --adapter caddyfile$/m);
  }
});

test('the HTTPS proxy refuses a PUBLIC_URL that could never work, and says what to write', () => {
  for (const url of [
    'http://192.168.1.10:8080', // the address of an install without HTTPS
    'https://clips.example.com:8443', // it listens on 443 only
    'https://clips.example.com/clips', // a sub-path is not supported
    'clips.example.com',
    'https://',
    '',
    undefined,
  ]) {
    const r = runHttpsProxy(url);
    assert.equal(r.code, 1, `${url}`);
    assert.equal(r.out, '', `${url}: caddy must not start`);
    assert.match(r.err, /PUBLIC_URL='https:\/\/clips\.example\.com'/, url);
  }
});

// ── the smoke test's helpers ───────────────────────────────────────────────

test('a .env value cannot carry a single quote', () => {
  assert.throws(() => envFileText({ ACCOUNT_PASSWORD: "it's" }), /single quote/);
  assert.equal(envFileText({ A: 'x$y', B: 'p/q+r=' }), "A='x$y'\nB='p/q+r='\n");
});

// The SETTINGS block of the releases before .env, trimmed to its anchors.
const LEGACY = `x-settings:
  account_email: &account_email ""
  account_password: &account_password ""
  public_url: &public_url "http://192.168.1.10:8080"
  ftp_host: &ftp_host "192.168.1.10"
  disk_limit: &disk_limit ""
  encryption_key: &encryption_key ""
  token_secret: &token_secret ""
  internal_api_key: &internal_api_key ""
  database_password: &database_password ""
  storage_user: &storage_user "clipnest"
  storage_password: &storage_password ""
  push_relay_url: &push_relay_url ""
services:
  web:
    ports:
      - "8080:8080"
`;

test('an older release\'s compose file is filled in, with $ escaped for Compose', () => {
  const settings = smokeSettings({ webPort: '8090', urlSafeDatabasePassword: true, internalApiKey: true });
  const out = fillLegacySettings(LEGACY, settings);
  // Compose reads `$$` as a literal `$`, so every `$` of the password is doubled.
  const escaped = settings.ACCOUNT_PASSWORD.replaceAll('$', () => '$$');
  assert.ok(escaped.includes('$$') && !escaped.includes('$$$'));
  assert.ok(out.includes(`account_password: &account_password "${escaped}"`));
  assert.ok(out.includes(`database_password: &database_password "${settings.DATABASE_PASSWORD}"`));
  assert.match(settings.DATABASE_PASSWORD, /^[0-9a-f]{64}$/);
  assert.ok(out.includes('"8090:8080"'));
  assert.ok(out.includes('push_relay_url: &push_relay_url ""'));
  assert.throws(() => fillLegacySettings(LEGACY.replace(/^ {2}ftp_host.*\n/m, ''), settings), /ftp_host/);
});
