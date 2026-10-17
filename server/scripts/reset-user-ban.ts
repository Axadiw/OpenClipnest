#!/usr/bin/env node
/**
 * CLI: lift every ban and login lockout on an account.
 *
 * Usage (inside the API container, which has the database settings):
 *   node dist/scripts/reset-user-ban.js <email>
 *   docker compose exec clipnest-api node dist/scripts/reset-user-ban.js <email>
 *
 * Cancels the account's active bans — manual bans, lockouts of the web
 * sign-in and of FTP logins, and IP-wide FTP lockouts attached to it — and
 * resets the failed-login counters and lockout tiers of both login channels.
 *
 * Exits 0 on success (also when there was nothing to lift), 2 on a usage or
 * configuration error, 3 when no account has that e-mail, 1 on any other
 * failure.
 */
import { CONFIG } from '../config.js';

const USAGE = [
  'Usage: node dist/scripts/reset-user-ban.js <email>',
  '',
  'Lifts every ban and login lockout of the account with this e-mail: the web',
  'sign-in and FTP lockouts (including IP-wide FTP lockouts attached to it)',
  'and manual bans, and resets the failed-login counters of both logins.',
].join('\n');

/** Lift every ban of `email`'s account; null when there is no such account. */
export async function resetUserBan(email: string): Promise<{ cancelled: number; uuid: string } | null> {
  const { getUserByEmail } = await import('../db/queries/users.js');
  const { cancelAllActiveBansForUser } = await import('../db/queries/lockout.js');
  const user = await getUserByEmail(email);
  if (!user) return null;
  return { cancelled: await cancelAllActiveBansForUser(user.internalId), uuid: user.id };
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email || email === '--help' || email === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  // Use CONFIG.databaseUrl — DATABASE_URL may be a bare host:port/db, and
  // config.ts is what stitches the postgresql:// scheme + credentials.
  if (!CONFIG.databaseUrl) {
    console.error('CONFIG.databaseUrl is empty — env not initialized');
    process.exit(2);
  }

  const db = await import('../db/index.js');
  await db.initDb();
  try {
    const result = await resetUserBan(email);
    if (!result) {
      console.error(`User "${email}" not found`);
      process.exitCode = 3;
      return;
    }
    console.log(
      `Cleared ${result.cancelled} active ban(s) and reset the failed-login counters for ${email} (uuid=${result.uuid})`,
    );
  } finally {
    await db.pool.end();
  }
}

// Run only when executed as a script (not when a test imports resetUserBan).
if (/reset-user-ban\.[jt]s$/.test(process.argv[1] ?? '')) {
  process.stdout.write('reset-user-ban: starting\n');
  main().catch((err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stdout.write(`reset-user-ban FAILED: ${msg}\n`);
    process.exit(1);
  });
}
