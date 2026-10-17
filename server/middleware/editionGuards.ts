// server/middleware/editionGuards.ts
//
// The role gate the core applies without knowing what a "role" is in the
// running edition. Clipnest Cloud separates the operator (admin) from content
// owners (customers) and keeps the operator out of the recording surfaces; a
// self-hosted install has exactly one account, so nothing is installed and
// the gate passes through.
import type { RequestHandler } from 'express';

export interface EditionGuards {
  /** Gate for content-owner surfaces (recordings, settings, notifications, quota). */
  owner?: RequestHandler;
}

let guards: EditionGuards = {};

/** Installed once per process by `installEdition()`; undefined ⇒ pass-through. */
export function installEditionGuards(g: EditionGuards | undefined): void {
  guards = g ?? {};
}

export const requireOwner: RequestHandler = (req, res, next) => {
  if (guards.owner) return guards.owner(req, res, next);
  next();
};
