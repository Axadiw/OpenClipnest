import { getUserByInternalId } from '../../../server/db/queries/users.js';
import { getUserQuota, checkAndResetTransfer } from '../../../server/db/queries/storage.js';
import type { McpAuthContext } from '../bearerAuth.js';

export type GetAccountInput = Record<string, never>;

export interface GetAccountOutput {
  /** Account UUID (the public id; never the internal numeric DB id). */
  id: string;
  email: string;
  /** Plan name, or null when the user has no plan assigned. */
  plan: string | null;
  disk: {
    usageBytes: number;
    /** Plan disk limit in bytes; 0 means unlimited / no plan. */
    limitBytes: number;
    percent: number;
  };
  transfer: {
    usageBytes: number;
    /** Monthly transfer limit in bytes; 0 means unlimited / no plan. */
    limitBytes: number;
    percent: number;
    /** ISO timestamp the monthly transfer counter resets, or null. */
    resetAt: string | null;
  };
}

export const getAccountToolDescriptor = {
  name: 'get_account',
  description:
    "Get the user's account summary: plan name, disk usage vs quota, and monthly transfer usage vs quota.",
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
} as const;

export async function getAccountImpl(
  _input: GetAccountInput,
  auth: McpAuthContext,
): Promise<GetAccountOutput> {
  // 1. Scope gate.
  if (!auth.scope.split(/\s+/).includes('account:read')) {
    throw new Error('insufficient_scope');
  }

  // 2. Lazy monthly-transfer reset (mirrors GET /api/v0/usage), so the numbers
  //    we report match what the web Settings → Storage screen shows.
  await checkAndResetTransfer(auth.userId);

  // 3. All lookups are scoped to the authenticated user's own id.
  const user = await getUserByInternalId(auth.userId);
  if (!user) {
    throw new Error('user_not_found');
  }
  const quota = await getUserQuota(auth.userId);

  const diskUsageBytes = quota?.diskUsageBytes ?? user.diskUsageBytes ?? 0;
  const diskLimitBytes = quota?.diskLimitBytes ?? 0;
  const transferUsageBytes = quota?.transferUsageBytes ?? user.transferUsageBytes ?? 0;
  const transferLimitBytes = quota?.transferLimitBytes ?? 0;

  const diskPercent = diskLimitBytes > 0
    ? Math.round((diskUsageBytes / diskLimitBytes) * 100)
    : 0;
  const transferPercent = transferLimitBytes > 0
    ? Math.round((transferUsageBytes / transferLimitBytes) * 100)
    : 0;

  return {
    // user.id is the UUID (getUserByInternalId maps uuid → id). The internal
    // numeric id and the isAdmin flag are deliberately NOT exposed.
    id: user.id,
    email: user.email,
    plan: user.planName ?? null,
    disk: {
      usageBytes: diskUsageBytes,
      limitBytes: diskLimitBytes,
      percent: diskPercent,
    },
    transfer: {
      usageBytes: transferUsageBytes,
      limitBytes: transferLimitBytes,
      percent: transferPercent,
      resetAt: quota?.transferResetAt ?? null,
    },
  };
}
