import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import {
  readBoxHeader,
  readU64BE,
  readS32BE,
  readS64BE,
  readFlags,
  parseMvhd,
  parseTkhd,
  parseMdhd,
  parseTrex,
  parseTfhd,
  parseTrun,
  parseTfdt,
  parseElst,
  parseMehd,
} from './boxes.js';
import { box, fullBox } from './__test-fixtures.js';
import { story } from '../../testing/story.js';

describe('readBoxHeader', () => {
  it('reads basic 8-byte header', (ctx) => {
    story(ctx, 'Header parser potrafi rozkodować rozmiar i typ — bez tego nie da się walkować po drzewie boxów.');
    const buf = box('test', Buffer.from('hello'));
    const h = readBoxHeader(buf, 0);
    expect(h).toBeTruthy();
    expect(h!.type).toBe('test');
    expect(h!.size).toBe(13);
    expect(h!.headerSize).toBe(8);
  });

  it('returns null on truncated input', () => {
    expect(readBoxHeader(Buffer.alloc(4), 0)).toBeNull();
    expect(readBoxHeader(Buffer.alloc(7), 0)).toBeNull();
  });
});

describe('readU64BE / readS32BE / readS64BE / readFlags', () => {
  it('readU64BE decodes a 64-bit big-endian unsigned integer', () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(0x12345678, 0);
    buf.writeUInt32BE(0x9abcdef0, 4);
    expect(readU64BE(buf, 0)).toBe(0x12345678 * 0x100000000 + 0x9abcdef0);
  });

  it('readS32BE decodes a 32-bit big-endian signed integer (including negatives)', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(-12345, 0);
    expect(readS32BE(buf, 0)).toBe(-12345);
  });

  it('readS64BE decodes a 64-bit big-endian signed integer with a negative high word', () => {
    const buf = Buffer.alloc(8);
    buf.writeInt32BE(-1, 0);
    buf.writeUInt32BE(0xffffffff, 4);
    expect(readS64BE(buf, 0)).toBe(-1 * 0x100000000 + 0xffffffff);
  });

  it('readFlags decodes version + 24-bit flags', (ctx) => {
    story(ctx, 'FullBox header carries version + flags. Parser used przez każdy mvhd/tkhd/mdhd/elst.');
    const buf = Buffer.from([0x01, 0xab, 0xcd, 0xef]);
    expect(readFlags(buf, 0)).toEqual({ version: 1, flags: 0xabcdef });
  });
});

describe('parseMvhd', () => {
  it('parses v0 mvhd timescale + duration', () => {
    // v0 mvhd: creation(4) modification(4) timescale(4) duration(4) + 84 bytes tail
    const payload = Buffer.alloc(96);
    payload.writeUInt32BE(90000, 8);
    payload.writeUInt32BE(180000, 12);
    const m = fullBox('mvhd', 0, 0, payload);
    const info = parseMvhd(m, 0, 8);
    expect(info).toEqual({ version: 0, flags: 0, timescale: 90000, duration: 180000 });
  });

  it('parses v1 mvhd with 64-bit duration', () => {
    // v1 mvhd: creation(8) modification(8) timescale(4) duration(8) + tail
    const payload = Buffer.alloc(108);
    payload.writeUInt32BE(0, 0); payload.writeUInt32BE(0, 4);
    payload.writeUInt32BE(0, 8); payload.writeUInt32BE(0, 12);
    payload.writeUInt32BE(90000, 16);
    payload.writeUInt32BE(0, 20); payload.writeUInt32BE(180000, 24);
    const m = fullBox('mvhd', 1, 0, payload);
    const info = parseMvhd(m, 0, 8);
    expect(info).toEqual({ version: 1, flags: 0, timescale: 90000, duration: 180000 });
  });
});

