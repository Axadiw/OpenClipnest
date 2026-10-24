/**
 * Error-reporting facade for the core.
 *
 * The core reports caught errors, leaves breadcrumbs and flushes before a
 * short-lived process exits — through these calls only. Where the reports go
 * is the edition's business: an edition passes an `errorReporter` to
 * `installEdition()` (server/extensions.ts), or installs one from a module
 * preloaded with `node --import` so that it is in place before any entry file
 * runs. Without a reporter every call is dropped, so the shared tree pulls in
 * no error-monitoring SDK.
 *
 * Like utils/metrics.ts it imports no application modules, so anything can
 * depend on it without an import cycle.
 */
import type { Application } from 'express';

export interface Breadcrumb {
  category: string;
  message?: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface ErrorReporter {
  captureException: (err: unknown) => void;
  addBreadcrumb: (crumb: Breadcrumb) => void;
  /** Deliver what is queued (waiting at most `timeoutMs`) before the process exits. */
  close: (timeoutMs: number) => Promise<void>;
  /** Register the reporter's Express error handler; called after every route. */
  setupExpressErrorHandler?: (app: Application) => void;
}

const noop: ErrorReporter = {
  captureException: () => {},
  addBreadcrumb: () => {},
  close: async () => {},
};

let reporter: ErrorReporter = noop;

/** Route the core's reports to `r`; `undefined` drops them again. */
export function installErrorReporter(r: ErrorReporter | undefined): void {
  reporter = r ?? noop;
}

export function captureException(err: unknown): void {
  reporter.captureException(err);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  reporter.addBreadcrumb(crumb);
}

export function closeErrorReporting(timeoutMs: number): Promise<void> {
  return reporter.close(timeoutMs);
}

export function setupErrorReportingExpressHandler(app: Application): void {
  reporter.setupExpressErrorHandler?.(app);
}
