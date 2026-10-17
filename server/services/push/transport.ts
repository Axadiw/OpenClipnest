// server/services/push/transport.ts — the installed push transport.
import type { PushTransport } from './types.js';
import { createRelayTransport, relayUrlFromEnv } from './relayTransport.js';

let installed: PushTransport | null = null;

/** Installed by `installEdition()`; undefined ⇒ the relay transport from env. */
export function installPushTransport(transport: PushTransport | undefined): void {
  installed = transport ?? createRelayTransport(relayUrlFromEnv());
}

export function pushTransport(): PushTransport {
  return installed ?? (installed = createRelayTransport(relayUrlFromEnv()));
}
