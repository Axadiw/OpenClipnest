import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';
import { installEditionGuards, requireOwner } from './editionGuards.js';

const req = {} as Request;
const res = {} as Response;

afterEach(() => installEditionGuards(undefined));

describe('edition guards', () => {
  it('pass through when no edition installed guards (self-hosted)', (ctx) => {
    story(ctx, 'Self-hosted ma jedno konto — bez zainstalowanej bramki każdy request przechodzi.');
    const next = vi.fn() as unknown as NextFunction;
    requireOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('delegate to the installed edition guards', (ctx) => {
    story(ctx, 'Cloud rozdziela admina od klientów: zainstalowana bramka dostaje request i sama decyduje (403 albo next).');
    const owner = vi.fn();
    installEditionGuards({ owner });
    const next = vi.fn() as unknown as NextFunction;
    requireOwner(req, res, next);
    expect(owner).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});
