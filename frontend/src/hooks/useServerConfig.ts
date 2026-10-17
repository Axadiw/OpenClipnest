import { useEffect, useState } from 'react';
import { api, type ServerConfig } from '../api';

// GET /api/v0/config is static per deployment — fetch once per page load and
// share the promise between every hook instance.
let cached: Promise<ServerConfig> | null = null;

/** The server's edition/feature/FTPS description, or null until loaded (or on failure). */
export function useServerConfig(): ServerConfig | null {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    cached ??= api.getConfig();
    cached.then((c) => { if (!cancelled) setConfig(c); }).catch(() => { cached = null; });
    return () => { cancelled = true; };
  }, []);
  return config;
}
