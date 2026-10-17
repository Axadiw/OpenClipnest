import type { Readable } from 'node:stream';
import { getEventByIdForOwner, THUMBNAIL_UNPLAYABLE } from '../../../server/db/queries/events.js';
import { getUserByInternalId } from '../../../server/db/queries/users.js';
import { getObject, headObject } from '../../../server/services/s3.js';
import { resolveS3Path } from '../../../server/utils/s3path.js';
import { generateMcpMediaToken } from '../../../server/services/auth.js';
import { MCP_CONFIG } from '../../config.js';
import type { McpAuthContext } from '../bearerAuth.js';

export interface GetThumbnailInput {
  id: string;
}

export interface GetThumbnailOutput {
  /** MIME type of the thumbnail bytes (always JPEG today). */
  mimeType: string;
  /** Base64-encoded thumbnail bytes (suitable for an MCP `image` content block). */
  base64: string;
  /** Decoded pixel width, or null when it couldn't be determined from the JPEG. */
  width: number | null;
  /** Decoded pixel height, or null when it couldn't be determined. */
  height: number | null;
  /** Size of the thumbnail in bytes. */
  sizeBytes: number;
  /** Signed, short-lived URL to re-fetch the same thumbnail over HTTP. */
  url: string;
  /** ISO timestamp the signed URL expires. */
  expiresAt: string;
}

// Defensive cap: generated thumbnails are small JPEGs (tens of KB). Refuse to
// base64-inline anything larger so a malformed/oversized object can't blow up
// the MCP response (base64 inflates by ~33%).
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MiB

export const getThumbnailToolDescriptor = {
  name: 'get_thumbnail',
  description:
    "Get a recording's thumbnail as an inline base64 image plus a short-lived signed URL. Returns image dimensions when decodable.",
  inputSchema: {
    type: 'object' as const,
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Event ID of the recording whose thumbnail to fetch.' },
    },
  },
} as const;

/**
 * Read the pixel dimensions of a JPEG by scanning its segment markers for the
 * Start-Of-Frame (SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC).
 * Returns null if the buffer isn't a JPEG or no SOF is found. Avoids pulling in
 * an image-size dependency for the only format the thumbnail pipeline emits.
 */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // Standalone markers (no length): RSTn (0xd0-0xd7), SOI/EOI, TEM.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF markers carry frame geometry. Exclude 0xc4 (DHT), 0xc8 (JPG),
    // 0xcc (DAC) which share the 0xc_ range but aren't frame headers.
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

async function readStreamCapped(stream: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > cap) {
      stream.destroy();
      throw new Error('thumbnail_too_large');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function getThumbnailImpl(
  input: GetThumbnailInput,
  auth: McpAuthContext,
): Promise<GetThumbnailOutput> {
  // 1. Scope gate.
  if (!auth.scope.split(/\s+/).includes('videos:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. Owner-scoped event lookup (WHERE id = ? AND owner_id = ?).
  const event = await getEventByIdForOwner(input.id, auth.userId);
  if (!event) {
    throw new Error('not_found');
  }
  if (!event.thumbnail || event.thumbnail === THUMBNAIL_UNPLAYABLE) {
    throw new Error('thumbnail_not_found');
  }

  // 3. Need the user's UUID (for the S3 key) + encryption salt (for SSE-C).
  const user = await getUserByInternalId(auth.userId);
  if (!user) {
    throw new Error('user_not_found');
  }
  if (!user.encryptionSalt) {
    throw new Error('user_encryption_key_not_found');
  }

  // 4. Resolve the S3 location. resolveS3Path rejects path traversal +
  //    cross-user references by construction.
  const s3Path = resolveS3Path(user.id, event.thumbnail);
  if (!s3Path) {
    throw new Error('thumbnail_not_found');
  }

  // 5. Size pre-check, then download (capped) and base64-encode.
  const head = await headObject(s3Path.bucket, s3Path.key, user.encryptionSalt);
  if (head.contentLength > MAX_THUMBNAIL_BYTES) {
    throw new Error('thumbnail_too_large');
  }
  const obj = await getObject(s3Path.bucket, s3Path.key, user.encryptionSalt);
  const bytes = await readStreamCapped(obj.body as Readable, MAX_THUMBNAIL_BYTES);

  const dims = jpegDimensions(bytes);

  // 6. Signed URL for the SAME thumbnail over HTTP. Reuses the existing
  //    /api/v0/events/:id/thumbnail route + the MCP media-token (bound to this
  //    grant's familyId so it dies with the grant). No new route.
  const jwtPayload = {
    userId: auth.userId,
    userUuid: user.id, // user.id is the UUID
    email: user.email,
    isAdmin: false, // never escalate via MCP
    tokenGen: user.tokenGeneration ?? 0,
  };
  const token = generateMcpMediaToken(jwtPayload, input.id, auth.familyId);
  const url = `${MCP_CONFIG.publicMcpUrl}/api/v0/events/${encodeURIComponent(input.id)}/thumbnail?media_token=${token}`;
  // Track CONFIG.mcpMediaTokenExpirySeconds (2 min) — same TTL get_video uses.
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  return {
    mimeType: 'image/jpeg',
    base64: bytes.toString('base64'),
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    sizeBytes: bytes.length,
    url,
    expiresAt,
  };
}
