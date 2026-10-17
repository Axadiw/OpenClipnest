#!/usr/bin/env node
/**
 * CLI: reset a user's storage and/or transfer quota counters.
 *
 * Usage (inside the clipnest-api container, which has DATABASE_URL set):
 *   node dist/scripts/reset-user-quota.js <email> [--storage] [--transfer]
 *
 * With no flags: resets both. Exits 0 on success, non-zero on any error.
 * Used by the CD smoke pre-step since the runner has no admin JWT.
 */
import { CONFIG } from '../config.js';

process.stdout.write('reset-user-quota: starting\n');

function parseArgs(argv: string[]): { email: string; storage: boolean; transfer: boolean } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  if (positional.length !== 1) {
    throw new Error('Usage: reset-user-quota <email> [--storage] [--transfer]');
  }
  const hasExplicit = flags.has('--storage') || flags.has('--transfer');
  return {
    email: positional[0],
    storage: hasExplicit ? flags.has('--storage') : true,
    transfer: hasExplicit ? flags.has('--transfer') : true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Use CONFIG.databaseUrl — on prod the env var is bare host:port/db form
  // and config.ts is what stitches the postgresql:// scheme + credentials.
  if (!CONFIG.databaseUrl) {
    console.error('CONFIG.databaseUrl is empty — env not initialized');
    process.exit(2);
  }

  const { initDb } = await import('../db/index.js');
  const { getUserByEmail, resetUserQuota } = await import('../db/queries/users.js');
  await initDb();

  const user = await getUserByEmail(args.email);
  if (!user) {
    console.error(`User "${args.email}" not found`);
    process.exit(3);
  }
  const uuid = user.id;

  if (!args.storage && !args.transfer) {
    console.error('Nothing to reset (both --storage and --transfer disabled)');
    process.exit(4);
  }

  await resetUserQuota(uuid, { storage: args.storage, transfer: args.transfer });
  console.log(
    `Reset quota for ${args.email} (uuid=${uuid}): storage=${args.storage}, transfer=${args.transfer}`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stdout.write(`reset-user-quota FAILED: ${msg}\n`);
  process.exit(1);
});
