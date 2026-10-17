// server/editions/selfhost.ts
//
// The self-hosted edition: the shared core and nothing else. This file is
// shared code; `server/edition.ts` selects it in the OpenClipnest repo.
import type { ServerExtensions } from '../extensions.js';
import { relayUrlFromEnv } from '../services/push/relayTransport.js';
import { assertSecretsConfigured, applyConfiguredDiskLimit, parseDiskLimit } from '../services/installConfig.js';
import { syncAccountPasswordFromEnv } from '../services/bootstrap.js';

export const edition: ServerExtensions = {
  name: 'selfhost',
  features: {
    registration: false,
    passkeys: false,
    oauthGoogle: false,
    oauthApple: false,
    // Delivered through the Clipnest push relay, when one is configured.
    push: relayUrlFromEnv() !== null,
    mcp: true,
  },
  // The one account is both operator and owner; no plan ⇒ unlimited. It comes
  // only from the configuration, so an empty database without it stops the
  // server instead of starting one nobody can sign in to.
  firstAccount: { isAdmin: false, planName: null, fromConfig: 'set ACCOUNT_EMAIL and ACCOUNT_PASSWORD in .env' },
  routers: [],
  // The operator defines every secret; nothing is generated. A typo in the
  // disk limit is caught here too, before the database is touched.
  preflight: () => {
    assertSecretsConfigured();
    parseDiskLimit(process.env.CLIPNEST_DISK_LIMIT);
  },
  // The account password and the optional disk limit come from the compose
  // configuration and are re-read on every start.
  onStart: async () => {
    const synced = await syncAccountPasswordFromEnv();
    if (typeof synced === 'object') throw new Error(`Refusing to start: the account password was not applied — ${synced.failed}`);
    if (synced === 'updated') console.log('Account password updated from the configuration; all sessions were signed out');
    if (synced === 'no_account') console.warn('No account matches the configured account e-mail; the configured password was not applied');
    const limit = await applyConfiguredDiskLimit();
    console.log(limit === null ? 'Disk limit: none' : `Disk limit: ${limit} bytes`);
  },
};
