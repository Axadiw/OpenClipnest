// server/db/queries/cameraProfiles.ts
import { eq, and, asc } from 'drizzle-orm';
import { db, withTx } from '../index.js';
import { users, userCameraProfiles } from '../schema/index.js';
import type { CameraProfileMode, IconKind } from '../../types.js';

// Patterns reference: server/db/queries/users.ts (top of file)

const ICON_KINDS: readonly IconKind[] = [
  'wide', 'zoom', 'fisheye', 'generic', 'tele', 'ptz', 'doorbell', 'thermal',
];

/**
 * Coerce the raw `views_config` JSONB value into a clean `Array<{id, iconKind}>`.
 * Defends against rows backfilled before the v11 feature (empty array →
 * synthesize one entry from `view_default`) and any malformed entry
 * (bad iconKind → 'generic', non-string id → dropped).
 */
function normalizeViewsConfig(
  raw: unknown,
  viewDefault: string,
): Array<{ id: string; iconKind: IconKind }> {
  const out: Array<{ id: string; iconKind: IconKind }> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const kindRaw = (entry as { iconKind?: unknown }).iconKind;
      const iconKind = ICON_KINDS.includes(kindRaw as IconKind)
        ? (kindRaw as IconKind)
        : 'generic';
      out.push({ id, iconKind });
    }
  }
  if (out.length === 0) {
    return [{ id: viewDefault || '00', iconKind: 'generic' }];
  }
  return out;
}

function mapCameraProfile(row: {
  id: number;
  name: string;
  regex: string;
  viewDefault: string;
  viewsConfig?: unknown;
  priority: number;
  enabled: boolean;
  createdAt: Date;
}): import('../../types.js').UserCameraProfile {
  return {
    id: row.id,
    name: row.name,
    regex: row.regex,
    // v10: DB column stays `view_default`; TS interface uses `viewDefault`
    viewDefault: row.viewDefault,
    // v11: per-view icon personalization; normalize from raw JSONB
    viewsConfig: normalizeViewsConfig(row.viewsConfig, row.viewDefault),
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

export async function getCameraProfileSettings(
  userUuid: string,
): Promise<{ mode: CameraProfileMode; profiles: import('../../types.js').UserCameraProfile[] }> {
  const [modeRow] = await db
    .select({ cameraProfileMode: users.cameraProfileMode })
    .from(users)
    .where(eq(users.uuid, userUuid));
  if (!modeRow) throw new Error(`User not found: ${userUuid}`);
  const mode = modeRow.cameraProfileMode as CameraProfileMode;

  const profiles = await db
    .select({
      id: userCameraProfiles.id,
      name: userCameraProfiles.name,
      regex: userCameraProfiles.regex,
      viewDefault: userCameraProfiles.viewDefault,
      viewsConfig: userCameraProfiles.viewsConfig,
      priority: userCameraProfiles.priority,
      enabled: userCameraProfiles.enabled,
      createdAt: userCameraProfiles.createdAt,
    })
    .from(userCameraProfiles)
    .innerJoin(users, eq(users.id, userCameraProfiles.userId))
    .where(eq(users.uuid, userUuid))
    .orderBy(asc(userCameraProfiles.priority), asc(userCameraProfiles.id));

  return { mode, profiles: profiles.map(mapCameraProfile) };
}

export async function setCameraProfileMode(
  userUuid: string,
  mode: CameraProfileMode,
): Promise<void> {
  await db
    .update(users)
    .set({ cameraProfileMode: mode })
    .where(eq(users.uuid, userUuid));
}

export async function insertUserCameraProfile(
  userUuid: string,
  // v11: viewsConfig replaces the old single viewDefault field.
  // viewDefault (DB) is derived from viewsConfig[0].id for backward compat.
  data: { name: string; regex: string; viewsConfig: Array<{ id: string; iconKind: string }>; priority: number },
): Promise<import('../../types.js').UserCameraProfile> {
  // Need to resolve user id from uuid first, then insert
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.uuid, userUuid));
  if (!userRow) throw new Error(`User not found: ${userUuid}`);

  // Derive view_default from the first entry in viewsConfig (primary view).
  const viewDefault = data.viewsConfig[0]?.id ?? '00';

  const [row] = await db
    .insert(userCameraProfiles)
    .values({
      userId: userRow.id,
      name: data.name,
      regex: data.regex,
      viewDefault,
      viewsConfig: data.viewsConfig,
      priority: data.priority,
    })
    .returning();

  return mapCameraProfile(row);
}

