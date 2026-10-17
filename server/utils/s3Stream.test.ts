import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough, Readable, Writable } from 'stream';
import { story } from '../testing/story.js';
import {
  pipeS3ToResponse,
  pipeS3IntoSink,
  pipeThrottleToResponse,
  attachSlowConsumerMonitor,
  SLOW_CONSUMER_GRACE_MS,
  SLOW_CONSUMER_CHECK_INTERVAL_MS,
  SLOW_CONSUMER_CONSECUTIVE_CHECKS,
} from './s3Stream.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Build a Readable that emits 64 KiB chunks asynchronously (one chunk per
 * `setImmediate` tick) and only stops when explicitly destroyed. Async
 * scheduling matters: a synchronous `this.push()` loop would starve the
 * event loop and prevent the test's assertion from firing.
 *
 * Stands in for the smithy IncomingMessage returned by S3 GetObject for a
 * large video — production clients abort mid-stream long before EOF.
 */
function makeInfiniteBody(): Readable {
  const r: Readable = new Readable({
    read() {
      setImmediate(() => {
        if (!r.destroyed) r.push(Buffer.alloc(64 * 1024, 1));
      });
    },
  });
  return r;
}

/** Drain at least one chunk so the test observes data starting to flow. */
function awaitFirstChunk(s: Readable | Writable): Promise<void> {
  return new Promise((resolve) => {
    s.once('data', () => resolve());
  });
}

/**
 * Wait for `promise` to settle, but give up after `ms`. The leak scenario
 * NEVER resolves (body.on('end') is never reached because `.pipe()` does
 * not propagate destination death back to the source), so without this
 * guard the test would hang forever. The assertion that follows checks
 * the real invariant (`body.destroyed`), so a timed-out wait is fine.
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    promise.then(finish, finish);
    setTimeout(finish, ms).unref();
  });
}

/**
 * Clean up an `makeInfiniteBody` Readable that the helper-under-test failed
 * to destroy. Without this, a leaked body keeps `setImmediate`-pumping
 * across test boundaries and the vitest worker never exits.
 */
function cleanupLeakedBody(body: Readable): void {
  if (!body.destroyed) body.destroy();
}

