// server/hooks.ts
//
// Edition hooks: the points where the shared core hands a side effect to the
// edition instead of doing it itself. Clipnest Cloud installs implementations
// (e.g. transactional email); the self-hosted edition installs none, and the
// core treats a missing hook as "nothing to do".
//
// Installed once per process — `createApp()` does it for the API, and every
// worker/cron entrypoint does it explicitly — so core services can stay free
// of any edition import.

export interface StorageWarningInput {
  userId: number;
  email: string;
  /** When the edition last warned this user (from `users.storage_warn_email_sent_at`), or null. */
  lastWarnedAt: Date | null;
  diskUsageBytes: number;
  diskLimitBytes: number;
  percent: number;
}

export interface EditionHooks {
  /**
   * Usage crossed the 90 % storage-warning threshold and no auto-delete is
   * configured. Returns true when a warning was actually delivered (the hook
   * owns its own cooldown). Absent ⇒ no warning channel in this edition.
   */
  storageWarning?: (input: StorageWarningInput) => Promise<boolean>;
}

let installed: EditionHooks = {};

export function installEditionHooks(hooks: EditionHooks | undefined): void {
  installed = hooks ?? {};
}

export function editionHooks(): EditionHooks {
  return installed;
}
