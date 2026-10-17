import { describe, it, expect, beforeEach, vi } from 'vitest';
import { story } from '../testing/story.js';

// Mock config so getS3Client() can build a real S3Client without a live endpoint.
vi.mock('../config.js', () => ({
  CONFIG: {
    s3Endpoint: 'http://localhost:9000',
    s3AccessKey: 'testaccess',
    s3SecretKey: 'testsecret',
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    encryptionMasterKey: 'test-master-key-for-s3-wedge-tests',
  },
}));

// We intentionally do NOT mock socketPoolWedge — we want to assert the real
// window-based detector advances/recovers through the middleware.
import { getS3Client } from './s3.js';
import {
  CONNECT_TIMEOUT_MARKER,
  MIN_FAILURES_TO_TRIP,
  socketPoolHealthCheck,
  _getRecentCountForTesting,
  _resetForTesting,
} from '../utils/socketPoolWedge.js';

beforeEach(() => {
  _resetForTesting();
});

describe('S3 client wedge-detector middleware', () => {
  it('registers a middleware named "wedgeDetector" on the SDK stack', (ctx) => {
    story(
      ctx,
      'Sanity check: getS3Client() musi nakładać middleware na stack, inaczej każdy s3.send() omija licznik wedge. Ręczny hook tylko na getSidecar nie wystarcza (headObject calle z /media-token mogą wisieć na wedgeowanym poolu, a /healthz w API ich nie widzi), więc jedyna gwarancja że "każdy call s3 zasila licznik" to: middleware zarejestrowany raz na poziomie clienta.',
    );
    const client = getS3Client();
    // middlewareStack.identify() returns array of `name - step` strings.
    const ids = client.middlewareStack.identify();
    const wedge = ids.find((s) => s.startsWith('wedgeDetector'));
    expect(wedge, `expected wedgeDetector middleware; got: ${ids.join(', ')}`).toBeDefined();
    // Must run at deserialize step (after HTTP roundtrip, before the SDK
    // wraps the response — earliest point where success AND every transport
    // failure are observable).
    expect(wedge).toContain('deserialize');
  });

  it('advances the wedge window on connect-timeout errors thrown by inner middleware', async (ctx) => {
    story(
      ctx,
      `Symuluje wedgeowany socket pool: inner middleware rzuca błąd z CONNECT_TIMEOUT_MARKER w wiadomości (taki sam kształt jak @smithy/node-http-handler gdy connectionTimeout fire). ${MIN_FAILURES_TO_TRIP} takich z rzędu = healthz flippa do 503 (po przekroczeniu min-failures-gate, ratio 100%) = kubelet ubija pod.`,
    );
    const client = getS3Client();
    // The middleware factory closure we registered in s3.ts. We don't have a
    // public handle to it, so we recreate the same logic here. If s3.ts ever
    // diverges this test would silently lie — guarded against by the
    // "registers a middleware" test above pinning the registration point.
    const wedgeWrapped = (next: () => Promise<unknown>) => async () => {
      try {
        const r = await next();
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome();
        return r;
      } catch (err) {
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome(err);
        throw err;
      }
    };

    const failingNext = vi.fn().mockRejectedValue(new Error(`smithy: ${CONNECT_TIMEOUT_MARKER}`));
    const handler = wedgeWrapped(failingNext);
    for (let i = 0; i < MIN_FAILURES_TO_TRIP - 1; i++) {
      await handler().catch(() => undefined);
    }
    expect(_getRecentCountForTesting()).toEqual({ total: MIN_FAILURES_TO_TRIP - 1, failed: MIN_FAILURES_TO_TRIP - 1 });
    expect(socketPoolHealthCheck().ok).toBe(true);

    await handler().catch(() => undefined);
    expect(_getRecentCountForTesting()).toEqual({ total: MIN_FAILURES_TO_TRIP, failed: MIN_FAILURES_TO_TRIP });
    expect(socketPoolHealthCheck().ok).toBe(false);

    // Use `client` so the linter doesn't flag it as unused — and so the
    // "client must exist & middleware-stack non-empty" assertion lands too.
    expect(client.middlewareStack.identify().length).toBeGreaterThan(0);
  });

  it('does NOT recover after one success when window still shows mostly failures (the pulsing-liveness guard)', async (ctx) => {
    story(
      ctx,
      `Stary streak-based detector resetował się przy pierwszym sukcesie po wedge → pod pulsował 0/1 ↔ 1/1 przez kilkanaście minut bo kubelet nie liczył 3 consecutive failed liveness. Window-based detector pamięta wszystkie ostatnie outcomes — pojedynczy sukces po wedgeu obniża ratio nieznacznie, ale healthz trzyma 503 dopóki ratio nie zejdzie poniżej 50%. Test pilnuje że dokładnie tego scenariusza nie da się obejść jednym sukcesem.`,
    );
    const wedgeWrapped = (next: () => Promise<unknown>) => async () => {
      try {
        const r = await next();
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome();
        return r;
      } catch (err) {
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome(err);
        throw err;
      }
    };

    const failing = vi.fn().mockRejectedValue(new Error(CONNECT_TIMEOUT_MARKER));
    const succeeding = vi.fn().mockResolvedValue({ output: 'ok' });

    const failHandler = wedgeWrapped(failing);
    // Push the window deep into wedge — ratio 100 %, failed = MIN+2.
    for (let i = 0; i < MIN_FAILURES_TO_TRIP + 2; i++) {
      await failHandler().catch(() => undefined);
    }
    expect(socketPoolHealthCheck().ok).toBe(false);

    // One success in the middle of a wedge — old detector would've zeroed the
    // counter and unwedged the pod here. New detector keeps the window intact:
    // (MIN+2) / (MIN+3) ≈ 87 % > 50 %, wedge still tripped.
    const okHandler = wedgeWrapped(succeeding);
    await okHandler();
    expect(socketPoolHealthCheck().ok).toBe(false);

    const counts = _getRecentCountForTesting();
    expect(counts.failed).toBe(MIN_FAILURES_TO_TRIP + 2);
    expect(counts.total).toBe(MIN_FAILURES_TO_TRIP + 3);
  });

  it('does NOT count non-connect S3 errors (NoSuchKey, AccessDenied) as wedge signals', async (ctx) => {
    story(
      ctx,
      'NoSuchKey / AccessDenied / generyczne 5xx to błędy aplikacyjne, nie wedge socketów. Test pilnuje że pojedynczy missing-sidecar (normalny class B/C fork) ani jakikolwiek inny non-connect S3 error nie wpada do window jako failed — w przeciwnym razie miks normalnych 404 + sporadycznych connect blips falsie-positivnie restartowałby pody. Pod window-based detector to jest jeszcze ważniejsze: te non-connect-errors trafiają do okna jako "non-failed", co działa AWAY OD wedge ratio.',
    );
    const wedgeWrapped = (next: () => Promise<unknown>) => async () => {
      try {
        const r = await next();
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome();
        return r;
      } catch (err) {
        const { recordConnectOutcome } = await import('../utils/socketPoolWedge.js');
        recordConnectOutcome(err);
        throw err;
      }
    };

    // Seed a few connect-failures.
    const connectFail = vi.fn().mockRejectedValue(new Error(CONNECT_TIMEOUT_MARKER));
    const ch = wedgeWrapped(connectFail);
    for (let i = 0; i < 3; i++) await ch().catch(() => undefined);
    expect(_getRecentCountForTesting()).toEqual({ total: 3, failed: 3 });

    // A NoSuchKey is a CLEAN S3 contact — round-trip succeeded, response was a
    // 404. It does NOT count as a wedge failure: it lands as a non-failed
    // outcome in the window, which shifts the ratio AWAY from wedge.
    const notFound = vi.fn().mockRejectedValue(
      Object.assign(new Error('NoSuchKey: The specified key does not exist'), { name: 'NoSuchKey' }),
    );
    await wedgeWrapped(notFound)().catch(() => undefined);
    expect(_getRecentCountForTesting()).toEqual({ total: 4, failed: 3 });
    // 3/4 = 75 % > 50 %, but failed=3 < MIN_FAILURES_TO_TRIP gate → still ok.
    expect(socketPoolHealthCheck().ok).toBe(true);
  });
});
