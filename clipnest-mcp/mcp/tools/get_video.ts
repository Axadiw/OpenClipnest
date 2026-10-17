import { getEventByIdForOwner } from '../../../server/db/queries/events.js';
import { getUserByInternalId } from '../../../server/db/queries/users.js';
import { generateMcpMediaToken } from '../../../server/services/auth.js';
import { MCP_CONFIG } from '../../config.js';
import type { McpAuthContext } from '../bearerAuth.js';

export interface GetVideoInput {
  id: string;
}

interface ViewDownload {
  url: string;
  expiresAt: string;
}

export interface GetVideoOutput {
  id: string;
  camera: string;
  timestamp: string;
  durationSec: number;
  /**
   * Per-view download links. Keys are profile-defined view ids — Reolink
   * cameras use `'00'` (wide) and `'01'` (zoom); custom profiles can pick
   * any 1..16-char string. Empty map means the event has no playable file.
   */
  downloads: Record<string, ViewDownload>;
}

export const getVideoToolDescriptor = {
  name: 'get_video',
  description: 'Get metadata and per-view media-token download URLs for a single video by ID.',
  inputSchema: {
    type: 'object' as const,
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Event ID of the video to retrieve.' },
    },
  },
} as const;

export async function getVideoImpl(
  input: GetVideoInput,
  auth: McpAuthContext,
): Promise<GetVideoOutput> {
  // 1. Scope gate
  if (!auth.scope.split(/\s+/).includes('videos:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. Fetch event
  const event = await getEventByIdForOwner(input.id, auth.userId);
  if (!event) {
    throw new Error('not_found');
  }

  // 3. Fetch user for JWT payload
  const user = await getUserByInternalId(auth.userId);
  if (!user) {
    throw new Error('user_not_found');
  }

  // 4. Build JWT payload for media tokens
  const jwtPayload = {
    userId: auth.userId,
    userUuid: user.id,  // user.id is the UUID
    email: user.email,
    isAdmin: false,     // Never escalate to admin via MCP
    tokenGen: user.tokenGeneration ?? 0,
  };

  // Media tokens are bound to this OAuth grant's refresh-token family
  // (auth.familyId): the API rejects them the instant the grant is revoked.
  // The short TTL below is
  // kept as defense-in-depth and must track CONFIG.mcpMediaTokenExpirySeconds.
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  // 5. Build download URLs for every attached view. The event payload
  // carries `views[]` (ordered, primary first) since v0.10.334; one
  // entry per view file the scanner has matched against this event.
  const downloads: GetVideoOutput['downloads'] = {};
  for (const view of event.views) {
    const token = generateMcpMediaToken(jwtPayload, input.id, auth.familyId);
    downloads[view.id] = {
      url: `${MCP_CONFIG.publicMcpUrl}/api/v0/events/${input.id}/video/${encodeURIComponent(view.id)}?media_token=${token}`,
      expiresAt,
    };
  }

  return {
    id: event.id,
    camera: event.camera,
    timestamp: event.timestamp,
    durationSec: event.duration ?? 0,
    downloads,
  };
}
