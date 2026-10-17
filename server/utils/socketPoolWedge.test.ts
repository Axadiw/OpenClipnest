import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { story } from '../testing/story.js';
import {
  CONNECT_TIMEOUT_MARKER,
  MIN_FAILURES_TO_TRIP,
  WEDGE_FAILURE_RATIO,
  WINDOW_MS,
  recordConnectOutcome,
  socketPoolHealthCheck,
  _getRecentCountForTesting,
  _resetForTesting,
} from './socketPoolWedge.js';

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('socketPoolWedge — recordConnectOutcome window behaviour', () => {
  it('starts empty and stays empty on consecutive successes', (ctx) => {
    story(
      ctx,
      'Pod, który grzecznie obsługuje S3, nie może dryfować w kierunku 503-na-healthz. Każdy udany call (`undefined` outcome) wpada do window jako non-failed — ratio failed/total = 0 — healthz dalej ok.',
    );
    for (let i = 0; i < 50; i++) recordConnectOutcome();
    const { total, failed } = _getRecentCountForTesting();
    expect(total).toBe(50);
    expect(failed).toBe(0);
    expect(socketPoolHealthCheck()).toEqual({ ok: true });
  });

  it('counts only the connect-timeout marker as failed, not other errors', (ctx) => {
    story(
      ctx,
      'Wedge detector ma działać tylko gdy widać KONKRETNY wzorzec — connect-timeouty z @smithy/node-http-handler. Generyczne S3 błędy (NoSuchKey, AccessDenied, transient 500) wpadają do window jako non-failed i działają tak samo jak sukcesy: shiftują ratio AWAY od wedge, nie wpychają poda w restart-loop.',
    );
    recordConnectOutcome(new Error('NoSuchKey: The specified key does not exist'));
    recordConnectOutcome(new Error('AccessDenied: not authorized'));
    recordConnectOutcome(new Error('InternalError: please retry'));
    expect(_getRecentCountForTesting()).toEqual({ total: 3, failed: 0 });

    recordConnectOutcome(new Error(`AWS SDK: ${CONNECT_TIMEOUT_MARKER}`));
    expect(_getRecentCountForTesting()).toEqual({ total: 4, failed: 1 });

    recordConnectOutcome(new Error(`Different prefix — ${CONNECT_TIMEOUT_MARKER} — different suffix`));
    expect(_getRecentCountForTesting()).toEqual({ total: 5, failed: 2 });
  });

  it('does NOT reset failed count on a single intermediate success (the old streak-based bug)', (ctx) => {
    story(
      ctx,
      'Ta sytuacja zrestartowała stary streak-based detector: pool pulsował między success i fail, pojedynczy success w środku obniżał counter do 0, /healthz nigdy nie stabilizował się na 503, kubelet nigdy nie liczył 3 consecutive failures → pod siedział 0/1 NotReady przez kilkanaście minut serwując 5xx. Window-based detector pamięta wszystkie outcomes w ostatnich 30s — pojedynczy success obniża ratio nieznacznie, ale nie kasuje historii.',
    );
    for (let i = 0; i < 7; i++) recordConnectOutcome(new Error(`x ${CONNECT_TIMEOUT_MARKER} y`));
    recordConnectOutcome(); // ONE success in the middle of a wedge — irrelevant
    for (let i = 0; i < 3; i++) recordConnectOutcome(new Error(`x ${CONNECT_TIMEOUT_MARKER} y`));

    const { total, failed } = _getRecentCountForTesting();
    expect(total).toBe(11);
    expect(failed).toBe(10);
    // 10/11 ≈ 91 % > 50 % AND 10 ≥ MIN_FAILURES_TO_TRIP → wedge tripped despite the intermediate success.
    expect(socketPoolHealthCheck().ok).toBe(false);
  });

  it('accepts string-shaped errors (not just Error instances)', (ctx) => {
    story(
      ctx,
      'Niektóre warstwy (Smithy middleware, raw fetch w fallbackach) rzucają stringi zamiast Error. Detektor musi je obsłużyć, w przeciwnym razie wedge umknie tej części kodu.',
    );
    recordConnectOutcome(`raw: ${CONNECT_TIMEOUT_MARKER} from middleware`);
    expect(_getRecentCountForTesting()).toEqual({ total: 1, failed: 1 });
  });
});

