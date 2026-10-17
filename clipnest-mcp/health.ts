import type { Express } from 'express';

export interface HealthDeps {
  pingDb: () => Promise<void>;
  pingRedis: () => Promise<void>;
}

export function mountHealth(app: Express, deps: HealthDeps): void {
  app.get('/healthz', async (_req, res) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    let redisStatus: 'ok' | 'error' = 'ok';
    try { await deps.pingDb(); } catch { dbStatus = 'error'; }
    try { await deps.pingRedis(); } catch { redisStatus = 'error'; }
    const ok = dbStatus === 'ok' && redisStatus === 'ok';
    res.status(ok ? 200 : 503).json({ db: dbStatus, redis: redisStatus });
  });
}
