// server/services/bootstrap.ts
//
// Creating the first account on an empty database — the install step. Used by
// the `bootstrap-admin` CLI and by the API's first boot when
// CLIPNEST_BOOTSTRAP_EMAIL / CLIPNEST_BOOTSTRAP_PASSWORD are set (the
// docker-compose path). The role of that account is the edition's call
// (`edition.firstAccount`). There is deliberately no HTTP route for this: an
// unauthenticated "create the first admin" endpoint on a freshly deployed
// instance is an account-takeover surface.
import crypto from 'crypto';
import { hashPassword, validatePasswordStrength, verifyPassword } from './auth.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';
import { createFirstAccount, getUserByEmail, getUserCount, updateUserPasswordByInternalId } from '../db/queries/users.js';
import type { FirstAccountSpec } from '../extensions.js';

export type BootstrapResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_email' | 'weak_password' | 'exists'; message: string };

export async function bootstrapFirstAccount(
  input: { email: unknown; password: string },
  account: FirstAccountSpec,
  opts: { allowWeakPassword?: boolean } = {},
): Promise<BootstrapResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, reason: 'invalid_email', message: `Invalid email: "${String(input.email)}"` };
  const pwError = opts.allowWeakPassword ? null : validatePasswordStrength(input.password);
  if (pwError) return { ok: false, reason: 'weak_password', message: pwError };

  const created = await createFirstAccount({
    uuid: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword(input.password),
    encryptionSalt: crypto.randomBytes(32).toString('base64url'),
    isAdmin: account.isAdmin,
    planName: account.planName,
  });
  if (!created) {
    return { ok: false, reason: 'exists', message: 'Database already has users; the first account can only be created on an empty database' };
  }
  return { ok: true, email };
}

export type SeedResult = 'created' | 'skipped' | 'unset' | 'missing' | { failed: string };

/**
 * First-boot seeding from the environment. Reads CLIPNEST_BOOTSTRAP_EMAIL /
 * CLIPNEST_BOOTSTRAP_PASSWORD (any NODE_ENV — this is how a compose install
 * gets its account), or the legacy DEV_SEED_EMAIL / DEV_SEED_PASSWORD pair in
 * development. A no-op once any user exists, so leaving the variables set is
 * harmless. Returns what happened for the startup log:
 *  - 'missing': the account settings are absent or half set, which the
 *    existing account makes harmless (warn, keep going);
 *  - { failed }: the database has no account and none can be created — half
 *    set, or absent while the edition's account comes only from the
 *    configuration (`account.fromConfig`) — or the values are invalid.
 */
export async function seedFirstAccountFromEnv(
  account: FirstAccountSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const dev = env.NODE_ENV === 'development';
  // An install's account comes from CLIPNEST_BOOTSTRAP_*; the development
  // seed is the fallback and, as it always has, takes any password (`test`).
  const fromInstall = Boolean(env.CLIPNEST_BOOTSTRAP_EMAIL || env.CLIPNEST_BOOTSTRAP_PASSWORD);
  const email = fromInstall ? env.CLIPNEST_BOOTSTRAP_EMAIL : (dev ? env.DEV_SEED_EMAIL : undefined);
  const password = fromInstall ? env.CLIPNEST_BOOTSTRAP_PASSWORD : (dev ? env.DEV_SEED_PASSWORD : undefined);
  if (!email || !password) {
    // Nothing to seed is fine for an edition with other ways to get an
    // account, unless the install set one value and forgot the other.
    if (!fromInstall && !account.fromConfig) return 'unset';
    if ((await getUserCount()) > 0) return 'missing';
    return { failed: account.fromConfig ?? 'set both the account e-mail and the account password' };
  }
  if ((await getUserCount()) > 0) return 'skipped';
  const r = await bootstrapFirstAccount({ email, password }, account, { allowWeakPassword: !fromInstall });
  if (r.ok) return 'created';
  if (r.reason === 'exists') return 'skipped';
  return { failed: r.message };
}

/**
 * What the API process makes of a seeding result: the line to log and whether
 * it may start (index.ts is the caller). Null ⇒ nothing worth a line.
 */
export function seedOutcome(
  seeded: SeedResult,
  account: FirstAccountSpec,
): { start: boolean; level: 'log' | 'warn' | 'error'; message: string } | null {
  if (seeded === 'created') return { start: true, level: 'log', message: 'First account created from environment' };
  if (seeded === 'missing') {
    return {
      start: true,
      level: 'warn',
      message: account.fromConfig
        ? `The account settings are missing or incomplete (${account.fromConfig}); the existing account keeps its e-mail and password`
        : 'Only one of CLIPNEST_BOOTSTRAP_EMAIL / CLIPNEST_BOOTSTRAP_PASSWORD is set; the existing accounts are unchanged',
    };
  }
  if (typeof seeded === 'object') {
    // Starting without the account the operator asked for would leave an
    // install nobody can sign in to — stop instead.
    return { start: false, level: 'error', message: `Refusing to start: the account could not be created — ${seeded.failed}` };
  }
  return null;
}

/**
 * Keep the install's account password equal to CLIPNEST_BOOTSTRAP_PASSWORD on
 * every start, for an edition whose account is defined by its configuration
 * rather than edited in the app: change the value, restart, done. Writes only
 * when the stored password differs, so an ordinary restart keeps every
 * session; an actual change signs all of them out.
 */
export async function syncAccountPasswordFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<'updated' | 'unchanged' | 'unset' | 'no_account' | { failed: string }> {
  const email = normalizeEmail(env.CLIPNEST_BOOTSTRAP_EMAIL);
  const password = env.CLIPNEST_BOOTSTRAP_PASSWORD;
  if (!email || !password) return 'unset';
  const user = await getUserByEmail(email);
  if (!user) return 'no_account';
  if (user.passwordHash && await verifyPassword(password, user.passwordHash)) return 'unchanged';
  const pwError = validatePasswordStrength(password);
  if (pwError) return { failed: pwError };
  // The operator changed it: lift every lockout of the account, the IP-wide
  // FTP ones included (on a single-account install they can only be its own
  // cameras' or an attacker's, and the old password is now worthless).
  await updateUserPasswordByInternalId(user.internalId, await hashPassword(password), { includeIpLocks: true });
  return 'updated';
}
