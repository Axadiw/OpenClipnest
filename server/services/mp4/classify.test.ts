import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { classifyHead } from './classify.js';
import { box, makeFtyp, makeMoov, makeMoofMdat } from './__test-fixtures.js';
import { story } from '../../testing/story.js';

describe('classifyHead', () => {
  it('returns A for fragmented mp4 missing mehd', (ctx) => {
    story(ctx, 'Default Reolink: ftyp + moov(z mvex bez mehd) + moof+mdat → klasa A, generujemy sidecar.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const moofMdat = makeMoofMdat({ trackId: 1, sampleDurations: [3000, 3000] });
    const file = Buffer.concat([ftyp, moov, moofMdat]);
    expect(classifyHead(file).class).toBe('A');
  });

  it('returns B when mehd already present', (ctx) => {
    story(ctx, 'Plik wgrany przez kogoś z innego źródła ma mehd — pomijamy generację sidecara, serwujemy pass-through.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 5000,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: true,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    expect(classifyHead(Buffer.concat([ftyp, moov])).class).toBe('B');
  });

  it('returns B for non-fragmented mp4 (moov without mvex)', (ctx) => {
    story(ctx, 'Klasyczny mp4 bez mvex — przeglądarka radzi sobie sama, sidecar zbędny.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 5000,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: false,
    });
    expect(classifyHead(Buffer.concat([ftyp, moov])).class).toBe('B');
  });

  it('returns D for non-mp4 container', (ctx) => {
    story(ctx, 'Wgrany mkv/webm/avi — pierwszy box nie jest ftyp; reject z user-friendly notyfikacją.');
    const fake = Buffer.alloc(16);
    fake.writeUInt32BE(16, 0);
    fake.write('mkv ', 4);
    expect(classifyHead(fake).class).toBe('D');
  });

  it('returns C when moov is missing from head (moov-at-end)', (ctx) => {
    story(ctx, 'Stary, niezfaststartowany mp4 z moov na końcu — browser sobie poradzi tail-fetchem, sidecara nie generujemy.');
    const ftyp = makeFtyp();
    const mdat = box('mdat', Buffer.alloc(1024));
    expect(classifyHead(Buffer.concat([ftyp, mdat])).class).toBe('C');
  });
});