describe('parseTkhd', () => {
  it('parses v0 tkhd trackId + durationTicks', () => {
    const payload = Buffer.alloc(80);
    payload.writeUInt32BE(42, 8); // track_ID at offset 8 (after 2× 4-byte time fields)
    payload.writeUInt32BE(123456, 16); // duration at offset 16 (after track_ID + 4-byte reserved)
    const tk = fullBox('tkhd', 0, 0, payload);
    const info = parseTkhd(tk, 0, 8);
    expect(info).toEqual({ version: 0, flags: 0, trackId: 42, durationTicks: 123456 });
  });

  it('parses v1 tkhd with 64-bit duration', () => {
    // v1 tkhd: creation(8) modification(8) track_id(4) reserved(4) duration(8) + tail
    const payload = Buffer.alloc(80 + 8 + 8); // need extra 16 bytes for v1 expansion
    // creation(8) at 0..7 = 0; modification(8) at 8..15 = 0
    payload.writeUInt32BE(42, 16);    // track_id
    payload.writeUInt32BE(0, 20);     // reserved
    payload.writeUInt32BE(0, 24); payload.writeUInt32BE(0x7fffffff, 28); // duration u64 = 0x7fffffff
    const tk = fullBox('tkhd', 1, 0, payload);
    expect(parseTkhd(tk, 0, 8)).toEqual({ version: 1, flags: 0, trackId: 42, durationTicks: 0x7fffffff });
  });
});

describe('parseMdhd', () => {
  it('parses v0 mdhd timescale + durationTicks', () => {
    const payload = Buffer.alloc(20);
    payload.writeUInt32BE(48000, 8);
    payload.writeUInt32BE(96000, 12);
    const md = fullBox('mdhd', 0, 0, payload);
    expect(parseMdhd(md, 0, 8)).toEqual({ version: 0, flags: 0, timescale: 48000, durationTicks: 96000 });
  });

  it('parses v1 mdhd with 64-bit duration', () => {
    // v1 mdhd: creation(8) modification(8) timescale(4) duration(8) + lang(2) + pre(2)
    const payload = Buffer.alloc(8 + 8 + 4 + 8 + 4);
    payload.writeUInt32BE(48000, 16);
    payload.writeUInt32BE(0, 20); payload.writeUInt32BE(96000, 24);
    const md = fullBox('mdhd', 1, 0, payload);
    expect(parseMdhd(md, 0, 8)).toEqual({ version: 1, flags: 0, timescale: 48000, durationTicks: 96000 });
  });
});

describe('parseTrex', () => {
  it('parses all five fields', () => {
    const payload = Buffer.alloc(20);
    payload.writeUInt32BE(1, 0);          // track_ID
    payload.writeUInt32BE(1, 4);          // sample_description_index
    payload.writeUInt32BE(3003, 8);       // default_sample_duration
    payload.writeUInt32BE(0, 12);         // default_sample_size
    payload.writeUInt32BE(0x02000000, 16); // default_sample_flags
    const t = fullBox('trex', 0, 0, payload);
    expect(parseTrex(t, 0, 8)).toEqual({
      trackId: 1,
      defaultSampleDescriptionIndex: 1,
      defaultSampleDuration: 3003,
      defaultSampleSize: 0,
      defaultSampleFlags: 0x02000000,
    });
  });
});

