import { getEvents, type EventCursor } from '../../../server/db/queries/events.js';

export interface AuthCtx {
  userId: number;
  scope: string;
}

export interface ListVideosInput {
  camera?: string[];
  dateFrom?: string;
  dateTo?: string;
  timeFrom?: string;
  timeTo?: string;
  rangeFrom?: string;
  rangeTo?: string;
  limit?: number;
  cursor?: string;
}

export interface VideoItem {
  id: string;
  camera: string;
  timestamp: string;
  durationSec: number;
  /** Profile-defined view ids attached to this event (e.g. ["00","01"] for
   *  Reolink dual-view, ["00"] for single-view vendors). The two legacy
   *  `hasWide` / `hasZoom` booleans collapse into this list because view
   *  catalogues are no longer hardcoded to a 2-slot wide/zoom model. */
  viewIds: string[];
}

export interface ListVideosOutput {
  videos: VideoItem[];
  nextCursor?: string;
}

function encodeCursor(c: EventCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(s: string): EventCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'));
  } catch {
    throw new Error('invalid_cursor');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>).timestamp !== 'string' ||
    typeof (decoded as Record<string, unknown>).id !== 'string'
  ) {
    throw new Error('invalid_cursor');
  }
  return decoded as EventCursor;
}

export async function listVideosImpl(
  input: ListVideosInput,
  auth: AuthCtx,
): Promise<ListVideosOutput> {
  // 1. Auth scope check — BEFORE any DB work
  if (!auth.scope.split(/\s+/).includes('videos:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. Clamp limit to [1, 100], default 20
  const rawLimit = input.limit ?? 20;
  const limit = Math.min(100, Math.max(1, rawLimit));

  // 3. Decode cursor if provided
  let cursor: EventCursor | undefined;
  if (input.cursor !== undefined) {
    cursor = decodeCursor(input.cursor);
  }

  // 4. Call getEvents scoped to this user's ownerId
  const result = await getEvents({
    cameras: input.camera,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    timeFrom: input.timeFrom,
    timeTo: input.timeTo,
    rangeFrom: input.rangeFrom,
    rangeTo: input.rangeTo,
    limit,
    cursor,
    ownerId: auth.userId,
  });

  // 5. Map to trimmed output shape
  const videos: VideoItem[] = result.events.map(event => ({
    id: event.id,
    camera: event.camera,
    timestamp: event.timestamp,
    durationSec: event.duration ?? 0,
    viewIds: event.views.map(v => v.id),
  }));

  const output: ListVideosOutput = { videos };
  if (result.nextCursor !== null) {
    output.nextCursor = encodeCursor(result.nextCursor);
  }

  return output;
}

export const listVideosToolDescriptor = {
  name: 'list_videos',
  description: "List the user's recorded videos with optional filters.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      camera: { type: 'array', items: { type: 'string' } },
      dateFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      dateTo: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      timeFrom: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
      timeTo: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
      rangeFrom: { type: 'string' },
      rangeTo: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string' },
    },
  },
} as const;