export async function updateUserCameraProfile(
  id: number,
  userUuid: string,
  // v11: viewsConfig replaces the old viewDefault field.
  // viewDefault (DB) is kept in sync as viewsConfig[0].id.
  data: {
    name?: string;
    regex?: string;
    viewsConfig?: Array<{ id: string; iconKind: string }>;
    priority?: number;
    enabled?: boolean;
  },
): Promise<import('../../types.js').UserCameraProfile | null> {
  if (Object.keys(data).length === 0) return null;

  // Verify ownership first
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.uuid, userUuid));
  if (!userRow) return null;

  const updateFields: Partial<{
    name: string;
    regex: string;
    viewDefault: string;
    viewsConfig: Array<{ id: string; iconKind: string }>;
    priority: number;
    enabled: boolean;
  }> = {};
  if (data.name !== undefined) updateFields.name = data.name;
  if (data.regex !== undefined) updateFields.regex = data.regex;
  if (data.viewsConfig !== undefined) {
    // Keep view_default in sync with the primary view id.
    updateFields.viewsConfig = data.viewsConfig;
    updateFields.viewDefault = data.viewsConfig[0]?.id ?? '00';
  }
  if (data.priority !== undefined) updateFields.priority = data.priority;
  if (data.enabled !== undefined) updateFields.enabled = data.enabled;

  const [row] = await db
    .update(userCameraProfiles)
    .set(updateFields)
    .where(
      and(
        eq(userCameraProfiles.id, id),
        eq(userCameraProfiles.userId, userRow.id),
      ),
    )
    .returning();

  return row ? mapCameraProfile(row) : null;
}

export async function deleteUserCameraProfile(
  id: number,
  userUuid: string,
): Promise<boolean> {
  // Resolve user id
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.uuid, userUuid));
  if (!userRow) return false;

  const result = await db
    .delete(userCameraProfiles)
    .where(
      and(
        eq(userCameraProfiles.id, id),
        eq(userCameraProfiles.userId, userRow.id),
      ),
    )
    .returning({ id: userCameraProfiles.id });

  return result.length > 0;
}

/**
 * Reset-to-defaults: atomically replace ALL of a user's custom profiles with
 * the given seed rows (the vendor templates). Runs in one transaction so
 * there is never an empty-profile window and the
 * 20-profile cap can't bite mid-reset (the old client-driven seed-first flow
 * 400'd for users with >16 profiles — seeding 4 more exceeded the cap before
 * the deletes ran). Returns the seeded profiles sorted like the GET endpoint.
 */
export async function resetUserCameraProfiles(
  userUuid: string,
  seeds: Array<{ name: string; regex: string; viewsConfig: Array<{ id: string; iconKind: string }>; priority: number }>,
): Promise<import('../../types.js').UserCameraProfile[]> {
  return withTx(async (tx) => {
    const [userRow] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.uuid, userUuid));
    if (!userRow) throw new Error(`User not found: ${userUuid}`);

    await tx
      .delete(userCameraProfiles)
      .where(eq(userCameraProfiles.userId, userRow.id));

    const rows = await tx
      .insert(userCameraProfiles)
      .values(seeds.map((s) => ({
        userId: userRow.id,
        name: s.name,
        regex: s.regex,
        viewDefault: s.viewsConfig[0]?.id ?? '00',
        viewsConfig: s.viewsConfig,
        priority: s.priority,
      })))
      .returning();

    return rows
      .sort((a, b) => a.priority - b.priority || a.id - b.id)
      .map(mapCameraProfile);
  });
}
