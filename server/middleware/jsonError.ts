import type { Request, Response, NextFunction } from 'express';

// Error `type` tags body-parser (express.json / express.urlencoded) attaches
// to the SyntaxError / PayloadTooLargeError it throws on bad input. We map
// these to clean 4xx responses and CONSUME the error (no next(err)), so the
// downstream Sentry express error handler never captures them — a client or
// camera sending garbage JSON or an oversized body is its fault, not a server
// fault, and pages nobody. `entity.parse.failed` = invalid JSON (400);
// `entity.too.large` = body over the configured limit (413). Anything else is
// a genuine fault and is re-thrown via next(err) so Sentry still reports it.
const MALFORMED_BODY_TYPES: Record<string, number> = {
  'entity.parse.failed': 400,
  'entity.too.large': 413,
};

/**
 * Express error-handling middleware that turns body-parser input errors into
 * quiet JSON 4xx responses WITHOUT forwarding them to Sentry.
 *
 * MUST be registered before `setupSentryExpressErrorHandler(app)` — Express
 * runs error middleware in registration order, and because this handler does
 * not call `next(err)` for the cases it handles, the error never reaches the
 * Sentry handler and is never captured.
 */
export function malformedBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const e = err as { type?: unknown } | null | undefined;
  const type = e && typeof e === 'object' && typeof e.type === 'string' ? e.type : undefined;
  const status = type ? MALFORMED_BODY_TYPES[type] : undefined;
  if (status === undefined) {
    next(err);
    return;
  }
  // Headers already flushed (error thrown mid-stream): can't write a JSON
  // body — hand off so the framework/Sentry handler can tear the socket down.
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).json({
    error: status === 413 ? 'Request body too large' : 'Malformed JSON request body',
  });
}
