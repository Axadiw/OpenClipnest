import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { ddlWithDeadlockRetry } from './migrate-schema.js';

function fakePool(failures: Array<{ code: string }>): { pool: Pool; calls: string[] } {
  const calls: string[] = [];
  const queue = [...failures];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      const next = queue.shift();
      if (next) throw Object.assign(new Error('boom'), next);
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('ddlWithDeadlockRetry', () => {
  it('runs the statement again when it was the deadlock victim', async () => {
    const { pool, calls } = fakePool([{ code: '40P01' }, { code: '40P01' }]);
    await ddlWithDeadlockRetry(pool, 'DROP SCHEMA x CASCADE');
    expect(calls).toHaveLength(3);
  });

  it('gives up after the attempt budget', async () => {
    const { pool, calls } = fakePool(Array.from({ length: 5 }, () => ({ code: '40P01' })));
    await expect(ddlWithDeadlockRetry(pool, 'DROP SCHEMA x CASCADE', 3)).rejects.toThrow('boom');
    expect(calls).toHaveLength(3);
  });

  it('does not hide any other error', async () => {
    const { pool, calls } = fakePool([{ code: '42P01' }]);
    await expect(ddlWithDeadlockRetry(pool, 'DROP SCHEMA x CASCADE')).rejects.toThrow('boom');
    expect(calls).toHaveLength(1);
  });
});
