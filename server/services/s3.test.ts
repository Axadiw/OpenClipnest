import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { story } from '../testing/story.js';

// Mock config
vi.mock('../config.js', () => ({
  CONFIG: {
    s3Endpoint: 'http://localhost:9000',
    s3AccessKey: 'testaccess',
    s3SecretKey: 'testsecret',
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    encryptionMasterKey: 'test-master-key-for-s3-tests',
  },
}));

// Mock Redis — `deleteObject` (and `deleteObjectsByPrefix`) calls
// `invalidateCachedHeadObject` which goes through `getRedis().del()`. Without
// a mock ioredis tries to connect to redis://redis:6379 and hangs the test.
// We don't assert on the Redis interaction in these tests (that's the
// cached-head-object module's concern); they just need a working stub.
vi.mock('../utils/redis.js', () => ({
  getRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
  }),
}));

import { setS3Client, putObject, getObject, headObject, deleteObject, listObjects, listEventFiles, deleteObjectsByPrefix } from './s3.js';

const testSalt = crypto.randomBytes(32).toString('base64url');

function createMockClient(sendFn: ReturnType<typeof vi.fn>) {
  return { send: sendFn } as unknown as S3Client;
}

describe('putObject', () => {
  it('sends PutObject with SSE-C headers', async (ctx) => {
    story(ctx, 'Każdy upload do S3 idzie z nagłówkami SSE-C — bez nich obiekt nie byłby zaszyfrowany kluczem usera i mogłoby dojść do wycieku przy kompromitacji bucketa.');
    const mockSend = vi.fn().mockResolvedValueOnce({});
    setS3Client(createMockClient(mockSend));
    const body = Buffer.from('test-data');

    await putObject('recordings', 'user123/file.mp4', body, testSalt, body.length);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('PutObjectCommand');
    expect(cmd.input.Bucket).toBe('recordings');
    expect(cmd.input.Key).toBe('user123/file.mp4');
    expect(cmd.input.SSECustomerAlgorithm).toBe('AES256');
    expect(cmd.input.SSECustomerKey).toBeTruthy();
    expect(cmd.input.SSECustomerKeyMD5).toBeTruthy();
    expect(cmd.input.ContentLength).toBe(body.length);
  });

  it('uses different SSE-C keys for different salts', async (ctx) => {
    story(ctx, 'Nagrania dwóch userów są szyfrowane różnymi kluczami — atakujący znający sól jednego konta nie otworzy obiektów drugiego.');
    const mockSend = vi.fn().mockResolvedValue({});
    setS3Client(createMockClient(mockSend));
    const salt2 = crypto.randomBytes(32).toString('base64url');

    await putObject('recordings', 'user1/file.mp4', Buffer.from('a'), testSalt);
    await putObject('recordings', 'user2/file.mp4', Buffer.from('b'), salt2);

    const key1 = mockSend.mock.calls[0][0].input.SSECustomerKey;
    const key2 = mockSend.mock.calls[1][0].input.SSECustomerKey;
    expect(key1).not.toBe(key2);
  });
});

describe('getObject', () => {
  it('sends GetObject with SSE-C headers', async (ctx) => {
    story(ctx, 'Pobranie obiektu używa tego samego klucza SSE-C co przy uploadzie — S3 zwraca zawartość tylko, gdy klucz pasuje, więc poprawny header to warunek odtwarzania wideo.');
    const mockSend = vi.fn().mockResolvedValueOnce({ Body: 'mockStream', ContentLength: 1024 });
    setS3Client(createMockClient(mockSend));

    const result = await getObject('recordings', 'user123/file.mp4', testSalt);

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('GetObjectCommand');
    expect(cmd.input.SSECustomerAlgorithm).toBe('AES256');
    expect(cmd.input.SSECustomerKey).toBeTruthy();
    expect(result.contentLength).toBe(1024);
  });

  it('passes Range header for partial content', async (ctx) => {
    story(ctx, 'Range request przechodzi do S3 bez zmian — player wideo może skoczyć do konkretnej sekundy nagrania bez pobierania całego pliku.');
    const mockSend = vi.fn().mockResolvedValueOnce({
      Body: 'mockStream',
      ContentLength: 500,
      ContentRange: 'bytes 0-499/1024',
    });
    setS3Client(createMockClient(mockSend));

    const result = await getObject('recordings', 'user123/file.mp4', testSalt, 'bytes=0-499');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Range).toBe('bytes=0-499');
    expect(result.contentRange).toBe('bytes 0-499/1024');
  });
});

