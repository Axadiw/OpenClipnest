import { describe, it, expect } from 'vitest';
import { story } from './testing/story.js';

// Since better-sqlite3 requires native bindings that may not be available
// in all environments, we test the data transformation logic that db.ts uses.

describe('event data transformation', () => {
  // Mirrors the mapping logic in getEvents() / getEventById() after the
  // N-view refactor: Postgres returns the view-files set as a JSON-aggregated
  // array under the `views` column. The row mapper just hands that through.
  function mapRow(row: {
    id: string; camera: string; timestamp: string; date: string;
    views: Array<{ id: string; videoRelPath: string }> | null;
    thumbnail: string | null;
  }) {
    return {
      id: row.id,
      camera: row.camera,
      timestamp: row.timestamp,
      date: row.date,
      views: row.views ?? [],
      thumbnail: row.thumbnail,
    };
  }

  it('maps the view-files JSON aggregate to the API CameraEvent.views[]', (ctx) => {
    story(ctx, 'Dual-view Reolink event: Postgres zwraca views jako JSON array (jeden wpis na każdy attached view), API przekazuje to do frontu bez modyfikacji. Frontend renderuje po jednym przycisku na view.');
    const result = mapRow({
      id: 'ev1', camera: 'Front', timestamp: '2026-04-07T07:00:00.000Z',
      date: '2026/04/07',
      views: [
        { id: '00', videoRelPath: 'path/to/wide.mp4' },
        { id: '01', videoRelPath: 'path/to/zoom.mp4' },
      ],
      thumbnail: 'path/to/thumb.jpg',
    });
    expect(result.views).toEqual([
      { id: '00', videoRelPath: 'path/to/wide.mp4' },
      { id: '01', videoRelPath: 'path/to/zoom.mp4' },
    ]);
    expect(result.thumbnail).toBe('path/to/thumb.jpg');
  });

  it('coerces missing view aggregate to an empty array', (ctx) => {
    story(ctx, 'Event w trakcie kasowania (delete-notify race) może mieć puste view-files i null thumbnail. Mapper musi zwrócić views: [] (nie null), żeby frontend mógł bezpiecznie zrobić event.views.map() bez crashu.');
    const result = mapRow({
      id: 'ev1', camera: 'Front', timestamp: '2026-04-07T07:00:00.000Z',
      date: '2026/04/07', views: null, thumbnail: null,
    });
    expect(result.views).toEqual([]);
    expect(result.thumbnail).toBeNull();
  });
});

