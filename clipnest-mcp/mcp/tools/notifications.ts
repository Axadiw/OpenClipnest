import { getPushPrefs, upsertPushPrefs } from '../../../server/db/queries/push.js';
import { writeAuditLog } from '../../db/queries.js';
import type { McpAuthContext } from '../bearerAuth.js';

// ---------------------------------------------------------------------------
// mute_notifications + get_notification_status — thin wrappers over the
// per-user `push_prefs.snooze_until` do-not-disturb window. No backend change:
// they call the SAME getPushPrefs / upsertPushPrefs the
// GET/PUT /api/v0/account/push-prefs routes use, scoped to auth.userId.
//
// Both share the `notifications:write` scope: get_notification_status is the
// read side of the same surface (you can always read what you can write).
// ---------------------------------------------------------------------------

export interface MuteNotificationsInput {
  /**
   * Desired mute state:
   *   - `mute: true`  → snooze. Pass `until` for a timed window, or omit it for
   *                     an indefinite mute (a far-future sentinel, year 9999).
   *   - `mute: false` → unmute (clear the snooze window).
   */
  mute: boolean;
  /** ISO-8601 datetime to snooze until. Only used when `mute: true`. */
  until?: string;
}

export interface NotificationStatusOutput {
  /** True when a snooze window is currently active (snoozeUntil is in the future). */
  muted: boolean;
  /** ISO timestamp the mute lasts until, or null when not muted. */
  snoozeUntil: string | null;
}

// Indefinite mute is modeled as a far-future timestamp so the existing
// push-worker `snoozeUntil` check (suppress while now < snoozeUntil) keeps
// working unchanged — there is no separate "muted forever" column.
const INDEFINITE_SNOOZE_ISO = '9999-12-31T23:59:59.999Z';

export const muteNotificationsToolDescriptor = {
  name: 'mute_notifications',
  description:
    "Mute or unmute the user's push notifications. mute:true with an `until` snoozes until that time; mute:true without `until` mutes indefinitely; mute:false unmutes.",
  inputSchema: {
    type: 'object' as const,
    required: ['mute'],
    properties: {
      mute: {
        type: 'boolean',
        description: 'true to snooze notifications, false to unmute.',
      },
      until: {
        type: 'string',
        description: 'ISO-8601 datetime to snooze until (only used when mute:true). Omit for indefinite.',
      },
    },
  },
} as const;

export const getNotificationStatusToolDescriptor = {
  name: 'get_notification_status',
  description: "Read the user's current notification mute status (whether muted and until when).",
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
} as const;

function toStatus(snoozeUntil: string | null): NotificationStatusOutput {
  const muted = snoozeUntil !== null && Date.parse(snoozeUntil) > Date.now();
  return { muted, snoozeUntil: muted ? snoozeUntil : null };
}

export async function muteNotificationsImpl(
  input: MuteNotificationsInput,
  auth: McpAuthContext,
): Promise<NotificationStatusOutput> {
  // 1. Scope gate.
  if (!auth.scope.split(/\s+/).includes('notifications:write')) {
    throw new Error('insufficient_scope');
  }

  // 2. Resolve the snoozeUntil value to write.
  let snoozeUntil: string | null;
  if (input.mute) {
    if (input.until === undefined) {
      snoozeUntil = INDEFINITE_SNOOZE_ISO;
    } else {
      const ms = Date.parse(input.until);
      if (Number.isNaN(ms)) {
        throw new Error('until must be an ISO-8601 datetime');
      }
      snoozeUntil = new Date(ms).toISOString();
    }
  } else {
    snoozeUntil = null; // unmute → clear the window
  }

  // 3. upsertPushPrefs is keyed on userId — only the caller's own row is
  //    written. `categories` is left untouched (undefined).
  const prefs = await upsertPushPrefs(auth.userId, { snoozeUntil });

  await writeAuditLog({
    userId: auth.userId,
    clientId: auth.clientId,
    action: 'tool.mute_notifications',
    detailsJson: { mute: input.mute, snooze_until: prefs.snoozeUntil },
    ip: null,
  });

  return toStatus(prefs.snoozeUntil);
}

export async function getNotificationStatusImpl(
  _input: Record<string, never>,
  auth: McpAuthContext,
): Promise<NotificationStatusOutput> {
  // Same scope as the write tool — status is the read side of the write surface.
  if (!auth.scope.split(/\s+/).includes('notifications:write')) {
    throw new Error('insufficient_scope');
  }

  // getPushPrefs is keyed on userId — only the caller's own row.
  const prefs = await getPushPrefs(auth.userId);
  return toStatus(prefs.snoozeUntil);
}