describe('pipeS3ToResponse — socket lifecycle', () => {
  it('destroys the S3 body when the client aborts mid-stream (no throttle)', async (ctx) => {
    story(
      ctx,
      'Każdy abort klienta (Chrome scrub, mobile drop, zmiana karty) MUSI zniszczyć Readable z S3, bo inaczej @smithy/node-http-handler trzyma TCP socket jako in-use aż do socketTimeout (10 s). Sustained leak rate wyczerpuje pulę 500 slotów i wszystkie kolejne s3.send() lecą na connectionTimeout — to jest dokładnie wedge, który zaobserwowaliśmy 2026-05-15.',
    );
    const body = makeInfiniteBody();
    const res = new PassThrough();
    res.on('data', () => {}); // keep res in flowing mode

    const done = pipeS3ToResponse(body, res).catch(() => null);
    await awaitFirstChunk(res);
    res.destroy(); // simulate Chrome aborting the request
    await settleWithin(done, 200);

    const wasDestroyed = body.destroyed;
    cleanupLeakedBody(body);
    expect(wasDestroyed).toBe(true);
  });

  it('destroys the S3 body when the client aborts mid-stream (with throttle)', async (ctx) => {
    story(
      ctx,
      'Wariant z throttle (quota soft-throttling) ma identyczny kontrakt — abort klienta zwija cały łańcuch, w tym S3 Readable. Bez tego user na rate-limicie wycieka soket przy każdym zerwanym video.',
    );
    const body = makeInfiniteBody();
    const throttle = new PassThrough();
    const res = new PassThrough();
    res.on('data', () => {});

    const done = pipeS3ToResponse(body, res, throttle).catch(() => null);
    await awaitFirstChunk(res);
    res.destroy();
    await settleWithin(done, 200);

    const wasDestroyed = body.destroyed;
    cleanupLeakedBody(body);
    expect(wasDestroyed).toBe(true);
  });

  it('removes the pipeline lifecycle listeners from res after a clean settle', async (ctx) => {
    story(
      ctx,
      'stream/promises pipeline zostawia ~4 close / 3 error / 2 finish listenery na DESTYNACJI (res) i NIE sprząta ich po settle (node 20). Na per-request ServerResponse pipowanym raz te dangling listenery dokładają się do listenerów Expressa i przebijają domyślny MaxListeners=10 → MaxListenersExceededWarning "11 close listeners added to [ServerResponse]" (transakcja GET /events/:id/thumbnail). pipeS3ToResponse MUSI zdjąć dokładnie te listenery które dołożył pipeline, zostawiając listenery frameworka nietknięte. To NIE jest setMaxListeners — realnie zmniejszamy liczbę przypiętych listenerów, nie podnosimy sufitu.',
    );
    // Pre-attach a framework-style listener to prove we only strip pipeline's
    // residue and leave pre-existing listeners alone.
    const frameworkClose = () => {};
    const res = new Writable({ write(_c, _e, cb) { cb(); } });
    res.on('close', frameworkClose);
    const before = {
      close: res.listenerCount('close'),
      error: res.listenerCount('error'),
      finish: res.listenerCount('finish'),
    };

    await pipeS3ToResponse(Readable.from([Buffer.from('hello')]), res);
    // Give any deferred internal cleanup a tick.
    await new Promise((r) => setImmediate(r));

    expect(res.listenerCount('close')).toBe(before.close);
    expect(res.listenerCount('error')).toBe(before.error);
    expect(res.listenerCount('finish')).toBe(before.finish);
    expect(res.listeners('close')).toContain(frameworkClose);
  });

  it('does not accumulate res listeners across many sequential pipes', async (ctx) => {
    story(
      ctx,
      'Dowód że fix faktycznie eliminuje akumulację: pipujemy do JEDNEGO trwałego res wiele razy z rzędu (mimicking keep-alive socket reuse / persistent sink). Bez sprzątania licznik close rośnie liniowo (4, 8, 12, ...) i pali MaxListeners. Z fixem zostaje płaski.',
    );
    const res = new Writable({ write(_c, _e, cb) { cb(); }, autoDestroy: false });
    for (let i = 0; i < 12; i++) {
      // After the first pipe res is ended, so later pipes reject with
      // write-after-end — irrelevant here: the `finally` cleanup (the thing
      // under test) runs on reject too. Swallow so the loop continues.
      await pipeS3ToResponse(Readable.from([Buffer.from('x')]), res).catch(() => undefined);
    }
    await new Promise((r) => setImmediate(r));
    // Anything well under the MaxListeners=10 ceiling proves no linear growth.
    expect(res.listenerCount('close')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('error')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('finish')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('end')).toBeLessThanOrEqual(2);
  });

  it('resolves cleanly when the source ends naturally', async (ctx) => {
    story(
      ctx,
      `Happy path: krótki plik (sidecar, thumbnail) idzie do końca i pipeS3ToResponse resolve-uje bez błędu. Bez tej asercji refactor mógłby zmienić semantykę resolve→reject i wszystkie route handlery zaczęłyby 500-ować na normalnych requestach.`,
    );
    const body = Readable.from([Buffer.from('hello, world')]);
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });

    await pipeS3ToResponse(body, res);

    expect(Buffer.concat(chunks).toString()).toBe('hello, world');
  });
});