describe('headObject', () => {
  it('returns content length + LastModified with SSE-C', async (ctx) => {
    story(ctx, 'HEAD z SSE-C zwraca rozmiar pliku + S3 LastModified bez ściągania body. ContentLength używa serwer wideo do Content-Length, LastModified jest authoritative źródłem dla file_metadata.uploaded_at (FIFO eviction key).');
    const lastMod = new Date('2026-04-29T12:34:56.000Z');
    const mockSend = vi.fn().mockResolvedValueOnce({ ContentLength: 2048, LastModified: lastMod });
    setS3Client(createMockClient(mockSend));

    const result = await headObject('recordings', 'user123/file.mp4', testSalt);

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('HeadObjectCommand');
    expect(cmd.input.SSECustomerAlgorithm).toBe('AES256');
    expect(result.contentLength).toBe(2048);
    expect(result.lastModified).toEqual(lastMod);
  });

  it('throws when S3 omits LastModified (no NOW() fallback poison)', async (ctx) => {
    story(ctx, 'Regression guard: S3-compat backend (MinIO or another S3-compatible store) który zwróciłby HEAD bez LastModified MUSI zostać odrzucony, bo callerzy używają tego pola jako klucza FIFO. Wcześniejszy bug: callerzy spadali na DEFAULT NOW(), zlepiając wszystkie historyczne pliki w jeden timestamp.');
    const mockSend = vi.fn().mockResolvedValueOnce({ ContentLength: 2048 });
    setS3Client(createMockClient(mockSend));

    await expect(headObject('recordings', 'user123/file.mp4', testSalt))
      .rejects.toThrow(/no LastModified/);
  });
});

describe('deleteObject', () => {
  it('sends DeleteObject without SSE-C headers', async (ctx) => {
    story(ctx, 'DELETE nie wymaga SSE-C (i nie powinno go przesyłać) — kasowanie obiektu to operacja na metadanych bucketa, a nie na treści.');
    const mockSend = vi.fn().mockResolvedValueOnce({});
    setS3Client(createMockClient(mockSend));

    await deleteObject('recordings', 'user123/file.mp4');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('DeleteObjectCommand');
    expect(cmd.input.Bucket).toBe('recordings');
    expect(cmd.input.Key).toBe('user123/file.mp4');
    expect(cmd.input.SSECustomerAlgorithm).toBeUndefined();
  });
});

