import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import {
  addBreadcrumb, captureException, closeErrorReporting, installErrorReporter, setupErrorReportingExpressHandler,
} from './errorReporting.js';

afterEach(() => installErrorReporter(undefined));

describe('errorReporting', () => {
  it('drops everything when no edition installed a reporter', async () => {
    expect(() => captureException(new Error('x'))).not.toThrow();
    expect(() => addBreadcrumb({ category: 'db.slow-tx' })).not.toThrow();
    await expect(closeErrorReporting(10)).resolves.toBeUndefined();
    expect(() => setupErrorReportingExpressHandler(express())).not.toThrow();
  });

  it('forwards every call to the installed reporter', async () => {
    const r = {
      captureException: vi.fn(),
      addBreadcrumb: vi.fn(),
      close: vi.fn(async () => {}),
      setupExpressErrorHandler: vi.fn(),
    };
    installErrorReporter(r);
    const err = new Error('boom');
    const app = express();
    captureException(err);
    addBreadcrumb({ category: 'db.slow-tx', level: 'warning', data: { elapsed_ms: 1200 } });
    await closeErrorReporting(200);
    setupErrorReportingExpressHandler(app);
    expect(r.captureException).toHaveBeenCalledWith(err);
    expect(r.addBreadcrumb).toHaveBeenCalledWith({ category: 'db.slow-tx', level: 'warning', data: { elapsed_ms: 1200 } });
    expect(r.close).toHaveBeenCalledWith(200);
    expect(r.setupExpressErrorHandler).toHaveBeenCalledWith(app);
  });
});
