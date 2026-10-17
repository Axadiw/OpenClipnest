// server/utils/internalApiKey.ts
//
// Kept out of config.ts so that tests which mock config.js do not have to
// re-export it: installConfig.ts reads it at startup in every service.
import { readFileSync } from 'node:fs';

/**
 * The key the services present to each other on /internal. Taken from
 * CLIPNEST_INTERNAL_API_KEY when it is set; otherwise read from the file named
 * by CLIPNEST_INTERNAL_API_KEY_FILE (the self-hosted install generates one on
 * first start, so its users never have to). Empty when neither is available,
 * which makes /internal refuse every caller.
 */
export function internalApiKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  if (env.CLIPNEST_INTERNAL_API_KEY) return env.CLIPNEST_INTERNAL_API_KEY;
  if (!env.CLIPNEST_INTERNAL_API_KEY_FILE) return '';
  return readFile(env.CLIPNEST_INTERNAL_API_KEY_FILE).trim();
}
