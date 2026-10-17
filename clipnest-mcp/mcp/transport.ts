import type { Express, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { bearerAuthMcp } from './bearerAuth.js';
import { perTokenRateLimit } from './rateLimit.js';
import { listVideosToolDescriptor, listVideosImpl, type ListVideosInput } from './tools/list_videos.js';
import { getVideoToolDescriptor, getVideoImpl, type GetVideoInput } from './tools/get_video.js';
import { deleteVideoToolDescriptor, deleteVideoImpl, type DeleteVideoInput } from './tools/delete_video.js';
import { listCamerasToolDescriptor, listCamerasImpl, type ListCamerasInput } from './tools/list_cameras.js';
import { getThumbnailToolDescriptor, getThumbnailImpl, type GetThumbnailInput } from './tools/get_thumbnail.js';
import { getStatsToolDescriptor, getStatsImpl, type GetStatsInput } from './tools/get_stats.js';
import { getAccountToolDescriptor, getAccountImpl, type GetAccountInput } from './tools/get_account.js';
import {
  muteNotificationsToolDescriptor, muteNotificationsImpl, type MuteNotificationsInput,
  getNotificationStatusToolDescriptor, getNotificationStatusImpl,
} from './tools/notifications.js';
import type { McpAuthContext } from './bearerAuth.js';

function registerAllTools(server: Server, auth: McpAuthContext): void {
  // Single ListTools handler — returns all tool descriptors
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      listVideosToolDescriptor,
      getVideoToolDescriptor,
      deleteVideoToolDescriptor,
      listCamerasToolDescriptor,
      getThumbnailToolDescriptor,
      getStatsToolDescriptor,
      getAccountToolDescriptor,
      muteNotificationsToolDescriptor,
      getNotificationStatusToolDescriptor,
    ],
  }));

  // Single CallTool dispatcher — routes by tool name
   
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    if (name === 'list_videos') {
      const input = (args ?? {}) as ListVideosInput;
      const result = await listVideosImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'get_video') {
      const input = (args ?? {}) as GetVideoInput;
      const result = await getVideoImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'delete_video') {
      const input = (args ?? {}) as DeleteVideoInput;
      const result = await deleteVideoImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'list_cameras') {
      const input = (args ?? {}) as ListCamerasInput;
      const result = await listCamerasImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'get_thumbnail') {
      const input = (args ?? {}) as GetThumbnailInput;
      const result = await getThumbnailImpl(input, auth);
      // An `image` content block carries the inline base64 thumbnail; a sibling
      // `text` block carries the metadata (dimensions + signed URL + size) so a
      // client that only reads text still gets the structured fields.
      const { base64, mimeType, ...meta } = result;
      return {
        content: [
          { type: 'image' as const, data: base64, mimeType },
          { type: 'text' as const, text: JSON.stringify(meta) },
        ],
      };
    }

    if (name === 'get_stats') {
      const input = (args ?? {}) as GetStatsInput;
      const result = await getStatsImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'get_account') {
      const input = (args ?? {}) as GetAccountInput;
      const result = await getAccountImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'mute_notifications') {
      const input = (args ?? {}) as MuteNotificationsInput;
      const result = await muteNotificationsImpl(input, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    if (name === 'get_notification_status') {
      const result = await getNotificationStatusImpl({}, auth);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });
}

export function mountMcpTransport(app: Express): void {
  // MCP Streamable HTTP (spec 2025-06-18): one URL handles POST (client→server),
  // GET (server→client SSE stream) and DELETE (session terminate). Clients can
  // configure us with just { "url": "https://<your-server>/mcp" } — no bridge.
  const auth = [
    bearerAuthMcp,
    perTokenRateLimit({ points: 600, durationSec: 60, keyPrefix: 'mcp-rpc' }),
  ];
  const handler = async (req: Request, res: Response): Promise<void> => {
    const server = new Server(
      { name: 'clipnest', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const { mcpAuth } = req as any;
    registerAllTools(server, mcpAuth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post('/mcp', ...auth, handler);
  app.get('/mcp', ...auth, handler);
  app.delete('/mcp', ...auth, handler);
}
