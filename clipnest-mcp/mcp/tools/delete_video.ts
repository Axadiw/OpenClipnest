import { deleteEvent } from '../../../server/db/queries/events.js';
import { writeAuditLog } from '../../db/queries.js';
import type { McpAuthContext } from '../bearerAuth.js';

export interface DeleteVideoInput {
  id: string;
  confirm: boolean;
}

export interface DeleteVideoOutput {
  deleted: true;
  id: string;
}

export const deleteVideoToolDescriptor = {
  name: 'delete_video',
  description:
    'Permanently delete a video. Requires confirm:true as an explicit LLM safeguard. This action is irreversible.',
  inputSchema: {
    type: 'object' as const,
    required: ['id', 'confirm'],
    properties: {
      id: { type: 'string', description: 'Event ID of the video to delete.' },
      confirm: {
        type: 'boolean',
        description: 'Must be exactly true. Protects against accidental deletion.',
      },
    },
  },
} as const;

export async function deleteVideoImpl(
  input: DeleteVideoInput,
  auth: McpAuthContext,
): Promise<DeleteVideoOutput> {
  // 1. Scope gate
  if (!auth.scope.split(/\s+/).includes('videos:delete')) {
    throw new Error('insufficient_scope');
  }

  // 2. Confirm guard — must be literally true (not just truthy)
  if (input.confirm !== true) {
    throw new Error('confirm:true required to delete');
  }

  // 3. Delete the event — deleteEvent silently no-ops for non-existent/wrong-owner
  await deleteEvent(input.id, auth.userId);

  // 4. Audit log
  await writeAuditLog({
    userId: auth.userId,
    clientId: auth.clientId,
    action: 'tool.delete_video',
    detailsJson: { event_id: input.id },
    ip: null,
  });

  return { deleted: true, id: input.id };
}
