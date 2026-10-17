/** Zone a new account starts with, and what the settings fall back to when it cannot be read. */
export const DEFAULT_TIMEZONE = 'UTC';

/**
 * The zones an account can pick. ICU lists canonical zone names only, so
 * 'UTC' — the default of new accounts — is missing from
 * `Intl.supportedValuesOf('timeZone')` in Chromium; without it a UTC account
 * would show an unrelated zone and could never be selected again.
 */
export function selectableTimezones(supported: string[] = Intl.supportedValuesOf('timeZone')): string[] {
  return supported.includes(DEFAULT_TIMEZONE) ? supported : [DEFAULT_TIMEZONE, ...supported];
}
