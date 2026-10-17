import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';
import { installMetricsRecorder, noopRecorder } from '../utils/metrics.js';
import playbackRouter from './playback.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v0/playback', playbackRouter);
  return app;
}

// The route emits through the metrics facade; a spy recorder captures what
// would reach the edition's metrics store (Prometheus in Clipnest Cloud).
const started: string[] = [];
const completed: string[] = [];

describe('POST /api/v0/playback', () => {
  beforeEach(() => {
    started.length = 0;
    completed.length = 0;
    installMetricsRecorder({
      ...noopRecorder,
      recordPlaybackStarted: (platform) => { started.push(platform); },
      recordPlaybackCompleted: (platform) => { completed.push(platform); },
    });
  });

  it('counts a start and a completion against the reporting platform', async (ctx) => {
    story(
      ctx,
      'Beacon jest jedynym miejscem, w którym da się rozróżnić "zaczął oglądać" od "obejrzał do końca" — serwer widzi wyłącznie range requesty, a te nie odróżniają oglądania od przewijania. Klient wysyła `started` przy pierwszym realnym starcie danego źródła i `completed` przy zdarzeniu `ended`.',
    );
    const app = createApp();

    expect((await request(app).post('/api/v0/playback').send({ kind: 'started', platform: 'web' })).status).toBe(204);
    await request(app).post('/api/v0/playback').send({ kind: 'completed', platform: 'web' });

    expect(started).toEqual(['web']);
    expect(completed).toEqual(['web']);
  });

  it('buckets an unknown platform instead of minting a new label value', async (ctx) => {
    story(
      ctx,
      'Ciało requestu jest danymi spoza zaufanej granicy. Gdyby `platform` trafiało do etykiety wprost, pętla POST-ów z losowymi stringami tworzyłaby nieograniczoną liczbę serii czasowych i wywróciła Prometheusa — to podatność na DoS. Każda nieznana wartość ląduje w `other`.',
    );
    const app = createApp();
    await request(app).post('/api/v0/playback').send({ kind: 'started', platform: 'my-fridge' });

    expect(started).toEqual(['other']);
  });

  it('answers 204 to a malformed body without counting anything', async (ctx) => {
    story(
      ctx,
      'Beacon nie może stać się błędem, który odtwarzacz musi obsłużyć: leci w tle, gdy użytkownik ogląda film, a zła statystyka jest tańsza niż nieudany request na ścieżce odtwarzania. Nieznany `kind` jest więc po cichu ignorowany — 204, zero inkrementacji.',
    );
    const app = createApp();

    expect((await request(app).post('/api/v0/playback').send({})).status).toBe(204);
    expect((await request(app).post('/api/v0/playback').send({ kind: 'paused', platform: 'web' })).status).toBe(204);

    expect(started).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  it('persists nothing — the handler touches no database', async (ctx) => {
    story(
      ctx,
      'To jest cała umowa prywatnościowa tego endpointu: liczniki agregatowe zamiast historii oglądania. Router nie importuje warstwy bazy, więc nie istnieje wiersz wiążący użytkownika z tym, co obejrzał, i dlatego ta funkcja nie wymaga zmiany Polityki Prywatności. Test pilnowany strukturalnie — gdyby ktoś dołożył zapis do bazy, import się pojawi i test padnie.',
    );
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./playback.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/from '\.\.\/db\//);
    expect(src).not.toMatch(/insert|INSERT INTO/);
  });
});