describe('pipeThrottleToResponse — direct-pipe listener lifecycle', () => {
  /**
   * Pipe one short throttle into `res` and wait for the throttle to drain.
   * `end: false`-style reuse: after the first pipe the default `{end:true}`
   * has ended `res`, so later pipes can write-after-end — irrelevant to the
   * leak under test (cleanup runs on the throttle's terminal event regardless),
   * so swallow any res error and resolve on the throttle finishing.
   */
  function pipeOnce(res: Writable): Promise<void> {
    const throttle = new PassThrough();
    pipeThrottleToResponse(throttle, res);
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (done) return; done = true; setImmediate(resolve); };
      throttle.once('end', finish);
      throttle.once('close', finish);
      throttle.once('error', finish);
      try {
        throttle.end(Buffer.from('frame-bytes'));
      } catch {
        finish();
      }
    });
  }

  it('strips the pipe-added res listeners once the throttle drains', async (ctx) => {
    story(ctx, 'streamPatchedMp4/streamCleanFrameMp4/pass-through robią throttle.pipe(res) — Node dokłada close/finish/error/unpipe na res. To NIE jest setMaxListeners: helper realnie zdejmuje DOKŁADNIE listenery dołożone przez .pipe(), zostawiając listenery route/Expressa nietknięte.');
    const res = new Writable({ write(_c, _e, cb) { cb(); }, autoDestroy: false });
    const before = {
      close: res.listenerCount('close'),
      error: res.listenerCount('error'),
      finish: res.listenerCount('finish'),
      unpipe: res.listenerCount('unpipe'),
    };
    await pipeOnce(res);
    await new Promise((r) => setImmediate(r));
    expect(res.listenerCount('close')).toBe(before.close);
    expect(res.listenerCount('error')).toBe(before.error);
    expect(res.listenerCount('finish')).toBe(before.finish);
    expect(res.listenerCount('unpipe')).toBe(before.unpipe);
  });

  it('does not accumulate res listeners across many sequential pipes (the leak)', async (ctx) => {
    story(ctx, 'Dowód że akumulacji nie ma: 12 pipów do JEDNEGO res. Bez sprzątania close rośnie liniowo i pali MaxListeners=10 → "11 close listeners added to [ServerResponse]". Z fixem zostaje płaski.');
    const res = new Writable({ write(_c, _e, cb) { cb(); }, autoDestroy: false });
    // After the first pipe res is ended; later pipes push into an ended sink and
    // emit a write-after-end error. A persistent noop error sink swallows it
    // (it is not the close/finish/unpipe accumulation under test). Subtract this
    // one deliberate listener from the assertion budget below.
    res.on('error', () => undefined);
    for (let i = 0; i < 12; i++) {
      await pipeOnce(res);
    }
    await new Promise((r) => setImmediate(r));
    expect(res.listenerCount('close')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('error')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('finish')).toBeLessThanOrEqual(2);
    expect(res.listenerCount('unpipe')).toBeLessThanOrEqual(2);
  });

  it('delivers the full body (cleanup does not truncate output)', async (ctx) => {
    story(ctx, 'Sprzątanie listenerów odpala się na throttle "end" — czyli gdy .pipe() już wepchnął wszystko do res. Test pilnuje że nie ucinamy ogona streamu.');
    const chunks: Buffer[] = [];
    const res = new Writable({ write(c: Buffer, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    // Register the completion listener BEFORE the helper, mirroring the route
    // (video.ts attaches res.once('finish'/'close') at the top of the handler).
    // The helper snapshots res listeners on entry, so anything registered first
    // is preserved by the cleanup diff; registering after would be (correctly)
    // stripped as pipe-added.
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));
    const throttle = new PassThrough();
    pipeThrottleToResponse(throttle, res);
    throttle.write(Buffer.from('AAAA'));
    throttle.write(Buffer.from('BBBB'));
    throttle.end(Buffer.from('CCCC'));
    await finished;
    expect(Buffer.concat(chunks).toString()).toBe('AAAABBBBCCCC');
  });
});

/**
 * Build a minimal stand-in for an Express response that exposes a mutable
 * `socket.bytesWritten` — the only field `attachSlowConsumerMonitor` reads.
 * The Writable surface is unused (the monitor never writes to res); it is
 * here only because attachSlowConsumerMonitor type accepts Writable.
 */
