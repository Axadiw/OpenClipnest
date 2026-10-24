// frontend/src/lib/errorReporting.ts
//
// Error-reporting facade for the shared core. The core reports caught errors
// and leaves breadcrumbs through these calls; where they go is the edition's
// business. An edition installs a reporter from its `init()` (see
// editions/types.ts); without one every call is dropped, so the shared tree
// pulls in no error-monitoring SDK.

export interface Breadcrumb {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ErrorReporter {
  captureException: (error: unknown, extra?: Record<string, unknown>) => void;
  addBreadcrumb: (crumb: Breadcrumb) => void;
}

const noop: ErrorReporter = {
  captureException: () => {},
  addBreadcrumb: () => {},
};

let reporter: ErrorReporter = noop;

/** Route the core's reports to `r`; `undefined` drops them again. */
export function installErrorReporter(r: ErrorReporter | undefined): void {
  reporter = r ?? noop;
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  reporter.captureException(error, extra);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  reporter.addBreadcrumb(crumb);
}
