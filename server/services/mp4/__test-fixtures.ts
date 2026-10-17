import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// Synthesized box helpers — tiny well-formed mp4-ish buffers used in unit
// tests. We keep them minimal (just enough to exercise the parser) and avoid
// depending on real fixtures for the box-level unit tests.
// ---------------------------------------------------------------------------

export function box(type: string, payload: Buffer): Buffer {
  if (type.length !== 4) throw new Error('box type must be 4 chars');
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, 'ascii');
  payload.copy(buf, 8);
  return buf;
}

export function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const fb = Buffer.alloc(4 + payload.length);
  fb.writeUInt8(version, 0);
  fb.writeUInt8((flags >> 16) & 0xff, 1);
  fb.writeUInt8((flags >> 8) & 0xff, 2);
  fb.writeUInt8(flags & 0xff, 3);
  payload.copy(fb, 4);
  return box(type, fb);
}

export function makeMvhd(timescale: number, duration: number): Buffer {
  // version=0: creation(4) modification(4) timescale(4) duration(4) + extras
  const payload = Buffer.alloc(96); // standard mvhd v0 payload size
  payload.writeUInt32BE(0, 0);             // creation_time
  payload.writeUInt32BE(0, 4);             // modification_time
  payload.writeUInt32BE(timescale, 8);     // timescale
  payload.writeUInt32BE(duration, 12);     // duration
  payload.writeUInt32BE(0x00010000, 16);   // rate
  payload.writeUInt16BE(0x0100, 20);       // volume
  // ...rest stays zero (matrix, predefined, next_track_id)
  payload.writeUInt32BE(0xffffffff, 92);   // next_track_id
  return fullBox('mvhd', 0, 0, payload);
}

export function makeTkhd(trackId: number): Buffer {
  // version=0 tkhd payload = 80 bytes
  const payload = Buffer.alloc(80);
  payload.writeUInt32BE(0, 0);             // creation_time
  payload.writeUInt32BE(0, 4);             // modification_time
  payload.writeUInt32BE(trackId, 8);       // track_ID
  return fullBox('tkhd', 0, 0, payload);
}

export function makeMdhd(timescale: number): Buffer {
  // version=0: creation(4) modification(4) timescale(4) duration(4) + lang(2) + pre(2) = 20
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 8);
  return fullBox('mdhd', 0, 0, payload);
}

export function makeTrex(trackId: number, defaultSampleDuration: number): Buffer {
  // payload: track_ID(4) sample_description_index(4) default_sample_duration(4)
  //          default_sample_size(4) default_sample_flags(4) = 20
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(trackId, 0);
  payload.writeUInt32BE(1, 4);
  payload.writeUInt32BE(defaultSampleDuration, 8);
  return fullBox('trex', 0, 0, payload);
}

export function makeMinimalTrak(trackId: number, mdhdTimescale: number): Buffer {
  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(mdhdTimescale);
  const mdia = box('mdia', mdhd);
  return box('trak', Buffer.concat([tkhd, mdia]));
}

export interface ElstEntryFixture {
  segmentDuration: number;
  mediaTime: number;
  /** integer part of media_rate; pass 1 for normal playback */
  mediaRateInteger: number;
  /** fractional part of media_rate */
  mediaRateFraction: number;
}

/** v0 elst (4-byte segment_duration + 4-byte media_time + 2+2 media_rate per entry). */
export function makeElstV0(entries: ElstEntryFixture[]): Buffer {
  const payload = Buffer.alloc(4 + entries.length * 12);
  payload.writeUInt32BE(entries.length, 0);
  let p = 4;
  for (const e of entries) {
    payload.writeUInt32BE(e.segmentDuration, p);
    payload.writeInt32BE(e.mediaTime, p + 4);
    payload.writeInt16BE(e.mediaRateInteger, p + 8);
    payload.writeInt16BE(e.mediaRateFraction, p + 10);
    p += 12;
  }
  return fullBox('elst', 0, 0, payload);
}

