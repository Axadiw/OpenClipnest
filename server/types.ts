/**
 * SVG glyph hint for a view toggle button. Eight built-in glyphs drawn by
 * the centralized `<ViewIcon>` component (frontend/src/components/ViewIcon.tsx).
 * 'generic' (and any unknown value) renders a plain camera glyph.
 */
export type IconKind =
  | 'wide'
  | 'zoom'
  | 'fisheye'
  | 'generic'
  | 'tele'
  | 'ptz'
  | 'doorbell'
  | 'thermal';

/**
 * One file attached to an event, keyed by its view id. The view id is a
 * profile-defined string ('00'/'01' for Reolink, can be anything for
 * other vendors). The shape carries both the storage-side rel_path
 * (used by the API to resolve playback URLs) and presentation hints
 * (label, iconKind) consumed by the player UI.
 */
export interface EventView {
  /** View id matching `CameraProfile.views[].id` (e.g. '00', '01', 'A'). */
  id: string;
  /** S3 rel_path from the user's prefix root — the video file. */
  videoRelPath: string;
  /**
   * i18n key (built-in profiles) or raw display string (custom profiles).
   * The frontend resolves keys and falls back to the raw value.
   */
  label?: string;
  /** SVG glyph hint for the player toggle button. */
  iconKind?: IconKind;
  /** Optional per-file metadata surfaced via the events API. */
  durationMs?: number;
  sizeBytes?: number;
  /** Video frames per second from the MP4; null/absent → client falls back to 30. */
  frameRate?: number;
}

export interface CameraEvent {
  id: string;
  camera: string;
  timestamp: string;
  date: string;
  /**
   * View files attached to this event. Ordered by view render priority
   * (first = primary view, default playback). For single-view cameras
   * this has one entry; for Reolink dual-view, two. Empty array means
   * no playable files left (the listing query filters those out).
   */
  views: EventView[];
  thumbnail: string | null;
  duration?: number;
  ownerId?: number;
  timezone?: string;
  /**
   * TRUE when `thumbnail` equals the THUMBNAIL_UNPLAYABLE tombstone sentinel.
   * Set by the listing query so the frontend can render the
   * "thumbnail unavailable" placeholder without leaking the sentinel string
   * to the client.
   */
  thumbnailFailed?: boolean;
  /**
   * Mirror of `events.playback_ready`, populated by `getEventByIdForOwner`.
   * The thumbnail worker gates its skipped-already-ready recompute on this:
   * events (re)created AFTER their files were already patch-ready never get
   * a recompute from `markPlaybackPatchReady` and would stay invisible in
   * the grid forever without it. Optional because the listing query filters
   * on playback_ready=TRUE instead of exposing it per row.
   */
  playbackReady?: boolean;
}

export interface User {
  id: string;          // UUID public identifier
  email: string;
  emailVerified?: boolean;
  isAdmin: boolean;
  active: boolean;
  createdAt: string;
  planId?: number;
  planName?: string;
  encryptionSalt?: string;
  diskUsageBytes?: number;
  transferUsageBytes?: number;
  bannedUntil?: string | null;
  bannedReason?: string | null;
  activeBanCount?: number;
  deletionStatus?: 'active' | 'pending_deletion' | 'deleting' | 'failed';
}

export interface BanStatus {
  banned: boolean;
  until?: string;
  reason?: string;
  indefinite?: boolean;
}

export interface Plan {
  id: number;
  name: string;
  diskSpaceBytes: number;
  monthlyTransferBytes: number;
  createdAt: string;
}

export interface UserQuota {
  diskUsageBytes: number;
  diskLimitBytes: number;
  transferUsageBytes: number;
  transferLimitBytes: number;
  transferResetAt: string | null;
}

export interface JwtPayload {
  userId: number;       // internal DB row id
  userUuid: string;     // public UUID
  email: string;
  isAdmin: boolean;
  tokenGen?: number;
  mediaEventId?: string;
  // Set on media tokens MINTED BY the MCP server (get_video). Binds the media
  // token to the issuing OAuth refresh-token family so revoking the MCP grant
  // immediately invalidates the media token — see requireAuth +
  // isMcpFamilyActive.
  mcpFamilyId?: string;
  // Token kind discriminator.
  //   - 'access'  → may be sent as Bearer on any /api route
  //   - 'refresh' → may ONLY be sent to /api/v0/auth/refresh
  //   - 'media'   → short-lived token bound to a single mediaEventId
  // Optional only because old tokens (15-min access TTL, 30d refresh TTL)
  // have all expired by now; treat undefined as 'access' for safety.
  kind?: 'access' | 'refresh' | 'media';
}

export type NotificationKind =
  | 'storage_quota_exceeded'
  | 'transfer_quota_exceeded'
  | 'invalid_file'
  | 'thumbnail_failed'
  | 'user_banned'
  | 'auto_deleted_oldest'
  | 'duplicate_file'
  // A new recording finished processing (thumbnail generated). Emitted by the
  // thumbnail worker's success path; carries `details.eventId` + `details.camera`
  // so the push fan-out can build a thumbnail-bearing notification.
  | 'new_recording';

export interface Notification {
  id: string;
  userId: number;
  kind: NotificationKind;
  message: string;
  details: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export type CameraProfileMode = 'auto' | 'reolink' | 'hikvision' | 'axis' | 'foscam' | 'custom';

export interface UserCameraProfile {
  id: number;
  name: string;
  regex: string;
  /**
   * Fallback view id assigned to files matched by this profile when the
   * regex doesn't carry a `view` named group. Arbitrary string (length
   * 1..16) — Reolink uses '00'/'01' but custom profiles can pick anything
   * that matches their regex's view output. Kept in sync with
   * `viewsConfig[0].id` on every write.
   */
  viewDefault: string;
  /**
   * Ordered per-view editor state. Each entry maps a view id (the value the
   * regex's `view` group emits) to its display glyph. The first entry is the
   * primary view (default playback). Drives `CameraProfile.views[]` in
   * `buildCustomProfile`. Persisted as the `views_config` JSONB column.
   */
  viewsConfig: Array<{ id: string; iconKind: IconKind }>;
  priority: number;
  enabled: boolean;
  createdAt: string;
}
