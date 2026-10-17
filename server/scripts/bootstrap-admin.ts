#!/usr/bin/env node
/**
 * CLI: create the very first account on a fresh Clipnest deployment.
 *
 * Usage (inside the API container, which has DATABASE_URL set):
 *   node dist/scripts/bootstrap-admin.js <email>
 *
 * The password is read from CLIPNEST_BOOTSTRAP_PASSWORD when set (scripted
 * installs), otherwise prompted on stdin with echo suppressed. The account's
 * role comes from the edition: Clipnest Cloud creates an operator (admin);
 * a self-hosted install creates its single owner. It refuses to run once the
 * users table is non-empty — a single-shot guard in an advisory-locked
 * transaction. There is deliberately no HTTP equivalent: an unauthenticated
 * setup route on a freshly deployed instance is an account-takeover surface.
 *
 * Exit codes: 2 no DB config · 3 passwords differ · 4 weak password/bad email ·
 * 5 database already has users.
 */
import { CONFIG } from '../config.js';
import { passwordFromEnvOrPrompt } from './lib/prompt.js';

function parseArgs(argv: string[]): { email: string } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    throw new Error('Usage: bootstrap-admin <email>');
  }
  return { email: positional[0] };
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));

  if (!CONFIG.databaseUrl) {
    console.error('CONFIG.databaseUrl is empty — env not initialized');
    process.exit(2);
  }

  const password = await passwordFromEnvOrPrompt('CLIPNEST_BOOTSTRAP_PASSWORD', `Password for ${email}`);

  const { initDb } = await import('../db/index.js');
  const { bootstrapFirstAccount } = await import('../services/bootstrap.js');
  const { edition } = await import('../edition.js');
  await initDb();

  const result = await bootstrapFirstAccount({ email, password }, edition.firstAccount);
  if (!result.ok) {
    console.error(result.message);
    process.exit(result.reason === 'exists' ? 5 : 4);
  }
  console.log(`${edition.firstAccount.isAdmin ? 'Admin' : 'Owner'} account "${result.email}" created`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`bootstrap-admin FAILED: ${msg}\n`);
  process.exit(1);
});
