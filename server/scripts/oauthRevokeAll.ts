import { revokeAllOauth, type RevokeAllOpts } from '../db/queries/oauth.js';

export type { RevokeAllOpts };

export async function revokeAll(opts: RevokeAllOpts): Promise<{ access: number; refresh: number; clients: number }> {
  return revokeAllOauth(opts);
}

if (process.argv[1] && process.argv[1].endsWith('oauthRevokeAll.js')) {
  const opts: RevokeAllOpts = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--user=')) opts.userId = Number(a.split('=')[1]);
    else if (a.startsWith('--client=')) opts.clientId = a.split('=')[1];
    else if (a === '--confirm-all') { /* accepted, handled below */ }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  if (opts.userId === undefined && opts.clientId === undefined && !process.argv.includes('--confirm-all')) {
    console.error('No --user or --client filter given. This would revoke EVERY token + EVERY client for ALL users.');
    console.error('If that is intentional (incident response), pass --confirm-all explicitly.');
    process.exit(2);
  }
  const { initDb } = await import('../db/index.js');
  await initDb();
  const r = await revokeAll(opts);
  console.log('revoked', JSON.stringify(r));
  process.exit(0);
}