describe('parseTfhd', () => {
  it('parses minimal tfhd (only track_id)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(1, 0);
    const tf = fullBox('tfhd', 0, 0, payload);
    expect(parseTfhd(tf, 0, 8)).toEqual({
      trackId: 1,
      flags: 0,
      baseDataOffsetPresent: false,
      defaultSampleDuration: undefined,
      defaultSampleSize: undefined,
    });
  });

  it('parses tfhd with base_data_offset + default_sample_duration + default_sample_size', (ctx) => {
    story(ctx, 'Reolink tfhd używa flag 0x000001 (base_data_offset) — moofPatcher musi je rozpoznać żeby je wystrippować.');
    // flags 0x000019 = base_data_offset(0x1) | default_sample_duration(0x8) | default_sample_size(0x10)
    const payload = Buffer.alloc(4 + 8 + 4 + 4);
    payload.writeUInt32BE(1, 0);                          // track_id
    payload.writeUInt32BE(0, 4); payload.writeUInt32BE(1024, 8); // base_data_offset (u64) = 1024
    payload.writeUInt32BE(3003, 12);                      // default_sample_duration
    payload.writeUInt32BE(2048, 16);                      // default_sample_size
    const tf = fullBox('tfhd', 0, 0x000019, payload);
    expect(parseTfhd(tf, 0, 8)).toEqual({
      trackId: 1,
      flags: 0x000019,
      baseDataOffsetPresent: true,
      defaultSampleDuration: 3003,
      defaultSampleSize: 2048,
    });
  });

  it('parses tfhd with sample_description_index gap (flags 0x000002 | 0x000008)', () => {
    // flags 0x00000A = sample_description_index | default_sample_duration
    // layout: trackId(4) sdi(4) default_sample_duration(4)
    const payload = Buffer.alloc(4 + 4 + 4);
    payload.writeUInt32BE(1, 0);          // track_id
    payload.writeUInt32BE(99, 4);         // sample_description_index (parser must skip past this)
    payload.writeUInt32BE(3003, 8);       // default_sample_duration
    const tf = fullBox('tfhd', 0, 0x00000A, payload);
    expect(parseTfhd(tf, 0, 8)).toEqual({
      trackId: 1,
      flags: 0x00000A,
      baseDataOffsetPresent: false,
      defaultSampleDuration: 3003,
      defaultSampleSize: undefined,
    });
  });
});

describe('parseTrun', () => {
  it('parses trun with sample_durations and data_offset', () => {
    // flags 0x000101 = data_offset_present | sample_duration_present
    const sampleCount = 3;
    const payload = Buffer.alloc(4 + 4 + sampleCount * 4);
    payload.writeUInt32BE(sampleCount, 0);
    payload.writeInt32BE(1234, 4);   // data_offset
    payload.writeUInt32BE(1000, 8);
    payload.writeUInt32BE(2000, 12);
    payload.writeUInt32BE(3000, 16);
    const t = fullBox('trun', 0, 0x000101, payload);
    expect(parseTrun(t, 0, 8)).toEqual({
      sampleCount: 3,
      flags: 0x000101,
      dataOffsetPresent: true,
      dataOffset: 1234,
      totalSampleDuration: 6000,
      hasSampleDurations: true,
    });
  });

  it('parses trun without sample_durations', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(5, 0);
    const t = fullBox('trun', 0, 0, payload);
    expect(parseTrun(t, 0, 8)).toEqual({
      sampleCount: 5,
      flags: 0,
      dataOffsetPresent: false,
      dataOffset: 0,
      totalSampleDuration: 0,
      hasSampleDurations: false,
    });
  });

  it('parses trun with first_sample_flags gap (flags 0x000005 | 0x000100)', () => {
    // flags 0x000105 = data_offset_present | first_sample_flags_present | sample_duration_present
    const sampleCount = 2;
    const payload = Buffer.alloc(4 + 4 + 4 + sampleCount * 4);
    payload.writeUInt32BE(sampleCount, 0);
    payload.writeInt32BE(1234, 4);    // data_offset
    payload.writeUInt32BE(0xdead, 8); // first_sample_flags (parser must skip past this)
    payload.writeUInt32BE(1000, 12);
    payload.writeUInt32BE(2000, 16);
    const t = fullBox('trun', 0, 0x000105, payload);
    expect(parseTrun(t, 0, 8)).toEqual({
      sampleCount: 2,
      flags: 0x000105,
      dataOffsetPresent: true,
      dataOffset: 1234,
      totalSampleDuration: 3000,
      hasSampleDurations: true,
    });
  });

  it('parses trun with full per-sample stride (flags 0x000F00 — all four per-sample bits set)', () => {
    // flags 0x000F00 = sample_duration | sample_size | sample_flags | sample_composition_time_offset
    // Each sample takes 16 bytes; only sample_duration is summed.
    const sampleCount = 2;
    const stride = 16;
    const payload = Buffer.alloc(4 + sampleCount * stride);
    payload.writeUInt32BE(sampleCount, 0);
    // Sample 0: duration=100, size=200, flags=0x300, cto=400
    payload.writeUInt32BE(100, 4); payload.writeUInt32BE(200, 8); payload.writeUInt32BE(0x300, 12); payload.writeUInt32BE(400, 16);
    // Sample 1: duration=150, size=250, flags=0x350, cto=450
    payload.writeUInt32BE(150, 20); payload.writeUInt32BE(250, 24); payload.writeUInt32BE(0x350, 28); payload.writeUInt32BE(450, 32);
    const t = fullBox('trun', 0, 0x000F00, payload);
    expect(parseTrun(t, 0, 8)).toEqual({
      sampleCount: 2,
      flags: 0x000F00,
      dataOffsetPresent: false,
      dataOffset: 0,
      totalSampleDuration: 250,
      hasSampleDurations: true,
    });
  });
});

