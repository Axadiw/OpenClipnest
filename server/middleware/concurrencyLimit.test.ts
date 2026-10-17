import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';
import {
  videoConcurrencyCap,
  getInFlightVideoCount,
  _resetForTesting,
  _getLimitForTesting,
} from './concurrencyLimit.js';

/**
 * Minimal stand-in for an Express Response. The middleware only touches
 * `setHeader`, `status`, `json`, and `once('close', …)`.
 */
interface FakeRes extends EventEmitter {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  setHeader(k: string, v: string | number | readonly string[]): FakeRes;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const e = new EventEmitter() as FakeRes;
  e.headers = {};
  e.setHeader = function (k, v) { this.headers[k] = String(v); return this; };
  e.status = function (c) { this.statusCode = c; return this; };
  e.json = function (b) { this.body = b; return this; };
  return e;
}

function makeReq(): Request {
  return {} as Request;
}

function makeNext(): NextFunction & Mock {
  return vi.fn() as unknown as NextFunction & Mock;
}

beforeEach(() => {
  _resetForTesting();
});

describe('videoConcurrencyCap — per-pod /video request limiter', () => {
  it('lets requests through up to the cap, then 429s', (ctx) => {
    const limit = _getLimitForTesting();
    story(
      ctx,
      `Globalny cap=${limit} chroni pulę S3 keep-alive socketów przed nasyceniem. Dopóki <${limit} streamów jest in-flight, każdy nowy request przechodzi do route handlera. ${limit + 1}-szy dostaje 429 + Retry-After: 3 — frontend retry'uje po backoffie, pod nie dostaje punktu.`,
    );
    const next = makeNext();
    const responses: FakeRes[] = [];

    for (let i = 0; i < limit; i++) {
      const r = makeRes();
      responses.push(r);
      videoConcurrencyCap(makeReq(), r as unknown as Response, next);
    }
    expect(next).toHaveBeenCalledTimes(limit);
    expect(getInFlightVideoCount()).toBe(limit);

    // Overflow request → 429.
    next.mockClear();
    const overflow = makeRes();
    videoConcurrencyCap(makeReq(), overflow as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(overflow.statusCode).toBe(429);
    expect(overflow.body).toMatchObject({ code: 'VIDEO_CONCURRENCY_LIMIT_REACHED' });
    expect(overflow.headers['Retry-After']).toBe('3');
    // Counter unchanged — overflow nie zajął slotu.
    expect(getInFlightVideoCount()).toBe(limit);
  });

  it('drains the counter on res close (both normal completion and client abort)', (ctx) => {
    story(
      ctx,
      'Najważniejszy invariant: każdy zajęty slot MUSI się zwolnić, niezależnie czy stream skończył się czysto, klient zerwał (Chrome close, mobile drop), czy upstream upadł. Bez tego cap byłby self-reinforcing — każdy abort permanent blokowałby slot, prowadząc do unbounded 429 po kilku minutach.',
    );
    const res = makeRes();
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    expect(getInFlightVideoCount()).toBe(1);

    res.emit('close'); // simulates both abort AND clean finish — same event
    expect(getInFlightVideoCount()).toBe(0);
  });

  it('release is idempotent (double-close does not decrement twice)', (ctx) => {
    story(
      ctx,
      'Node EventEmitters potrafią emitować close po finish w edge-case-ach. Idempotentny release zapobiega ujemnemu licznikowi (który by oznaczał że cap "myśli" iż jest miejsce, gdy realnie nie ma — i pool by się zwedge-ował).',
    );
    const res = makeRes();
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    res.emit('close');
    res.emit('close');
    expect(getInFlightVideoCount()).toBe(0);
  });
});