describe('socketPoolWedge — socketPoolHealthCheck wedge ratio + min-failures gate', () => {
  it('stays ok until both gates are crossed', (ctx) => {
    story(
      ctx,
      `Wedge wymaga ≥${MIN_FAILURES_TO_TRIP} timeoutów w window oraz failure-ratio > ${(WEDGE_FAILURE_RATIO * 100).toFixed(0)}%. Pojedyncze timeouty w morzu sukcesów (np. blip load-balancer co kilka minut) NIE wywalają poda — to celowo, single failure to nie wedge.`,
    );
    // 4 failures, 0 successes — ratio 100 % but FAILED < MIN_FAILURES_TO_TRIP.
    for (let i = 0; i < MIN_FAILURES_TO_TRIP - 1; i++) {
      recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
    }
    expect(socketPoolHealthCheck().ok).toBe(true);

    // 1 more failure — now at threshold AND ratio still 100 % → wedge.
    recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
    const r = socketPoolHealthCheck();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`${MIN_FAILURES_TO_TRIP}/${MIN_FAILURES_TO_TRIP}`);
    expect(r.reason).toContain('socket pool wedged');
  });

  it('does NOT trip when ratio is exactly 50 % (strict >, not >=)', (ctx) => {
    story(
      ctx,
      'Dokładnie 50/50 oznacza, że pool sobie radzi w połowie — to nie jest "wedge", to obciążony pool ale działający. Wymóg strict > 50 % daje pułapowi mały bufor zanim flipniemy poda.',
    );
    for (let i = 0; i < MIN_FAILURES_TO_TRIP; i++) {
      recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
      recordConnectOutcome(); // 1:1 balance
    }
    const { total, failed } = _getRecentCountForTesting();
    expect(total).toBe(MIN_FAILURES_TO_TRIP * 2);
    expect(failed).toBe(MIN_FAILURES_TO_TRIP);
    expect(socketPoolHealthCheck().ok).toBe(true);

    // One more failure tips us past 50 %.
    recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
    expect(socketPoolHealthCheck().ok).toBe(false);
  });

  it('recovers automatically after the window ages out — no successful S3 call required', (ctx) => {
    story(
      ctx,
      `Stary detector wymagał chociaż jednego successful s3.send() żeby się zresetować, co utrzymywało wedge zafirezone po przejściu burst-u. Window-based ages out: po ${WINDOW_MS}ms wszystkie wpisy wypadają z okna, ratio "no data" = ok, healthz znowu 200. Real-time clock symulujemy żeby test był deterministyczny.`,
    );
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    for (let i = 0; i < MIN_FAILURES_TO_TRIP + 3; i++) {
      recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
    }
    expect(socketPoolHealthCheck().ok).toBe(false);

    // Advance past the window — no new outcomes, nothing recorded.
    vi.setSystemTime(t0 + WINDOW_MS + 1);
    expect(socketPoolHealthCheck().ok).toBe(true);
    expect(_getRecentCountForTesting()).toEqual({ total: 0, failed: 0 });
  });

  it('recovers immediately after a fresh-pod restart (no history)', (ctx) => {
    story(
      ctx,
      'Po restarcie poda fresh pool ma pustą historię. Pierwszy call (success lub fail) NIE może od razu trzymać poda w 503, bo kubelet ubije świeży pod zanim Express zacznie serwować. Z window=0 → ok. Z window=1-success → ok. Z window=1-fail → ok (1 < MIN_FAILURES_TO_TRIP).',
    );
    expect(socketPoolHealthCheck().ok).toBe(true);

    recordConnectOutcome(); // first call: success
    expect(socketPoolHealthCheck().ok).toBe(true);

    _resetForTesting();
    recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER)); // first call: connect-timeout
    expect(socketPoolHealthCheck().ok).toBe(true);
    expect(_getRecentCountForTesting()).toEqual({ total: 1, failed: 1 });
  });

  it('window ages out a mid-wedge entry once it crosses the boundary', (ctx) => {
    story(
      ctx,
      'Wedge detection działa CIĄGLE — gdy najstarsze failure wypadnie z window-a, denominator i numerator obniżają się, ratio może zejść poniżej progu i pod znów jest ok. To pozwala detectorowi się odzyskiwać w miarę jak nowsze (zdrowe) calle się akumulują — bez restartu jeśli wedge sam minie.',
    );
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    for (let i = 0; i < MIN_FAILURES_TO_TRIP + 3; i++) {
      recordConnectOutcome(new Error(CONNECT_TIMEOUT_MARKER));
    }
    expect(socketPoolHealthCheck().ok).toBe(false);

    // Wedge passes — for the next 31s the pool only sees successes.
    for (let dt = 1000; dt <= WINDOW_MS + 1000; dt += 1000) {
      vi.setSystemTime(t0 + dt);
      recordConnectOutcome();
    }

    expect(socketPoolHealthCheck().ok).toBe(true);
    const { failed } = _getRecentCountForTesting();
    expect(failed).toBe(0);
  });
});