function makeFakeRes(): Writable & { socket: { bytesWritten: number } } {
  const w = new Writable({ write(_c, _e, cb) { cb(); } }) as Writable & {
    socket: { bytesWritten: number };
  };
  w.socket = { bytesWritten: 0 };
  return w;
}

describe('attachSlowConsumerMonitor — slow-client kill', () => {
  it('does NOT fire during the grace period even if no bytes flow', (ctx) => {
    story(
      ctx,
      `Cold-start + pierwszy GOP klipu mogą trwać kilkaset ms zanim cokolwiek poleci do klienta. Bez grace-period detector zabijałby zdrowy stream w pierwszych sekundach. ${SLOW_CONSUMER_GRACE_MS}ms grace pokrywa typowe TTFB (~500ms-3s) bez false-positivnie kasowania healthy streamów.`,
    );
    vi.useFakeTimers();
    const res = makeFakeRes();
    const onSlow = vi.fn();
    attachSlowConsumerMonitor(res, onSlow);

    vi.advanceTimersByTime(SLOW_CONSUMER_GRACE_MS - 100);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('fires after sustained slowness past grace period', (ctx) => {
    const totalKillMs = SLOW_CONSUMER_GRACE_MS + SLOW_CONSUMER_CONSECUTIVE_CHECKS * SLOW_CONSUMER_CHECK_INTERVAL_MS;
    story(
      ctx,
      `Wedge-fix właściwy: klient czyta <20 KB/s przez ${SLOW_CONSUMER_CONSECUTIVE_CHECKS} kolejne ticki (${SLOW_CONSUMER_CONSECUTIVE_CHECKS * SLOW_CONSUMER_CHECK_INTERVAL_MS}ms), detector destroy-uje upstream Body, S3 socket wraca do agent poola w ~${totalKillMs}ms. Po OOM zmniejszone z 25s do ${totalKillMs / 1000}s żeby Node pipeline buffers nie urosły zbyt mocno przy 50+ concurrent slow streams.`,
    );
    vi.useFakeTimers();
    const res = makeFakeRes();
    const onSlow = vi.fn();
    attachSlowConsumerMonitor(res, onSlow);

    vi.advanceTimersByTime(SLOW_CONSUMER_GRACE_MS);
    for (let i = 0; i < SLOW_CONSUMER_CONSECUTIVE_CHECKS; i++) {
      vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS);
    }
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(onSlow.mock.calls[0][0]).toBeCloseTo(0, 1);
  });

  it('does NOT fire when client reads above threshold', (ctx) => {
    story(
      ctx,
      'Normalny klient — nawet na 3G — czyta z prędkością >20 KB/s gdy faktycznie ogląda video (typowy bitrate kamery 1-2 Mbps ≈ 125-250 KB/s). Detector nie może go skrzywdzić.',
    );
    vi.useFakeTimers();
    const res = makeFakeRes();
    const onSlow = vi.fn();
    attachSlowConsumerMonitor(res, onSlow);

    vi.advanceTimersByTime(SLOW_CONSUMER_GRACE_MS);
    for (let i = 0; i < 10; i++) {
      // 200 KB per tick × 2s interval = 100 KB/s, well above 20 KB/s threshold.
      res.socket.bytesWritten += 200 * 1024;
      vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS);
    }
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('resets slow-streak when a fast tick lands between slow ones', (ctx) => {
    story(
      ctx,
      'Krótkie buffering pauzy (np. ReBuffer w MSE source buffer) nie mogą kumulować się jako slow-streak. Wystarczy jeden tick z normalną prędkością żeby zresetować licznik — tak żeby tylko TRWAŁA, ciągła powolność ubijała stream.',
    );
    vi.useFakeTimers();
    const res = makeFakeRes();
    const onSlow = vi.fn();
    attachSlowConsumerMonitor(res, onSlow);

    // Exit grace and accumulate slow ticks ALMOST to threshold.
    vi.advanceTimersByTime(SLOW_CONSUMER_GRACE_MS);
    for (let i = 0; i < SLOW_CONSUMER_CONSECUTIVE_CHECKS - 1; i++) {
      vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS); // slow tick #i+1
    }

    // Fast tick — push bytes BEFORE the next interval fires, then advance.
    res.socket.bytesWritten += 200 * 1024;
    vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS); // FAST → reset streak

    // Now CONSECUTIVE - 1 more slow ticks. Streak only reaches CONSECUTIVE - 1
    // — should NOT fire.
    for (let i = 0; i < SLOW_CONSUMER_CONSECUTIVE_CHECKS - 1; i++) {
      vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS);
    }
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('cleanup function stops the interval and prevents future fires', (ctx) => {
    story(
      ctx,
      'pipeS3ToResponse ZAWSZE woła stopMonitor() w finally — niezależnie czy stream skończył się czysto, błędem czy slow-kill-em. Bez tego interval żyłby dalej po końcu requestu, akumulując rotting closure references.',
    );
    vi.useFakeTimers();
    const res = makeFakeRes();
    const onSlow = vi.fn();
    const stop = attachSlowConsumerMonitor(res, onSlow);

    vi.advanceTimersByTime(SLOW_CONSUMER_GRACE_MS);
    vi.advanceTimersByTime(SLOW_CONSUMER_CHECK_INTERVAL_MS); // 1 slow tick
    stop(); // pipeline settled — cleanup
    vi.advanceTimersByTime(60_000); // long time later
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('no-op when res has no socket (e.g. test PassThrough)', (ctx) => {
    story(
      ctx,
      'Niektóre uses (testy jednostkowe, in-process streamy) nie mają res.socket. Detector w takich przypadkach musi być no-opem zamiast crashować — bo wedge to problem produkcyjny, nie test infra.',
    );
    vi.useFakeTimers();
    const res = new PassThrough(); // no .socket
    const onSlow = vi.fn();
    const stop = attachSlowConsumerMonitor(res, onSlow);
    vi.advanceTimersByTime(60_000);
    expect(onSlow).not.toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop();
  });
});

// NB: integration test "pipeS3ToResponse → slow-consumer kill" was removed
// when slow-kill was feature-flagged off in production (ENABLE_SLOW_CONSUMER_KILL
// defaulting to 'false'). The helper itself remains tested in the
// `attachSlowConsumerMonitor` block above — re-add an integration test
// once the prod path re-enables the kill (likely after we figure out why
// res.socket.bytesWritten didn't reflect client read rate in v0.10.270).

describe('pipeS3IntoSink — multi-source stitch lifecycle', () => {
  it('destroys the S3 body when the shared sink errors', async (ctx) => {
    story(
      ctx,
      'streamPatchedMp4 pompuje kolejno trzy bajt-źródła do JEDNEGO throttle-a (sink). Jeśli sink padnie w połowie zone 2 (klient się rozłączył), body z getObject MUSI zostać zdestruowane. Bez tego mamy wyciek na każdym aborcie scrubowanego klipu klasy A — czyli większość naszego ruchu (Reolink fMP4).',
    );
    const body = makeInfiniteBody();
    const sink = new PassThrough();
    sink.on('data', () => {});

    const done = pipeS3IntoSink(body, sink).catch(() => null);
    await awaitFirstChunk(sink);
    sink.destroy(new Error('client gone'));
    await settleWithin(done, 200);

    const wasDestroyed = body.destroyed;
    cleanupLeakedBody(body);
    expect(wasDestroyed).toBe(true);
  });

  it('does not end the sink when the body ends', async (ctx) => {
    story(
      ctx,
      'pipeS3IntoSink jest używany w łańcuchu wielu sekwencyjnych body→jeden sink. Sink MUSI pozostać writable po zakończeniu pierwszego body, inaczej drugie body trafi w "write after end" i zone 2 stitched MP4 nigdy by się nie wysłał.',
    );
    const body = Readable.from([Buffer.from('chunk1')]);
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c) => chunks.push(c));

    await pipeS3IntoSink(body, sink);

    expect(sink.writable).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe('chunk1');
  });
});
