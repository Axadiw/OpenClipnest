import { describe, it, expect } from 'vitest';
import { parseTimelineUrlParams, serializeInlineVideoToParams, clampSeekToDuration } from './timelineUrlState';
import type { CameraEvent } from '../types';
import { story } from '../test-story';

function mk(params: Record<string, string>) {
  return new URLSearchParams(params);
}

const mkEvent = (id = 'evt_1'): CameraEvent => ({
  id,
  camera: 'Front',
  timestamp: '2026-05-17T12:00:00.000Z',
  date: '2026-05-17',
  views: [{ id: '00', videoRelPath: 'wide.mp4' }],
  thumbnail: null,
});

describe('parseTimelineUrlParams', () => {
  it('returns null when event is missing', (ctx) => {
    story(ctx, 'Goły /timeline (bez ?event=) musi wpaść w fallback "auto-play najnowszego" — parser nie udaje, że event jest pusty.');
    expect(parseTimelineUrlParams(mk({ view: 'wide' }))).toBeNull();
    expect(parseTimelineUrlParams(mk({ event: '', view: 'wide' }))).toBeNull();
  });

  it('returns null when view is missing or too long', (ctx) => {
    story(ctx, 'View jest profile-defined string (Reolink 00/01, custom A/B/etc.). Parser przepuszcza dowolny string długości 1..16; pusty lub przekraczający limit jest odrzucany. Resolver na poziomie wyższym potem sprawdza czy event w ogóle ma taki view.');
    expect(parseTimelineUrlParams(mk({ event: 'evt_1' }))).toBeNull();
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: '' }))).toBeNull();
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'x'.repeat(17) }))).toBeNull();
    // Arbitrary 3-char view id is now valid — the resolver decides whether
    // it actually matches an attached view on the event.
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'foo' }))).toEqual({
      eventId: 'evt_1',
      view: 'foo',
      seekSec: null,
    });
  });

  it('parses event + view without t', (ctx) => {
    story(ctx, 'Najprostszy share-link: event + view. Player leci od początku klipu — taki sam kontrakt jak w trybie grid.');
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide' }))).toEqual({
      eventId: 'evt_1',
      view: 'wide',
      seekSec: null,
    });
    expect(parseTimelineUrlParams(mk({ event: 'evt_2', view: 'zoom' }))).toEqual({
      eventId: 'evt_2',
      view: 'zoom',
      seekSec: null,
    });
  });

  it('parses integer t', (ctx) => {
    story(ctx, 'Refresh w trakcie odtwarzania → URL miał ?t=12 → player ma wskoczyć na 12. sekundę klipu.');
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide', t: '12' }))?.seekSec).toBe(12);
  });

  it('accepts float t', (ctx) => {
    story(ctx, 'Seek z timeline może wpaść jako float (Math.round nastąpi przy zapisie, ale parser nie odrzuca).');
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide', t: '12.7' }))?.seekSec).toBe(12.7);
  });

  it('ignores negative t but keeps event+view', (ctx) => {
    story(ctx, '?t=-5 to ewidentny śmieć (ktoś ręcznie pomajstrował URL) — ignorujemy `t`, ale klip i obiektyw zostają, żeby user nie wylądował na losowym evencie.');
    const r = parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide', t: '-5' }));
    expect(r).toEqual({ eventId: 'evt_1', view: 'wide', seekSec: null });
  });

  it('ignores non-numeric t but keeps event+view', (ctx) => {
    story(ctx, '?t=abc → po prostu zignoruj `t`. Event+view nadal wiążą.');
    const r = parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide', t: 'abc' }));
    expect(r).toEqual({ eventId: 'evt_1', view: 'wide', seekSec: null });
  });

  it('accepts t=0', (ctx) => {
    story(ctx, 'Zero to legalna pozycja seeku (początek klipu). Nie wolno potraktować go jako "ignoruj".');
    expect(parseTimelineUrlParams(mk({ event: 'evt_1', view: 'wide', t: '0' }))?.seekSec).toBe(0);
  });
});

