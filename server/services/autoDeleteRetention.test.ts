import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';
import type { FileMetaRow } from '../db/queries/events.js';

const {
  mockGetOldestFileOlderThan,
  mockGetUsersWithRetention,
  mockEvictFile,
} = vi.hoisted(() => ({
  mockGetOldestFileOlderThan: vi.fn(),
  mockGetUsersWithRetention: vi.fn(),
  mockEvictFile: vi.fn(),
}));

vi.mock('../db/queries/events.js', () => ({
  getOldestFileOlderThan: (...args: unknown[]) => mockGetOldestFileOlderThan(...args),
}));

vi.mock('../db/queries/storage.js', () => ({
  getUsersWithRetention: (...args: unknown[]) => mockGetUsersWithRetention(...args),
}));

vi.mock('./autoDelete.js', () => ({
  evictFile: (...args: unknown[]) => mockEvictFile(...args),
}));

import { runRetentionForUser, runRetentionForAllUsers } from './autoDeleteRetention.js';

const USER_ID = 7;
const USER_UUID = 'cccc1111-2222-3333-4444-dddddddddddd';
const SALT = 'salt';

function makeFile(uploadedAtIso: string, sizeBytes = 1_000_000): FileMetaRow {
  return {
    id: 1,
    ownerId: USER_ID,
    s3Bucket: 'clipnest-recordings',
    s3Key: `${USER_UUID}/some/clip-${uploadedAtIso}.mp4`,
    originalFilename: 'clip.mp4',
    fileSizeBytes: sizeBytes,
    uploadedAt: uploadedAtIso,

  };
}

describe('autoDeleteRetention', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEvictFile.mockResolvedValue(0);
    mockGetOldestFileOlderThan.mockResolvedValue(null);
    mockGetUsersWithRetention.mockResolvedValue([]);
  });

  describe('runRetentionForUser', () => {
    it('walks files older than the cutoff until none remain', async (ctx) => {
      story(ctx, 'Retencja sprzata wszystkie pliki starsze niz okno — pojedynczy tick przemiela kolejne, az `getOldestFileOlderThan` zwroci null. To FIFO nie eventowo, wiec smieci nie eventowe tez wylatuja.');
      const f1 = makeFile('2026-01-01T00:00:00Z', 1_000_000);
      const f2 = makeFile('2026-01-02T00:00:00Z', 2_000_000);
      mockGetOldestFileOlderThan
        .mockResolvedValueOnce(f1)
        .mockResolvedValueOnce(f2)
        .mockResolvedValueOnce(null);
      mockEvictFile
        .mockResolvedValueOnce(f1.fileSizeBytes)
        .mockResolvedValueOnce(f2.fileSizeBytes);

      const r = await runRetentionForUser(USER_ID, USER_UUID, SALT, 7);

      expect(r.deleted).toBe(2);
      expect(r.freedBytes).toBe(3_000_000);
    });

    it('uses NOW() - days as the cutoff (passed to DB helper)', async (ctx) => {
      story(ctx, 'Cutoff jest budowany w TS, nie w SQL — sprawdzamy, ze DB helper dostaje datę odpowiadającą oknu retencji w dniach. To upewnia, ze user otrzyma efektywnie skasowane stare pliki, nie nowe.');
      const before = Date.now() - 10 * 24 * 60 * 60 * 1000;
      mockGetOldestFileOlderThan.mockResolvedValueOnce(null);

      await runRetentionForUser(USER_ID, USER_UUID, SALT, 10);

      expect(mockGetOldestFileOlderThan).toHaveBeenCalledTimes(1);
      const cutoff = mockGetOldestFileOlderThan.mock.calls[0][1] as Date;
      const after = Date.now() - 10 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after);
    });

    it('respects MAX_DELETIONS_PER_USER_PER_RUN cap', async (ctx) => {
      story(ctx, 'Hard cap 500 plików/tick chroni przed katastrofą gdy user ustawia retencje dni=1 na pełnym 10GB koncie — eviction rozkłada się na kolejne ticki zamiast wycinać wszystko jednym strzałem.');
      mockGetOldestFileOlderThan.mockResolvedValue(makeFile('2026-01-01T00:00:00Z', 1));
      mockEvictFile.mockResolvedValue(1);

      const r = await runRetentionForUser(USER_ID, USER_UUID, SALT, 7);

      expect(r.deleted).toBe(500);
    });

    it('returns 0 / 0 when days <= 0 (no-op input)', async (ctx) => {
      story(ctx, 'days <= 0 traktujemy jako brak retencji — endpoint API odrzuca takie wartości, ale serwis broni się dodatkowo, gdyby wewnętrzny caller pomylił semantykę.');
      const r = await runRetentionForUser(USER_ID, USER_UUID, SALT, 0);
      expect(r).toEqual({ deleted: 0, freedBytes: 0 });
      expect(mockGetOldestFileOlderThan).not.toHaveBeenCalled();
    });
  });

  describe('runRetentionForAllUsers', () => {
    it('iterates only users with retention configured + active salt', async (ctx) => {
      story(ctx, 'Cron tickuje wszystkich z auto_delete_after_days IS NOT NULL — userzy bez salt-a (provisioning niezakończony) są pomijani, żeby evictFile nie pad zwyczajem na nieprawidłowych danych.');
      mockGetUsersWithRetention.mockResolvedValueOnce([
        { id: 1, uuid: 'u1', encryptionSalt: 'salt1', autoDeleteAfterDays: 7 },
        { id: 2, uuid: 'u2', encryptionSalt: null, autoDeleteAfterDays: 30 }, // skipped
        { id: 3, uuid: 'u3', encryptionSalt: 'salt3', autoDeleteAfterDays: 14 },
      ]);
      mockGetOldestFileOlderThan.mockResolvedValue(null);

      const r = await runRetentionForAllUsers();

      expect(r.usersProcessed).toBe(3);
      // Only users 1 and 3 should hit the helper (user 2 is skipped — no salt).
      const calls = mockGetOldestFileOlderThan.mock.calls.map(c => c[0]);
      expect(calls).toContain(1);
      expect(calls).toContain(3);
      expect(calls).not.toContain(2);
    });

    it('does not abort on per-user failure', async (ctx) => {
      story(ctx, 'Pad jednego usera nie może zatrzymać retencji innych — log + przejście dalej. Inaczej pojedynczy korupt rekord zablokowałby cleanup wszystkich pozostałych użytkowników.');
      mockGetUsersWithRetention.mockResolvedValueOnce([
        { id: 1, uuid: 'u1', encryptionSalt: 's1', autoDeleteAfterDays: 7 },
        { id: 2, uuid: 'u2', encryptionSalt: 's2', autoDeleteAfterDays: 7 },
      ]);
      mockGetOldestFileOlderThan
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce(null);

      const r = await runRetentionForAllUsers();

      expect(r.usersProcessed).toBe(2);
      expect(r.totalDeleted).toBe(0); // user 1 errored, user 2 had no eligible files
    });
  });
});