describe('listObjects', () => {
  it('returns all objects under prefix', async (ctx) => {
    story(ctx, 'Scanner potrzebuje listy obiektów z prefiksu usera — podstawa pełnego rebuildu bazy nagrań z bucketa, gdy indeks DB się rozjedzie.');
    const mockSend = vi.fn().mockResolvedValueOnce({
      Contents: [
        { Key: 'user123/2026/04/07/file1.mp4', Size: 100, LastModified: new Date('2026-04-07') },
        { Key: 'user123/2026/04/07/file2.jpg', Size: 50 },
      ],
      IsTruncated: false,
    });
    setS3Client(createMockClient(mockSend));

    const results = await listObjects('recordings', 'user123/');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('ListObjectsV2Command');
    expect(cmd.input.Prefix).toBe('user123/');
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe('user123/2026/04/07/file1.mp4');
    expect(results[0].size).toBe(100);
  });

  it('handles pagination', async (ctx) => {
    story(ctx, 'ListObjectsV2 domyślnie oddaje max 1000 obiektów — scanner musi iterować przez ContinuationToken, inaczej zgubi część starych nagrań i UI będzie niekompletny.');
    const mockSend = vi.fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'user123/file1.mp4', Size: 100 }],
        IsTruncated: true,
        NextContinuationToken: 'token1',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'user123/file2.mp4', Size: 200 }],
        IsTruncated: false,
      });
    setS3Client(createMockClient(mockSend));

    const results = await listObjects('recordings', 'user123/');

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    // Verify continuation token was passed
    const cmd2 = mockSend.mock.calls[1][0];
    expect(cmd2.input.ContinuationToken).toBe('token1');
  });

  it('returns empty array when no objects', async (ctx) => {
    story(ctx, 'Pusty bucket/prefix nie rzuca błędu, tylko zwraca pustą listę — scanner gracefully obsługuje świeżo założone konto bez żadnych nagrań.');
    const mockSend = vi.fn().mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    setS3Client(createMockClient(mockSend));

    const results = await listObjects('recordings', 'user123/');
    expect(results).toHaveLength(0);
  });
});