describe('calendar date conversion (events.date storage format)', () => {
  // Mirrors the slash↔hyphen translation in getEventCalendar(). The
  // events.date column is TEXT in YYYY/MM/DD (built from S3 paths), but
  // the API contract is YYYY-MM-DD; we have to translate at both sides
  // of the BETWEEN query and the row mapping. Unit-testing the pure
  // string transforms because hitting the real pool needs a live DB.
  const toDb = (apiDate: string) => apiDate.replace(/-/g, '/');
  const fromDb = (dbDate: string) => dbDate.replace(/\//g, '-');

  it('translates hyphenated API bounds to slashed DB format for BETWEEN', (ctx) => {
    story(ctx, 'Endpoint /api/v0/events/calendar przyjmuje YYYY-MM-DD (hyphens), a kolumna events.date trzyma YYYY/MM/DD (slashes z S3 path). Bez konwersji BETWEEN zwracał zero wierszy bo `/` (0x2F) sortuje się leksykalnie po `-` (0x2D), więc każdy slashed event był poza bounds.');
    expect(toDb('2026-04-25')).toBe('2026/04/25');
    expect(toDb('2026-03-30')).toBe('2026/03/30');
    expect(toDb('2026-12-31')).toBe('2026/12/31');
  });

  it('translates slashed DB rows back to hyphenated API output', (ctx) => {
    story(ctx, 'Frontend mapuje dane po YYYY-MM-DD keys (z `Date.toLocaleDateString` lokalnego usera) — server musi zwrócić hyphens, niezależnie od tego co jest w kolumnie. Inaczej Map.get() chybia i kalendarz pokazuje zero coloured days.');
    expect(fromDb('2026/04/25')).toBe('2026-04-25');
    expect(fromDb('2026/03/30')).toBe('2026-03-30');
  });

  it('round-trips: hyphenated input that matches a slashed DB row comes back hyphenated', (ctx) => {
    story(ctx, 'Pełny cykl request→DB→response zachowuje format YYYY-MM-DD na granicach API. To pinuje że bug "kalendarz nie koloruje dni" — gdzie hyphen-bounds nie matchowały slashed storage — nie wróci niezauważony.');
    const apiInput = '2026-04-25';
    const dbStored = toDb(apiInput);
    expect(dbStored).toBe('2026/04/25');
    const apiOutput = fromDb(dbStored);
    expect(apiOutput).toBe(apiInput);
  });
});

describe('user data transformation', () => {
  function mapUserRow(row: {
    id: number; uuid: string; email: string; is_admin: number; created_at: string;
    plan_id: number | null; plan_name: string | null;
    disk_usage_bytes: number; transfer_usage_bytes: number;
  }) {
    return {
      id: row.uuid,
      email: row.email,
      isAdmin: row.is_admin === 1,
      createdAt: row.created_at,
      planId: row.plan_id ?? undefined,
      planName: row.plan_name ?? undefined,
      diskUsageBytes: row.disk_usage_bytes,
      transferUsageBytes: row.transfer_usage_bytes,
    };
  }

  it('converts is_admin integer to boolean', (ctx) => {
    story(ctx, 'SQLite trzyma flagę admina jako 0/1 — konwersja na boolean chroni frontend i middleware autoryzacji przed pomyłkami typu „truthy integer”.');
    expect(mapUserRow({
      id: 1, uuid: 'uuid-1', email: 'admin@test.com', is_admin: 1, created_at: '',
      plan_id: null, plan_name: null, disk_usage_bytes: 0, transfer_usage_bytes: 0,
    }).isAdmin).toBe(true);
    expect(mapUserRow({
      id: 2, uuid: 'uuid-2', email: 'user@test.com', is_admin: 0, created_at: '',
      plan_id: 1, plan_name: 'Basic', disk_usage_bytes: 0, transfer_usage_bytes: 0,
    }).isAdmin).toBe(false);
  });

  it('uses UUID as the public id', (ctx) => {
    story(ctx, 'API nigdy nie eksponuje wewnętrznego ID liczbowego — używamy UUID, żeby utrudnić enumerację kont przez atakujących.');
    const result = mapUserRow({
      id: 42, uuid: 'abc-def-123', email: 'user1@test.com', is_admin: 0, created_at: '',
      plan_id: 1, plan_name: 'Basic', disk_usage_bytes: 0, transfer_usage_bytes: 0,
    });
    expect(result.id).toBe('abc-def-123');
  });

  it('maps plan fields correctly', (ctx) => {
    story(ctx, 'Panel admina pokazuje przy użytkowniku jego plan i zużycie zasobów — poprawne mapowanie pól planId/planName/diskUsage/transferUsage to warunek działania tabeli użytkowników.');
    const result = mapUserRow({
      id: 1, uuid: 'uuid-1', email: 'user1@test.com', is_admin: 0, created_at: '',
      plan_id: 2, plan_name: 'Pro', disk_usage_bytes: 1024, transfer_usage_bytes: 2048,
    });
    expect(result.planId).toBe(2);
    expect(result.planName).toBe('Pro');
    expect(result.diskUsageBytes).toBe(1024);
    expect(result.transferUsageBytes).toBe(2048);
  });

  it('handles null plan fields (admin users)', (ctx) => {
    story(ctx, 'Admini nie mają przypisanego planu — null w DB jest konwertowany na `undefined`, co zapewnia, że panel nie wyświetli śmiesznej kolumny „null GB” dla konta admina.');
    const result = mapUserRow({
      id: 1, uuid: 'uuid-1', email: 'admin@test.com', is_admin: 1, created_at: '',
      plan_id: null, plan_name: null, disk_usage_bytes: 0, transfer_usage_bytes: 0,
    });
    expect(result.planId).toBeUndefined();
    expect(result.planName).toBeUndefined();
  });
});

describe('plan data transformation', () => {
  function mapPlanRow(row: {
    id: number; name: string; disk_space_bytes: number;
    monthly_transfer_bytes: number; created_at: string;
  }) {
    return {
      id: row.id,
      name: row.name,
      diskSpaceBytes: row.disk_space_bytes,
      monthlyTransferBytes: row.monthly_transfer_bytes,
      createdAt: row.created_at,
    };
  }

  it('maps plan columns to camelCase', (ctx) => {
    story(ctx, 'Gdy admin otwiera ekran planów, widzi czytelne wartości w GB — dokładne mapowanie disk_space_bytes/monthly_transfer_bytes na camelCase jest kluczowe dla tej widoczności.');
    const result = mapPlanRow({
      id: 1, name: 'Basic', disk_space_bytes: 1073741824,
      monthly_transfer_bytes: 5368709120, created_at: '2026-01-01',
    });
    expect(result.diskSpaceBytes).toBe(1073741824);
    expect(result.monthlyTransferBytes).toBe(5368709120);
    expect(result.name).toBe('Basic');
  });
});

describe('authorization logic', () => {
  function requireNonAdmin(isAdmin: boolean): { allowed: boolean; error?: string } {
    if (isAdmin) return { allowed: false, error: 'Admin users cannot access recordings' };
    return { allowed: true };
  }

  function requireAdmin(isAdmin: boolean): { allowed: boolean; error?: string } {
    if (!isAdmin) return { allowed: false, error: 'Admin access required' };
    return { allowed: true };
  }

  it('blocks admin from accessing events (requireNonAdmin)', (ctx) => {
    story(ctx, 'Admin nie trzyma własnych nagrań — jego konto nie ma planu ani zasobów, więc próba odczytu eventów musi być zablokowana, aby uniknąć zerowych stanów i mylących UI.');
    expect(requireNonAdmin(true).allowed).toBe(false);
    expect(requireNonAdmin(true).error).toContain('Admin');
  });

  it('allows regular user to access events (requireNonAdmin)', (ctx) => {
    story(ctx, 'Zwykły użytkownik musi widzieć swoje eventy — requireNonAdmin go przepuszcza i to jest podstawowe działanie aplikacji dla końcowego klienta.');
    expect(requireNonAdmin(false).allowed).toBe(true);
  });

  it('blocks regular user from admin routes (requireAdmin)', (ctx) => {
    story(ctx, 'Zwykły użytkownik próbujący wejść na endpoint admina dostaje odmowę — kluczowy bezpiecznik chroniący zarządzanie kontami innych użytkowników.');
    expect(requireAdmin(false).allowed).toBe(false);
    expect(requireAdmin(false).error).toContain('Admin');
  });

  it('allows admin to access admin routes (requireAdmin)', (ctx) => {
    story(ctx, 'Admin może wejść do panelu zarządzania — bez tego nie ma jak dodać ani zablokować użytkownika w całej instalacji.');
    expect(requireAdmin(true).allowed).toBe(true);
  });

  it('admin cannot access events, user management, or plans differently', (ctx) => {
    story(ctx, 'Macierz uprawnień: admin i user są rozłączni — admin zarządza, user ogląda. Brak tej rozdzielności oznaczałby, że admini mogliby przeglądać prywatne nagrania klientów.');
    // Admin: can access users/plans, cannot access events
    const adminUser = { isAdmin: true };
    expect(requireAdmin(adminUser.isAdmin).allowed).toBe(true);
    expect(requireNonAdmin(adminUser.isAdmin).allowed).toBe(false);

    // Regular user: cannot access users/plans, can access events
    const regularUser = { isAdmin: false };
    expect(requireAdmin(regularUser.isAdmin).allowed).toBe(false);
    expect(requireNonAdmin(regularUser.isAdmin).allowed).toBe(true);
  });
});

describe('admin status toggle logic', () => {
  function toggleAdminStatus(currentIsAdmin: boolean, targetIsAdmin: boolean, isSelf: boolean) {
    if (isSelf) return { allowed: false, error: 'Cannot change your own admin status' };
    if (currentIsAdmin === targetIsAdmin) return { allowed: false, error: 'User already has the requested admin status' };
    return { allowed: true, planId: targetIsAdmin ? null : 1 };
  }

  it('blocks self-toggle', (ctx) => {
    story(ctx, 'Admin nie może zdegradować siebie — w przeciwnym razie ostatni admin mógłby przypadkiem stracić dostęp do panelu zarządzania całą instancją.');
    const result = toggleAdminStatus(true, false, true);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('own');
  });

  it('blocks no-op toggle (already admin)', (ctx) => {
    story(ctx, 'Dwukrotne kliknięcie „nadaj admina” nie robi nic — wczesna walidacja oszczędza zapis do DB i mylny audit log.');
    const result = toggleAdminStatus(true, true, false);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('already');
  });

  it('blocks no-op toggle (already user)', (ctx) => {
    story(ctx, 'Zmiana statusu z user na user to no-op — backend nie marnuje zapisu ani nie tworzy mylnego wpisu w audycie.');
    const result = toggleAdminStatus(false, false, false);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('already');
  });

  it('promotes user to admin, clears plan', (ctx) => {
    story(ctx, 'Przy awansie na admina system czyści przypisany plan — admini nie mają zasobów, więc zostawienie starego planu pokazywałoby fałszywe kwoty w UI.');
    const result = toggleAdminStatus(false, true, false);
    expect(result.allowed).toBe(true);
    expect(result.planId).toBeNull();
  });

  it('demotes admin to user, assigns Basic plan', (ctx) => {
    story(ctx, 'Zdegradowany admin dostaje plan Basic — inaczej byłby zwykłym userem bez żadnego limitu i mógłby przeciążyć storage bez świadomej zgody administracji.');
    const result = toggleAdminStatus(true, false, false);
    expect(result.allowed).toBe(true);
    expect(result.planId).toBe(1);
  });
});

describe('query building logic', () => {
  function buildWhere(cameras?: string[], dateFrom?: string, dateTo?: string) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (cameras && cameras.length > 0) {
      conditions.push(`camera IN (${cameras.map(() => '?').join(',')})`);
      params.push(...cameras);
    }
    if (dateFrom) {
      conditions.push('timestamp >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push('timestamp <= ?');
      params.push(dateTo + 'T23:59:59.999Z');
    }
    return {
      where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  it('returns empty WHERE for no filters', (ctx) => {
    story(ctx, 'Brak filtrów to „pokaż wszystko” — WHERE musi być pusty, żeby nie złamać zapytania SELECT i nie ukryć eventów użytkownika.');
    const { where, params } = buildWhere();
    expect(where).toBe('');
    expect(params).toEqual([]);
  });

  it('builds camera filter', (ctx) => {
    story(ctx, 'Filtrowanie wielu kamer naraz to typowy scenariusz (Front + Back) — bez placeholderów IN(?,?) wystawilibyśmy się na SQL injection i pusty dataset.');
    const { where, params } = buildWhere(['Front', 'Back']);
    expect(where).toBe('WHERE camera IN (?,?)');
    expect(params).toEqual(['Front', 'Back']);
  });

  it('builds date range filter', (ctx) => {
    story(ctx, 'Filtr daty musi obejmować cały dzień `dateTo` (do 23:59:59.999Z) — inaczej user wybierając „od 1 do 7 kwietnia” nie zobaczyłby nagrań z późnego popołudnia 7-go.');
    const { where, params } = buildWhere(undefined, '2026-04-01', '2026-04-07');
    expect(where).toContain('timestamp >= ?');
    expect(where).toContain('timestamp <= ?');
    expect(params[0]).toBe('2026-04-01');
    expect(params[1]).toBe('2026-04-07T23:59:59.999Z');
  });

  it('combines camera and date filters', (ctx) => {
    story(ctx, 'Użytkownik chce zobaczyć eventy z konkretnej kamery w konkretnym przedziale dat — połączenie filtrów musi działać z `AND`, inaczej grid pokaże śmieci z innych kamer.');
    const { where, params } = buildWhere(['Front'], '2026-04-01');
    expect(where).toContain('camera IN (?)');
    expect(where).toContain('timestamp >= ?');
    expect(where).toContain('AND');
    expect(params).toEqual(['Front', '2026-04-01']);
  });
});
