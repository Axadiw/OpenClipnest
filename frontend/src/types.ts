/**
 * SVG glyph hint for a view toggle button. Mirror of server/types.ts IconKind.
 * Eight built-in glyphs rendered by `<ViewIcon>` (components/ViewIcon.tsx);
 * 'generic' (and any unknown value) falls back to a plain camera glyph.
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
 * One view file attached to an event. Mirror of server/types.ts EventView.
 * The rel_path is included so the player can build cache keys / display
 * filenames, but playback URLs are always built via api.getVideoUrl().
 */
export interface EventView {
  id: string;
  videoRelPath: string;
  label?: string;
  iconKind?: IconKind;
  durationMs?: number;
  sizeBytes?: number;
  frameRate?: number;
}

export interface CameraEvent {
  id: string;
  camera: string;
  timestamp: string;
  date: string;
  /**
   * View files in render order. views[0] is the default playback view.
   * Single-lens cameras have one entry; Reolink dual-lens has two.
   */
  views: EventView[];
  thumbnail: string | null;
  duration?: number;
  timezone?: string;
  /**
   * TRUE when the thumbnail worker gave up after the retry budget. The
   * card renders a "thumbnail unavailable" placeholder; the listing
   * filters fully orphaned events out server-side.
   */
  thumbnailFailed?: boolean;
}

export function getFilename(path: string | null): string {
  if (!path) return '';
  return path.split('/').pop() || path;
}

export interface User {
  id: string;        // UUID
  email: string;
  emailVerified?: boolean;
  isAdmin: boolean;
  active?: boolean;
  createdAt?: string;
  planId?: number;
  planName?: string;
  bannedUntil?: string | null;
  bannedReason?: string | null;
  activeBanCount?: number;
  deletionStatus?: 'active' | 'pending_deletion' | 'deleting' | 'failed';
  // adminLocked: locked by an administrator; planLocked: locked for lack of an active plan; accessLocked: either.
  accessLocked?: boolean;
  adminLocked?: boolean;
  planLocked?: boolean;
  planOverrideAt?: string | null;
}

export interface Plan {
  id: number;
  name: string;
  diskSpaceBytes: number;
  monthlyTransferBytes: number;
  isPublic: boolean;
  sortOrder: number;
  monthlyPriceCents: number | null;
  currency: string;
  priceLookupKey: string | null;
  userCount?: number;
}

/**
 * View identifier — profile-defined string. Reolink uses '00' / '01';
 * other vendors and custom profiles can use any string (e.g. 'A', 'main').
 * Use the full view object via CameraEvent.views[] when rendering UI.
 */
export type ViewId = string;

export type NotificationKind =
  | 'storage_quota_exceeded'
  | 'transfer_quota_exceeded'
  | 'invalid_file'
  | 'thumbnail_failed'
  | 'user_banned'
  | 'auto_deleted_oldest'
  | 'duplicate_file'
  // A scheduled change to a smaller plan was called off because the
  // recordings no longer fit in it. details.plan = that plan's name.
  | 'plan_change_cancelled'
  // The account's recordings will be deleted because its access ended for
  // lack of an active plan. details.at = the deletion day (ISO, 00:00 UTC),
  // details.final = this is the notice the day before.
  | 'content_deletion_scheduled'
  // The account's recordings were deleted for that reason (the account stays).
  | 'content_deleted';

export interface Notification {
  id: string;
  userId: number;
  kind: NotificationKind;
  message: string;
  details: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}
