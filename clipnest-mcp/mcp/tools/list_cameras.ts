import { getCameraDetails } from '../../../server/db/queries/events.js';
import type { McpAuthContext } from '../bearerAuth.js';

// list_cameras input takes no parameters — the camera inventory is always the
// full set owned by the authenticated user.
export type ListCamerasInput = Record<string, never>;

export interface CameraInventoryItem {
  /** Camera name as recorded by the uploading device. */
  name: string;
  /** ISO timestamp (capture-time, wall-clock baked as UTC) of the most recent
   *  displayable recording for this camera. */
  lastRecordingAt: string;
  /** ISO timestamp of the earliest displayable recording for this camera. */
  firstRecordingAt: string;
  /** Count of displayable clips — matches the grid / Cameras-screen count. */
  clipCount: number;
}

export interface ListCamerasOutput {
  cameras: CameraInventoryItem[];
}

export const listCamerasToolDescriptor = {
  name: 'list_cameras',
  description:
    "List the user's cameras with each camera's clip count and first/last recording time.",
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
} as const;

export async function listCamerasImpl(
  _input: ListCamerasInput,
  auth: McpAuthContext,
): Promise<ListCamerasOutput> {
  // 1. Scope gate — BEFORE any DB work.
  if (!auth.scope.split(/\s+/).includes('account:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. getCameraDetails is owner-scoped (WHERE owner_id = $1) and applies the
  //    canonical displayable-event predicate, so clipCount matches the grid.
  const details = await getCameraDetails(auth.userId);

  const cameras: CameraInventoryItem[] = details.map(d => ({
    name: d.camera,
    lastRecordingAt: d.lastEventAt,
    firstRecordingAt: d.firstEventAt,
    clipCount: d.eventCount,
  }));

  return { cameras };
}
