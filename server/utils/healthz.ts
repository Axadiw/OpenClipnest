import http from 'http';
import { pingDb } from '../db/index.js';
import { metricsRecorder } from './metrics.js';
import { getRedis } from './redis.js';

// Minimal /healthz endpoint used by k8s liveness + readiness probes on the
// standalone worker entrypoints (event-manager, thumbnail-worker). The API
// service already has an Express instance so it exposes /healthz there.
//
// Returns 200 only when Redis + Postgres round-trip AND the optional
// service-supplied check passes. A 503 tells the kubelet to stop routing
// traffic / restart the pod — which is exactly how the thumbnail worker
// recovers from a wedged S3 socket pool (counts consecutive connect-timeouts;
// past a threshold the check flips and k8s restarts the pod with a fresh
// https.Agent).
export type HealthCheck = () => { ok: boolean; reason?: string };

export function startHealthzServer(
  port: number,
  serviceName: string,
  extraCheck?: HealthCheck,
): http.Server {
  const server = http.createServer(async (req, res) => {
    // A scraping edition (Clipnest Cloud: Prometheus) reads the worker on this
    // same port. Counters only count in the process that runs the call site,
    // and the thumbnail worker owns a delete path the API never sees
    // (delete-notify from FTPS/S3), so without this those deletions would
    // simply be absent from the metrics. Unauthenticated exactly like the
    // API's /metrics: cluster-internal only, admitted by an explicit
    // NetworkPolicy, never routed through the ingress. An edition without a
    // renderer (self-hosted) answers 404 here.
    if (req.url === '/metrics') {
      const render = metricsRecorder().render;
      if (!render) {
        res.writeHead(404);
        res.end();
        return;
      }
      const { contentType, body } = await render();
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
      return;
    }

    if (req.url !== '/healthz') {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const redis = getRedis();
      await Promise.all([redis.ping(), pingDb()]);
      const extra = extraCheck ? extraCheck() : { ok: true };
      if (!extra.ok) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', service: serviceName, reason: extra.reason ?? 'check failed' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: serviceName }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'unhealthy', service: serviceName, error: msg }));
    }
  });

  server.listen(port, () => {
    console.log(`${serviceName}: /healthz listening on :${port}`);
  });

  return server;
}