describe('deleteObjectsByPrefix', () => {
  it('throws when DeleteObjects returns per-key errors so caller can retry', async (ctx) => {
    story(ctx, 'S3 zwraca 200 nawet gdy część kluczy nie usunęła się (per-key Errors w odpowiedzi). Worker user-deletion musi rzucić zamiast cicho zaliczyć — inaczej hardDeleteUser leci i pliki zostają orphanami w bucketcie (regresja z 2026-04-12: 16 plików stuck pod usuniętym userem przez 16 dni).');
    const mockSend = vi.fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'user123/a.mp4' },
          { Key: 'user123/b.mp4' },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'user123/b.mp4', Code: 'AccessDenied', Message: 'forbidden' }],
      });
    setS3Client(createMockClient(mockSend));

    await expect(deleteObjectsByPrefix('recordings', 'user123/')).rejects.toThrow(
      /1\/2 keys failed.*user123\/b\.mp4: AccessDenied: forbidden/,
    );
  });

  it('returns deleted count when no per-key errors', async (ctx) => {
    story(ctx, 'Happy path — wszystkie klucze usunięte, S3 zwraca pustą tablicę Errors. Worker dostaje liczbę usuniętych plików do auditu.');
    const mockSend = vi.fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'user123/a.mp4' }, { Key: 'user123/b.mp4' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] });
    setS3Client(createMockClient(mockSend));

    const removed = await deleteObjectsByPrefix('recordings', 'user123/');
    expect(removed).toBe(2);
  });

  it('returns 0 and skips DeleteObjects when prefix is empty', async (ctx) => {
    story(ctx, 'Pusty prefix nie wywołuje DeleteObjectsCommand — niepotrzebny round-trip.');
    const mockSend = vi.fn().mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    setS3Client(createMockClient(mockSend));

    const removed = await deleteObjectsByPrefix('recordings', 'gone/');
    expect(removed).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('listEventFiles', () => {
  const bucket = 'recordings';
  const userUuid = 'user-abc-123';
  const dateStr = '2026/04/12';
  const camera = 'cam01';
  const tsRaw = '20260412143000';
  const prefix = `${userUuid}/${dateStr}/${camera}_`;

  it('returns all files when all 3 are present', async (ctx) => {
    story(ctx, 'Kompletny event ma wide + zoom + thumbnail — przy kasowaniu wszystkie trzy muszą zostać znalezione, inaczej zostaną sieroty w buckecie.');
    const keys = [
      `${prefix}00_${tsRaw}.mp4`,
      `${prefix}01_${tsRaw}.mp4`,
      `${prefix}${tsRaw}.jpg`,
    ];
    const mockSend = vi.fn().mockResolvedValueOnce({
      Contents: keys.map(k => ({ Key: k, Size: 100 })),
      IsTruncated: false,
    });
    setS3Client(createMockClient(mockSend));

    const result = await listEventFiles(bucket, userUuid, dateStr, camera, tsRaw);

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(keys));
    // Verify the correct prefix was used
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Prefix).toBe(prefix);
  });

  it('returns only remaining 2 files when zoom is absent', async (ctx) => {
    story(ctx, 'Niektóre kamery mają tylko jeden obiektyw — skaner i delete powinny działać przy 2 plikach (wide + jpg), bez wymagania zoomu.');
    const keys = [
      `${prefix}00_${tsRaw}.mp4`,
      `${prefix}${tsRaw}.jpg`,
    ];
    const mockSend = vi.fn().mockResolvedValueOnce({
      Contents: keys.map(k => ({ Key: k, Size: 100 })),
      IsTruncated: false,
    });
    setS3Client(createMockClient(mockSend));

    const result = await listEventFiles(bucket, userUuid, dateStr, camera, tsRaw);

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(keys));
  });

  it('returns empty array when no files remain', async (ctx) => {
    story(ctx, 'Jeśli event już nie istnieje w buckecie, listEventFiles wraca z pustym wynikiem — kasowanie jest idempotentne i retry nie wywali się z błędem.');
    // Two resolutions: first for the canonical `{uuid}/{date}/{camera}_` probe,
    // second for the `{uuid}/` fallback scan that kicks in when the canonical
    // prefix is empty (used when a camera wrote to the wrong folder or root).
    const mockSend = vi.fn().mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    setS3Client(createMockClient(mockSend));

    const result = await listEventFiles(bucket, userUuid, dateStr, camera, tsRaw);

    expect(result).toHaveLength(0);
  });

  // Regression (2026-04-18): an event whose files all live under the user's
  // root (or in a wrong-dated folder) must still be found by listEventFiles.
  // The canonical `{uuid}/{date}/{camera}_` prefix misses them; the fallback
  // user-prefix scan catches them.
  it('falls back to user-prefix scan when the canonical date prefix is empty', async (ctx) => {
    story(ctx, 'Pliki wrzucone do roota usera (poza strukturą daty) nadal są znajdowane przy kasowaniu — regresja chroniąca przed sierotami po nietypowym uploadzie.');
    const rootKey = `${userUuid}/${camera}_00_${tsRaw}.mp4`;
    const mockSend = vi.fn()
      // Canonical prefix returns empty.
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
      // Fallback {uuid}/ scan returns the root-level file.
      .mockResolvedValueOnce({
        Contents: [{ Key: rootKey, Size: 100 }],
        IsTruncated: false,
      });
    setS3Client(createMockClient(mockSend));

    const result = await listEventFiles(bucket, userUuid, dateStr, camera, tsRaw);
    expect(result).toEqual([rootKey]);
  });

  it('does not match a key with a longer timestamp (false-positive protection)', async (ctx) => {
    story(ctx, 'Dwa eventy z podobnymi znacznikami czasu nie są mylone — ochrona przed przypadkowym skasowaniem nagrania innego eventu usera.');
    const longerTs = `${tsRaw}1`; // "202604121430001" — tsRaw + extra digit
    const falsePositiveKey = `${prefix}00_${longerTs}.mp4`;
    const realKey = `${prefix}00_${tsRaw}.mp4`;
    const mockSend = vi.fn().mockResolvedValueOnce({
      Contents: [
        { Key: falsePositiveKey, Size: 100 },
        { Key: realKey, Size: 100 },
      ],
      IsTruncated: false,
    });
    setS3Client(createMockClient(mockSend));

    const result = await listEventFiles(bucket, userUuid, dateStr, camera, tsRaw);

    // Only the key with _20260412143000. (dot after ts) should match
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(realKey);
    expect(result).not.toContain(falsePositiveKey);
  });
});
