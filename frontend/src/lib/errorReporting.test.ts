import { afterEach, describe, expect, it, vi } from 'vitest';
import { addBreadcrumb, captureException, installErrorReporter } from './errorReporting';

afterEach(() => installErrorReporter(undefined));

describe('errorReporting', () => {
  it('drops reports when no edition installed a reporter', () => {
    expect(() => captureException(new Error('x'))).not.toThrow();
    expect(() => addBreadcrumb({ category: 'video', message: 'm' })).not.toThrow();
  });

  it('forwards reports to the installed reporter', () => {
    const r = { captureException: vi.fn(), addBreadcrumb: vi.fn() };
    installErrorReporter(r);
    const err = new Error('boom');
    captureException(err, { componentStack: 'at X' });
    addBreadcrumb({ category: 'video', message: 'stall-retry', data: { attempt: 1 } });
    expect(r.captureException).toHaveBeenCalledWith(err, { componentStack: 'at X' });
    expect(r.addBreadcrumb).toHaveBeenCalledWith({ category: 'video', message: 'stall-retry', data: { attempt: 1 } });
  });
});