describe('parseTfdt', () => {
  it('parses v0 tfdt (32-bit)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(60000, 0);
    expect(parseTfdt(fullBox('tfdt', 0, 0, payload), 0, 8)).toEqual({
      version: 0,
      flags: 0,
      baseMediaDecodeTime: 60000,
    });
  });

  it('parses v1 tfdt (64-bit)', () => {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(0, 0); payload.writeUInt32BE(60000, 4);
    expect(parseTfdt(fullBox('tfdt', 1, 0, payload), 0, 8)).toEqual({
      version: 1,
      flags: 0,
      baseMediaDecodeTime: 60000,
    });
  });
});

describe('parseElst', () => {
  it('parses v0 elst with two entries', () => {
    const payload = Buffer.alloc(4 + 2 * 12);
    payload.writeUInt32BE(2, 0);
    payload.writeUInt32BE(1000, 4); payload.writeInt32BE(-1, 8);
    payload.writeInt16BE(1, 12); payload.writeInt16BE(0, 14);
    payload.writeUInt32BE(2000, 16); payload.writeInt32BE(500, 20);
    payload.writeInt16BE(1, 24); payload.writeInt16BE(0, 26);
    const el = fullBox('elst', 0, 0, payload);
    const info = parseElst(el, 0, 8);
    expect(info.version).toBe(0);
    expect(info.entries).toEqual([
      { segmentDuration: 1000, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 2000, mediaTime: 500, mediaRateInteger: 1, mediaRateFraction: 0 },
    ]);
  });

  it('parses v1 elst with 64-bit segment_duration and signed 64-bit mediaTime', () => {
    // v1 entry: segmentDuration(8) mediaTime(8) mediaRateInteger(2) mediaRateFraction(2)
    const payload = Buffer.alloc(4 + 1 * 20);
    payload.writeUInt32BE(1, 0);                                           // entry_count
    payload.writeUInt32BE(0, 4); payload.writeUInt32BE(1000, 8);            // segment_duration u64 = 1000
    payload.writeInt32BE(-1, 12); payload.writeUInt32BE(0xffffffff, 16);    // mediaTime i64 = -1
    payload.writeInt16BE(1, 20); payload.writeInt16BE(0, 22);
    const el = fullBox('elst', 1, 0, payload);
    const info = parseElst(el, 0, 8);
    expect(info.version).toBe(1);
    expect(info.entries).toEqual([{ segmentDuration: 1000, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 }]);
  });
});

describe('parseMehd', () => {
  it('parses v0 mehd', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(123456, 0);
    expect(parseMehd(fullBox('mehd', 0, 0, payload), 0, 8)).toEqual({
      version: 0,
      flags: 0,
      fragmentDurationTicks: 123456,
    });
  });

  it('parses v1 mehd (64-bit)', () => {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(0, 0); payload.writeUInt32BE(123456, 4);
    expect(parseMehd(fullBox('mehd', 1, 0, payload), 0, 8)).toEqual({
      version: 1,
      flags: 0,
      fragmentDurationTicks: 123456,
    });
  });
});
