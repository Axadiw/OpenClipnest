// server/services/push/types.ts
//
// What a push notification is, independently of how it reaches the phone. The
// worker builds a `PushOptions`; the edition's `PushTransport` delivers it —
// Clipnest Cloud straight to APNs/FCM with its own credentials, a self-hosted
// install through the Clipnest push relay (the store-signed apps can only be
// reached with the publisher's keys).

// --- Notification action categories ----------------------------------------
//
// `aps.category` selects which set of action buttons iOS shows under the
// notification. The identifiers here MUST match the UNNotificationCategory
// identifiers the iOS app registers at launch (see PushManager.swift /
// NotificationCategories.swift). Older app builds that don't know a category
// simply render the banner with no buttons — safe graceful degradation, so no
// version gating is needed.
//
//   - CATEGORY_RECORDING ('recording'): new_recording → [Play, Mute…]
//   - CATEGORY_MUTABLE   ('mutable'):    every other suppressible kind → [Mute…]
//   - user_banned: no category — it can't be muted (account suspension).
export const CATEGORY_RECORDING = 'recording';
export const CATEGORY_MUTABLE = 'mutable';

/**
 * Map a notification kind to its APNs `category` (action-button set), or
 * undefined when the kind carries no actions. Exported so both the worker and
 * tests share one source of truth; the iOS side mirrors these identifiers.
 */
export function categoryForKind(kind: string): string | undefined {
  if (kind === 'new_recording') return CATEGORY_RECORDING;
  if (kind === 'user_banned') return undefined; // not suppressible — no Mute…
  return CATEGORY_MUTABLE;
}

export interface PushOptions {
  title: string;
  body: string;
  /** Notification kind — used as the apns collapse/category context. */
  kind: string;
  /** APNs `aps.category` — selects the registered action-button set on the
   *  device (see categoryForKind). Omitted → no action buttons. */
  category?: string;
  /** apns-collapse-id grouping (e.g. one slot per camera). Optional. */
  threadId?: string;
  /** Set `mutable-content: 1` so the iOS Notification Service Extension can
   *  download + attach a thumbnail before the banner shows. */
  mutableContent?: boolean;
  /** Extra top-level keys merged into the JSON payload alongside `aps`
   *  (e.g. `{ thumbnailUrl, eventId, camera }`). The NSE reads these. */
  custom?: Record<string, unknown>;
  /** Localized-alert fields (APNs `title-loc-key` / `loc-key` / `loc-args`).
   *  Only emitted when the target device advertised loc-key support (see
   *  `sendPush`'s `useLoc`); otherwise the literal `title`/`body` are used so
   *  older app versions keep working. iOS resolves the keys against the app's
   *  String Catalog in the user's language. */
  titleLocKey?: string;
  locKey?: string;
  locArgs?: string[];
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  /** APNs `reason` string when the send failed. */
  reason?: string;
  /** True when the token is permanently invalid and should be deleted. */
  shouldPrune: boolean;
  /** The apns-id Apple assigned (present on success). */
  apnsId?: string;
}

/** A registered device, as the worker hands it to the transport. */
export interface PushDevice {
  /** Raw APNs/FCM token (cloud) — the relay path never sees the raw token. */
  deviceToken: string;
  platform: string;
  supportsLocKeys: boolean;
  /**
   * Relay registration (self-hosted): the id the relay assigned to this device
   * and the device's P-256 public key for end-to-end encryption. Absent until
   * the app has registered with the relay.
   */
  relay?: { deviceId: string; publicKey: string };
}

export interface PushTransport {
  /** Human-readable name for logs. */
  readonly name: string;
  /** False ⇒ the worker drains the stream and sends nothing (logged once). */
  configured(): boolean;
  /** One-line explanation of what is missing when not configured. */
  describeMissing(): string;
  send(device: PushDevice, payload: PushOptions): Promise<SendPushResult>;
  close(): Promise<void>;
}
