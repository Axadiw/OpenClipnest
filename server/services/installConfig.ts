// server/services/installConfig.ts
//
// Configuration a self-hosted install supplies through its `.env` file (which
// docker-compose passes on): operator-defined secrets (validated before
// anything else starts) and an optional disk limit for the recordings. Used by
// the self-hosted edition.
import { eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plans, users } from '../db/schema/index.js';
import { internalApiKeyFromEnv } from '../utils/internalApiKey.js';

// ── Secrets ────────────────────────────────────────────────────────────────

/**
 * Secrets the server needs. `minLength` is a floor, not a format. `setting`
 * is the name the value has in the docker-compose install's `.env`; `read`
 * resolves a value that may come from somewhere other than its variable.
 */
const REQUIRED_SECRETS: ReadonlyArray<{
  name: string; setting: string; minLength: number; purpose: string; read?: (env: NodeJS.ProcessEnv) => string;
}> = [
  { name: 'JWT_SECRET', setting: 'TOKEN_SECRET', minLength: 32, purpose: 'signs session tokens' },
  { name: 'CLIPNEST_ENCRYPTION_MASTER_KEY', setting: 'ENCRYPTION_KEY', minLength: 32, purpose: 'encrypts every recording — losing it loses the recordings' },
  // The one exception to "nothing is generated": the install creates this key
  // on its first start (init-certs) and every service reads it from that
  // file. Nothing stored depends on it, so a key nobody wrote down costs nothing.
  { name: 'CLIPNEST_INTERNAL_API_KEY', setting: 'INTERNAL_API_KEY', minLength: 32, purpose: 'authenticates the FTP server to the API', read: internalApiKeyFromEnv },
  { name: 'CLIPNEST_S3_ACCESS_KEY', setting: 'STORAGE_USER', minLength: 3, purpose: 'object storage user' },
  { name: 'CLIPNEST_S3_SECRET_KEY', setting: 'STORAGE_PASSWORD', minLength: 16, purpose: 'object storage password' },
];

// Values that mean "the example was copied without being filled in".
const PLACEHOLDER = /change[-_ ]?me|replace[-_ ]?me|example|your[-_ ]|^x+$|^0+$|password|secret$/i;

/**
 * Problems with the secrets, one line each. Empty ⇒ fine. Nothing the
 * operator must keep is ever generated on their behalf: a silently generated
 * encryption key is a key nobody wrote down.
 */
export function secretProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const { name, setting, minLength, purpose, read } of REQUIRED_SECRETS) {
    const value = read ? read(env) : env[name] ?? '';
    const what = `${purpose}; ${setting} in .env`;
    if (!value) problems.push(`${name} is not set (${what})`);
    else if (PLACEHOLDER.test(value)) problems.push(`${name} still holds a placeholder value (${what})`);
    else if (value.length < minLength) problems.push(`${name} is too short — at least ${minLength} characters (${what})`);
  }
  return problems;
}

/** Refuse to start with missing, placeholder or short secrets. */
export function assertSecretsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const problems = secretProblems(env);
  if (problems.length === 0) return;
  throw new Error(
    'Refusing to start: secrets are not configured.\n' +
    problems.map((p) => `  - ${p}`).join('\n') +
    '\nSet them in the .env file next to docker-compose.yml; generate each secret with `openssl rand -hex 32`' +
    ' (letters and digits only, safe in a URL and in the compose file).',
  );
}

// ── Disk limit ─────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/**
 * Parse a human size ("500GB", "1.5 TB", "200GiB", or plain bytes). Returns
 * null for empty/"0"/"unlimited" (no limit) and throws on anything else it
 * cannot read — a typo must not silently mean "unlimited".
 */
export function parseDiskLimit(raw: string | undefined): number | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === '0' || value === 'unlimited' || value === 'none') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?$/.exec(value);
  if (!m) throw new Error(`CLIPNEST_DISK_LIMIT: cannot parse "${raw}" (examples: 500GB, 2TB, 750GiB)`);
  const bytes = Math.floor(Number(m[1]) * UNITS[m[2] ?? 'b']);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`CLIPNEST_DISK_LIMIT: "${raw}" is out of range`);
  return bytes;
}

/** Name of the plan row that carries the configured limit. */
export const CONFIG_PLAN_NAME = 'self-hosted';

/**
 * Apply CLIPNEST_DISK_LIMIT. The limit is expressed as a plan row so that
 * every existing code path — FTP upload admission, auto-delete-oldest, the
 * usage bar — honours it without knowing where it came from. Re-read on every
 * start: edit the value, restart, done. Unset ⇒ accounts go back to no plan
 * (unlimited). Transfer is never limited here.
 */
export async function applyConfiguredDiskLimit(raw: string | undefined = process.env.CLIPNEST_DISK_LIMIT): Promise<number | null> {
  const limit = parseDiskLimit(raw);
  const [existing] = await db.select({ id: plans.id }).from(plans).where(eq(plans.name, CONFIG_PLAN_NAME));
  if (limit === null) {
    if (existing) await db.update(users).set({ planId: null }).where(eq(users.planId, existing.id));
    return null;
  }
  const [plan] = await db
    .insert(plans)
    .values({ name: CONFIG_PLAN_NAME, diskSpaceBytes: limit, monthlyTransferBytes: 0 })
    .onConflictDoUpdate({ target: plans.name, set: { diskSpaceBytes: limit, monthlyTransferBytes: sql`0` } })
    .returning({ id: plans.id });
  await db.update(users).set({ planId: plan.id }).where(or(isNull(users.planId), eq(users.planId, plan.id)));
  return limit;
}
