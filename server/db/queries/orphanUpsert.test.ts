import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../../testing/story.js';

/**
 * Unit tests for the batched orphan upsert.
 *
 * `db` is mocked at the builder level: we only care about how many statements
 * are issued and what rows each one carries — the SQL itself is covered by the
 * DB-backed reconciler tests.
 */
const values = vi.fn();
const onConflictDoUpdate = vi.fn();
const insert = vi.fn();

vi.mock('../index.js', () => ({
  db: {
    insert: (...a: unknown[]) => {
      insert(...a);
      return {
        values: (rows: unknown) => {
          values(rows);
          return { onConflictDoUpdate: (cfg: unknown) => onConflictDoUpdate(cfg) };
        },
      };
    },
  },
}));
vi.mock('../schema.js', () => ({ storageOrphanObjects: { s3Bucket: 's3Bucket', s3Key: 's3Key', seenCount: 'seenCount' } }));

const { upsertOrphanObjects } = await import('./storage.js');

beforeEach(() => vi.clearAllMocks());

const row = (key: string, size = 10) => ({ s3Bucket: 'thumbs', s3Key: key, sizeBytes: size });

describe('upsertOrphanObjects', () => {
  it('issues nothing for an empty list', async (ctx) => {
    story(ctx, 'Pusty sweep nie może kosztować round-tripu — najczęstszy przypadek po wyczyszczeniu nawisu.');
    await upsertOrphanObjects([]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('collapses many orphans into ONE statement', async (ctx) => {
    story(
      ctx,
      'Sedno poprawki. Wersja jednowierszowa była awaitowana w pętli po obiektach, więc przebieg robił jeden round-trip NA SIEROTĘ: 58 989 x ~8,5 ms = ~500 s przy deadline 540 s. Job ginął na DeadlineExceeded, a że reconciliacja leci pierwsza, retencja i quota tidy nigdy się nie wykonywały.',
    );
    await upsertOrphanObjects([row('a.jpg'), row('b.jpg'), row('c.jpg')]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toHaveLength(3);
  });

  it('chunks past the parameter ceiling instead of building one giant statement', async (ctx) => {
    story(
      ctx,
      'Postgres przyjmuje maksymalnie 65535 parametrów w jednym zapytaniu. Bez dzielenia pełny sweep (setki tysięcy obiektów) wywaliłby się na tym limicie — czyli poprawka wydajności zamieniłaby powolny job w job całkowicie zepsuty.',
    );
    const rows = Array.from({ length: 1250 }, (_, i) => row(`k${i}.jpg`));
    await upsertOrphanObjects(rows);

    expect(insert).toHaveBeenCalledTimes(3); // 500 + 500 + 250
    expect(values.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([500, 500, 250]);
  });

  it('deduplicates on (bucket, key) so a repeat cannot abort the statement', async (ctx) => {
    story(
      ctx,
      'Postgres ODRZUCA całe zapytanie, gdy lista VALUES trafia dwa razy w ten sam wiersz konfliktu — „ON CONFLICT DO UPDATE command cannot affect row a second time". To twardy błąd, nie pominięty wiersz, więc JEDEN duplikat przerwałby cały sweep. Wersja jednowierszowa była na to odporna, bo każdy wiersz szedł osobnym zapytaniem — batchowanie wprowadza to ryzyko i musi je samo domknąć.',
    );
    await upsertOrphanObjects([row('dup.jpg', 10), row('other.jpg', 20), row('dup.jpg', 30)]);

    const sent = values.mock.calls[0][0] as Array<{ s3Key: string; sizeBytes: number }>;
    expect(sent).toHaveLength(2);
    // Last write wins, matching the sequential version's behaviour.
    expect(sent.find((r) => r.s3Key === 'dup.jpg')?.sizeBytes).toBe(30);
  });

  it('treats the same key in different buckets as distinct rows', async (ctx) => {
    story(
      ctx,
      'Klucz konfliktu to (bucket, key), nie sam key. Sidecar i miniatura mogą dzielić ścieżkę w różnych bucketach — deduplikacja po samym kluczu po cichu gubiłaby jedną z sierot i nigdy by jej nie posprzątała.',
    );
    await upsertOrphanObjects([
      { s3Bucket: 'thumbs', s3Key: 'same/path', sizeBytes: 1 },
      { s3Bucket: 'sidecars', s3Key: 'same/path', sizeBytes: 2 },
    ]);

    expect(values.mock.calls[0][0]).toHaveLength(2);
  });
});