describe('serializeInlineVideoToParams', () => {
  it('returns all-null for null video', (ctx) => {
    story(ctx, 'Brak inlineVideo (np. zamknięty player gdyby ktoś kiedyś dodał close button) → kasujemy event/view/t z URL.');
    expect(serializeInlineVideoToParams(null)).toEqual({ event: null, view: null, t: null });
  });

  it('serializes event + view without t when seekSec missing', (ctx) => {
    story(ctx, 'Klik baru bez świadomego seeku — URL łapie event+view, ale `t` zostaje pusty, żeby refresh leciał od początku klipu.');
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'wide' })).toEqual({
      event: 'evt_1',
      view: 'wide',
      t: null,
    });
  });

  it('rounds seekSec to integer string', (ctx) => {
    story(ctx, 'Zaokrąglamy do integera — sekundowa precyzja wystarczy do share-linku, a krótkie ?t= ładniej wygląda w URL.');
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'zoom', seekSec: 7.4 })).toEqual({
      event: 'evt_1',
      view: 'zoom',
      t: '7',
    });
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'zoom', seekSec: 7.6 })).toEqual({
      event: 'evt_1',
      view: 'zoom',
      t: '8',
    });
  });

  it('serializes seekSec=0 as "0"', (ctx) => {
    story(ctx, 'Klik dokładnie na początek baru → seekSec=0 → ?t=0. Nie chcemy żeby zero wyleciało z URL-a, bo wtedy refresh pominąłby tę informację.');
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'wide', seekSec: 0 })).toEqual({
      event: 'evt_1',
      view: 'wide',
      t: '0',
    });
  });

  it('drops NaN/negative seekSec', (ctx) => {
    story(ctx, 'NaN/ujemne seekSec to "no signal" — nie zapisujemy, żeby URL nie kłamał o pozycji odtwarzania.');
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'wide', seekSec: NaN }).t).toBeNull();
    expect(serializeInlineVideoToParams({ event: mkEvent('evt_1'), view: 'wide', seekSec: -3 }).t).toBeNull();
  });
});

describe('clampSeekToDuration', () => {
  it('passes seekSec through when comfortably inside the clip', (ctx) => {
    story(ctx, 'Normalny share-link na środek klipu — clamp nic nie rusza, player wskakuje dokładnie tam gdzie URL prosi.');
    expect(clampSeekToDuration(30, 60)).toBe(30);
    expect(clampSeekToDuration(0, 60)).toBe(0);
    expect(clampSeekToDuration(7, 13.018)).toBe(7);
  });

  it('clamps to 1 s before end when t equals duration', (ctx) => {
    story(ctx, 'Główny bug z HAR-a: ?t=13 na klipie 13.018 s blokuje player na "Seeking…" przez 60 s, bo deferred-seek wpada w nudge-loop dla broken-moov. Clamp ucina do 12.018 — player gra od ~ sekundy przed końcem, overlay znika.');
    expect(clampSeekToDuration(13, 13.018)).toBe(12.018);
    expect(clampSeekToDuration(60, 60)).toBe(59);
  });

  it('clamps to 1 s before end when t is past duration', (ctx) => {
    story(ctx, 'User wkleił "?t=999" na 60-sekundowym klipie (albo ktoś pomylił se ścieżkę). Nie zostawiamy nadziei "może jest dłuższy" — clamp do 59 i gramy.');
    expect(clampSeekToDuration(100, 60)).toBe(59);
    expect(clampSeekToDuration(999, 13.018)).toBe(12.018);
  });

  it('clamps to 0 when clip is shorter than 1 s', (ctx) => {
    story(ctx, 'Mikro-klip 0.5 s + jakikolwiek seek poza zerem → fallback na sam początek. max(0, …) chroni przed ujemnymi currentTime, których przeglądarka nie zaakceptuje.');
    expect(clampSeekToDuration(5, 0.5)).toBe(0);
    expect(clampSeekToDuration(0.6, 0.5)).toBe(0);
  });

  it('passes seekSec through when duration is unknown', (ctx) => {
    story(ctx, 'Hydration czasem zna seekSec z URL-a zanim załaduje się event detail z duration. Bez duration nie wiemy do czego clamp\'ować — pass-through; trySeek dorzuci defense in depth gdy duration w końcu się pojawi.');
    expect(clampSeekToDuration(13, null)).toBe(13);
    expect(clampSeekToDuration(13, undefined)).toBe(13);
    expect(clampSeekToDuration(13, 0)).toBe(13);
    expect(clampSeekToDuration(13, NaN)).toBe(13);
  });

  it('returns null for missing or invalid seekSec', (ctx) => {
    story(ctx, 'Brak seekSec to "no signal" — zwracamy null, nie zero. Wpięcie w hydration konwertuje to na undefined, żeby player startował od początku zamiast wskakiwać na artefaktowe t=0.');
    expect(clampSeekToDuration(null, 60)).toBeNull();
    expect(clampSeekToDuration(undefined, 60)).toBeNull();
    expect(clampSeekToDuration(NaN, 60)).toBeNull();
    expect(clampSeekToDuration(-5, 60)).toBeNull();
  });
});
