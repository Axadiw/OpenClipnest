import { sweepExpiredOauthRows } from '../db/queries/oauth.js';
import { deleteExpiredDeviceCodes } from '../db/queries/tvDeviceCodes.js';
import { deleteExpiredSessions } from '../db/queries/sessions.js';

export async function runOauthSweep(): Promise<{
  txns: number; codes: number; access: number; refresh: number; audit: number; tvDeviceCodes: number; sessions: number;
}> {
  const oauth = await sweepExpiredOauthRows();
  // Apple-TV device codes are tiny and short-lived (5-min TTL, single-use), but
  // abandoned codes would otherwise accumulate — sweep them on the same cadence
  // as the other expired auth artifacts.
  const tvDeviceCodes = await deleteExpiredDeviceCodes();
  // Device sessions whose refresh token has run out (see user_sessions).
  const sessions = await deleteExpiredSessions();
  return { ...oauth, tvDeviceCodes, sessions };
}

// Allow running as a script: `node dist/scripts/oauthSweep.js`
if (process.argv[1] && process.argv[1].endsWith('oauthSweep.js')) {
  const { initDb } = await import('../db/index.js');
  await initDb();
  const c = await runOauthSweep();
  console.log('oauth-sweep counts', c);
  process.exit(0);
}
