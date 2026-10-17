#!/usr/bin/env node
/**
 * CLI: set a new password for an existing account from the server console.
 *
 * Usage (inside the API container, which has DATABASE_URL set):
 *   node dist/scripts/reset-password.js <email>
 *
 * The password is read from CLIPNEST_NEW_PASSWORD when set, otherwise
 * prompted on stdin with echo suppressed. This is the recovery path for an
 * edition without email (self-hosted has no /forgot-password): whoever can
 * exec into the container owns the install anyway. Bumps the account's token
 * generation, so every existing session is signed out.
 *
 * Exit codes: 2 no DB config · 3 passwords differ · 4 weak password ·
 * 6 no such account.
 */
import { CONFIG } from '../config.js';
import { validatePasswordStrength, hashPassword } from '../services/auth.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';
import { passwordFromEnvOrPrompt } from './lib/prompt.js';

function parseArgs(argv: string[]): { email: string } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const email = positional.length === 1 ? normalizeEmail(positional[0]) : null;
  if (!email) throw new Error('Usage: reset-password <email>');
  return { email };
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));

  if (!CONFIG.databaseUrl) {
    console.error('CONFIG.databaseUrl is empty — env not initialized');
    process.exit(2);
  }

  const password = await passwordFromEnvOrPrompt('CLIPNEST_NEW_PASSWORD', `New password for ${email}`);
  const pwError = validatePasswordStrength(password);
  if (pwError) {
    console.error(pwError);
    process.exit(4);
  }

  const { initDb } = await import('../db/index.js');
  const { getUserByEmail, updateUserPasswordByInternalId } = await import('../db/queries/users.js');
  await initDb();

  const user = await getUserByEmail(email);
  if (!user) {
    console.error(`No account with email "${email}"`);
    process.exit(6);
  }
  // Bumps token_generation as a side effect — all sessions are signed out.
  await updateUserPasswordByInternalId(user.internalId, await hashPassword(password));
  console.log(`Password updated for "${email}"; all existing sessions were signed out`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`reset-password FAILED: ${msg}\n`);
  process.exit(1);
});