export function makeTrakWithElst(trackId: number, mdhdTimescale: number, elstEntries: ElstEntryFixture[]): Buffer {
  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(mdhdTimescale);
  const mdia = box('mdia', mdhd);
  const elst = makeElstV0(elstEntries);
  const edts = box('edts', elst);
  return box('trak', Buffer.concat([tkhd, edts, mdia]));
}

export function makeMoov(opts: {
  mvhdTimescale: number;
  mvhdDuration: number;
  tracks: { id: number; mdhdTimescale: number }[];
  withMvex?: boolean;
  withMehd?: boolean;
  trexDefaults?: { trackId: number; defaultSampleDuration: number }[];
}): Buffer {
  const mvhd = makeMvhd(opts.mvhdTimescale, opts.mvhdDuration);
  const traks = opts.tracks.map((t) => makeMinimalTrak(t.id, t.mdhdTimescale));
  const parts = [mvhd, ...traks];
  if (opts.withMvex) {
    const mvexParts: Buffer[] = [];
    if (opts.withMehd) {
      const mehdPayload = Buffer.alloc(4);
      mehdPayload.writeUInt32BE(opts.mvhdDuration, 0);
      mvexParts.push(fullBox('mehd', 0, 0, mehdPayload));
    }
    for (const def of opts.trexDefaults ?? []) {
      mvexParts.push(makeTrex(def.trackId, def.defaultSampleDuration));
    }
    parts.push(box('mvex', Buffer.concat(mvexParts)));
  }
  return box('moov', Buffer.concat(parts));
}

export function makeFtyp(major = 'isom'): Buffer {
  // ftyp payload: major_brand(4) minor_version(4) compatible_brands(4×N)
  const payload = Buffer.alloc(16);
  payload.write(major, 0, 'ascii');
  payload.writeUInt32BE(0, 4);
  payload.write('isom', 8, 'ascii');
  payload.write('avc1', 12, 'ascii');
  return box('ftyp', payload);
}

export function makeMoofMdat(opts: {
  trackId: number;
  /** explicit decode_time via tfdt; omit to let parser fall back to cumulative */
  decodeTime?: number;
  /** sample durations (per sample). Required to populate trun. */
  sampleDurations: number[];
  /** raw mdat payload size (just controls mdat box size) */
  mdatPayloadSize?: number;
}): Buffer {
  const mfhd = fullBox('mfhd', 0, 0, Buffer.from([0, 0, 0, 1])); // sequence_number=1

  // tfhd: just track_id, no flags
  const tfhdPayload = Buffer.alloc(4);
  tfhdPayload.writeUInt32BE(opts.trackId, 0);
  const tfhd = fullBox('tfhd', 0, 0, tfhdPayload);

  // trun with sample-duration-present flag (0x000100)
  const trunPayload = Buffer.alloc(4 + 4 * opts.sampleDurations.length);
  trunPayload.writeUInt32BE(opts.sampleDurations.length, 0);
  for (let i = 0; i < opts.sampleDurations.length; i++) {
    trunPayload.writeUInt32BE(opts.sampleDurations[i], 4 + i * 4);
  }
  const trun = fullBox('trun', 0, 0x000100, trunPayload);

  const trafChildren = [tfhd];
  if (opts.decodeTime !== undefined) {
    const tfdtPayload = Buffer.alloc(4);
    tfdtPayload.writeUInt32BE(opts.decodeTime, 0);
    trafChildren.push(fullBox('tfdt', 0, 0, tfdtPayload));
  }
  trafChildren.push(trun);
  const traf = box('traf', Buffer.concat(trafChildren));

  const moof = box('moof', Buffer.concat([mfhd, traf]));
  const mdat = box('mdat', Buffer.alloc(opts.mdatPayloadSize ?? 8));
  return Buffer.concat([moof, mdat]);
}
