import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';
import { malformedBodyErrorHandler } from './jsonError.js';

/**
 * Build a test app shaped like the real one (server/index.ts): a JSON body
 * parser, a route that echoes the body, the malformed-body handler, then a
 * stand-in "Sentry" error handler that records anything that reaches it. The
 * spy proves the contract that matters: a malformed body is consumed by our
 * handler and NEVER forwarded to Sentry; a genuine route error still is.
 */
function createApp(sentrySpy: (err: unknown) => void) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.post('/echo', (req, res) => {
    res.json({ received: req.body });
  });
  app.get('/boom', () => {
    throw new Error('genuine handler fault');
  });
  app.use(malformedBodyErrorHandler);
  // Stand-in for setupSentryExpressErrorHandler — registered AFTER ours, just
  // like in index.ts. If our handler calls next(err) the error lands here.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sentrySpy(err);
    if (!res.headersSent) res.status(500).json({ error: 'captured-by-sentry' });
  });
  return app;
}

describe('malformedBodyErrorHandler', () => {
  it('maps invalid JSON to a clean 400 and does NOT forward to Sentry', async (ctx) => {
    story(ctx, 'Kamera/klient wysyłający uszkodzony JSON to jego wina, nie serwera. body-parser rzuca SyntaxError(type=entity.parse.failed); bez tego handlera ląduje on w Sentry jako szum. Test dowodzi: 400 + spy nigdy nie woła.');
    const sentrySpy = vi.fn();
    const res = await request(createApp(sentrySpy))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON request body' });
    expect(sentrySpy).not.toHaveBeenCalled();
  });

  it('maps an oversized body to 413 and does NOT forward to Sentry', async (ctx) => {
    story(ctx, 'Body przekraczające limit (entity.too.large) to też błąd po stronie klienta — 413, nie page do Sentry.');
    const sentrySpy = vi.fn();
    const huge = JSON.stringify({ blob: 'x'.repeat(200 * 1024) });
    const res = await request(createApp(sentrySpy))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(huge);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large' });
    expect(sentrySpy).not.toHaveBeenCalled();
  });

  it('forwards genuine handler errors to Sentry (does not swallow real faults)', async (ctx) => {
    story(ctx, 'Handler ma być chirurgiczny: tylko błędy parsowania body. Prawdziwy błąd w route musi nadal trafić do Sentry, inaczej ukrywalibyśmy realne awarie.');
    const sentrySpy = vi.fn();
    const res = await request(createApp(sentrySpy))
      .get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'captured-by-sentry' });
    expect(sentrySpy).toHaveBeenCalledTimes(1);
    expect(sentrySpy.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('passes a valid JSON body straight through to the route', async (ctx) => {
    story(ctx, 'Sanity: poprawny JSON nie jest dotykany przez handler błędów — route normalnie odpowiada.');
    const sentrySpy = vi.fn();
    const res = await request(createApp(sentrySpy))
      .post('/echo')
      .send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { hello: 'world' } });
    expect(sentrySpy).not.toHaveBeenCalled();
  });

  it('re-forwards a malformed-body error when headers are already sent', async (ctx) => {
    story(ctx, 'Jeśli nagłówki już poszły na drut, nie da się dopisać JSON 400 — przekazujemy dalej (next(err)) zamiast rzucać ERR_HTTP_HEADERS_SENT.');
    const next = vi.fn();
    const res = {
      headersSent: true,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as express.Response;
    malformedBodyErrorHandler({ type: 'entity.parse.failed' }, {} as express.Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith({ type: 'entity.parse.failed' });
  });
});
