import { Buffer } from 'buffer';
import {
  readBoxHeader,
  findChildBox,
  parseMvhd,
  parseTkhd,
  parseMdhd,
  parseTrex,
  parseElst,
  parseMehd,
  type ElstEntry,
  type FullBoxVersion,
} from './boxes.js';

// ---------------------------------------------------------------------------
// MoovInfo — strict, high-level moov summary consumed by the sidecar pipeline
// in fmp4Patch.ts. Extracted from fmp4Patch.ts verbatim in the v0.10.332
// refactor so multiple consumers (incl. inspectFileDetailed below) can share
// the same surface.
// ---------------------------------------------------------------------------

export interface MoovInfo {
  /** offset of moov box (relative to file start) in original */
  moovFileOffset: number;
  moovSize: number;
  mvhdTimescale: number;
  /** primary (first) track id */
  primaryTrackId: number;
  /** primary track's mdhd timescale */
  primaryTrackTimescale: number;
  /** whether moov already contains mehd (then we don't add one) */
  hasMehd: boolean;
  /** whether moov has mvex (i.e. file is fragmented) */
  hasMvex: boolean;
  /**
   * Number of trak boxes in moov. Reolink fmp4 always has 2 (video + audio).
   * The sidx injection path (v0.10.201) only operates correctly on a single
   * track since mfra+sidx only describe one track's subsegments; with audio
   * also present, browsers compute total duration from both tracks and
   * report 2× the real length.
   */
  trackCount: number;
  /** offset of mvex box header relative to moov start */
  mvexOffsetInMoov: number;
  mvexSize: number;
  /**
   * Default sample duration declared per-track in mvex.trex (track id → ticks).
   * Used as fallback when traf.tfhd / trun don't override it.
   */
  trexDefaults: Map<number, { defaultSampleDuration: number; defaultSampleSize: number }>;
  /**
   * Per-track mdhd timescale (track id → timescale). Reolink's video track
   * runs at e.g. 150000 ticks/sec while audio runs at 16000. Computing the
   * per-fragment max-duration across tracks (v0.10.204+ sidx) requires
   * scaling each track's trun-derived duration to a common reference (the
   * primary track's timescale) and the per-track timescales live here.
   */
  trackTimescales: Map<number, number>;
}

/**
 * Locate ftyp + moov in the head buffer and extract movie/track timescales,
 * track ids, and mvex/trex defaults. Throws on malformed input.
 *
 * Assumes ftyp is the first box and moov is at the front (the post-Phase-1
 * layout for class A and B). Class C (moov-at-end) is not handled here —
 * caller must check via `classifyHead` before invoking.
 */
export function inspectMoov(headBuf: Buffer): { ftypSize: number; moov: MoovInfo } {
  const ftyp = readBoxHeader(headBuf, 0);
  if (!ftyp || ftyp.type !== 'ftyp') {
    throw new Error('inspectMoov: file does not start with ftyp box');
  }
  const moovOffset = ftyp.size;
  const moovHdr = readBoxHeader(headBuf, moovOffset);
  if (!moovHdr || moovHdr.type !== 'moov') {
    throw new Error('inspectMoov: moov is not the second top-level box');
  }
  if (moovOffset + moovHdr.size > headBuf.length) {
    throw new Error('inspectMoov: moov extends beyond head buffer');
  }

  const moovDataStart = moovOffset + moovHdr.headerSize;
  const moovDataEnd = moovOffset + moovHdr.size;

  // mvhd
  const mvhd = findChildBox(headBuf, moovDataStart, moovDataEnd, 'mvhd');
  if (!mvhd) throw new Error('inspectMoov: mvhd not found inside moov');
  const mvhdInfo = parseMvhd(headBuf, mvhd.offset, mvhd.header.headerSize);

  // trak (one per track) — collect track ids + per-track mdhd timescales.
  // Previously we only learned the primary track's timescale; v0.10.204
  // needs every track's timescale to scale per-fragment trun durations to
  // a shared (primary) reference for max-duration sidx subsegment fields.
  const trackIds: number[] = [];
  const trackTimescales = new Map<number, number>();
  let primaryTrackId = -1;
  let primaryTrackTimescale = 0;
  let p = moovDataStart;
  while (p + 8 <= moovDataEnd) {
    const h = readBoxHeader(headBuf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      const trakDataStart = p + h.headerSize;
      const trakDataEnd = p + h.size;
      let thisTrackId = -1;
      const tkhd = findChildBox(headBuf, trakDataStart, trakDataEnd, 'tkhd');
      if (tkhd) {
        const tk = parseTkhd(headBuf, tkhd.offset, tkhd.header.headerSize);
        thisTrackId = tk.trackId;
        trackIds.push(thisTrackId);
        if (primaryTrackId === -1) primaryTrackId = thisTrackId;
      }
      const mdia = findChildBox(headBuf, trakDataStart, trakDataEnd, 'mdia');
      if (mdia) {
        const mdhd = findChildBox(
          headBuf,
          mdia.offset + mdia.header.headerSize,
          mdia.offset + mdia.header.size,
          'mdhd',
        );
        if (mdhd && thisTrackId !== -1) {
          const ts = parseMdhd(
            headBuf,
            mdhd.offset,
            mdhd.header.headerSize,
          ).timescale;
          trackTimescales.set(thisTrackId, ts);
          if (primaryTrackTimescale === 0) {
            primaryTrackTimescale = ts;
          }
        }
      }
    }
    p += h.size;
  }

  if (trackIds.length === 0) {
    throw new Error('inspectMoov: no trak boxes found');
  }
  if (primaryTrackTimescale === 0) {
    throw new Error('inspectMoov: primary track mdhd timescale could not be parsed');
  }

  // mvex (optional — only present in fragmented mp4)
  const mvex = findChildBox(headBuf, moovDataStart, moovDataEnd, 'mvex');
  let hasMvex = false;
  let hasMehd = false;
  let mvexOffsetInMoov = -1;
  let mvexSize = 0;
  const trexDefaults = new Map<
    number,
    { defaultSampleDuration: number; defaultSampleSize: number }
  >();

  if (mvex) {
    hasMvex = true;
    mvexOffsetInMoov = mvex.offset - moovOffset;
    mvexSize = mvex.header.size;
    const mvexDataStart = mvex.offset + mvex.header.headerSize;
    const mvexDataEnd = mvex.offset + mvex.header.size;
    hasMehd = findChildBox(headBuf, mvexDataStart, mvexDataEnd, 'mehd') !== null;
    // Walk children for trex×N
    let q = mvexDataStart;
    while (q + 8 <= mvexDataEnd) {
      const h = readBoxHeader(headBuf, q);
      if (!h || h.size <= 0) break;
      if (h.type === 'trex') {
        const trex = parseTrex(headBuf, q, h.headerSize);
        trexDefaults.set(trex.trackId, {
          defaultSampleDuration: trex.defaultSampleDuration,
          defaultSampleSize: trex.defaultSampleSize,
        });
      }
      q += h.size;
    }
  }

  return {
    ftypSize: ftyp.size,
    moov: {
      moovFileOffset: moovOffset,
      moovSize: moovHdr.size,
      mvhdTimescale: mvhdInfo.timescale,
      primaryTrackId,
      primaryTrackTimescale,
      hasMehd,
      hasMvex,
      trackCount: trackIds.length,
      trackTimescales,
      mvexOffsetInMoov,
      mvexSize,
      trexDefaults,
    },
  };
}

// ---------------------------------------------------------------------------
// inspectFileDetailed — tolerant moov inspector for diagnostics. Unlike
// `inspectMoov`, this one emits warnings rather than throwing, locates moov
// anywhere in the buffer (not just at offset ftypSize), and surfaces the
// raw box-level details that the admin /mp4-inspect endpoint needs.
//
// Used by the admin route in routes/admin/mp4inspect.ts (Task 11 will
// migrate that file to consume this function instead of duplicating ~250
// LOC of parsing logic).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wire-format snapshot types — these mirror the JSON shape that
// routes/admin/mp4inspect.ts has been emitting since v0.10.x. Task 11 will
// drop `inspectFileDetailed` into the admin route as a replacement for the
// duplicated 250-LOC parsing logic there; for that swap to be byte-identical
// at the JSON layer, each per-box snapshot keeps the `type` discriminator,
// `durationTicks` + `durationSeconds` pre-computed, `entryCount` on elst,
// etc. Do NOT collapse these onto raw boxes.ts `*Info` types — the admin
// endpoint's clients (and the snapshot diff tooling) rely on this shape.
// ---------------------------------------------------------------------------

export interface FtypSnapshot {
  size: number;
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
}

export interface MvhdSnapshot extends FullBoxVersion {
  type: 'mvhd';
  timescale: number;
  durationTicks: number;
  durationSeconds: number;
}

export interface TkhdSnapshot extends FullBoxVersion {
  type: 'tkhd';
  trackId: number;
  durationTicks: number;
  /** in *mvhd* timescale — caller supplies for seconds calc */
  durationSeconds: number;
}

export interface MdhdSnapshot extends FullBoxVersion {
  type: 'mdhd';
  timescale: number;
  durationTicks: number;
  durationSeconds: number;
}

export interface ElstSnapshot extends FullBoxVersion {
  type: 'elst';
  entryCount: number;
  entries: ElstEntry[];
}

export interface MehdSnapshot extends FullBoxVersion {
  type: 'mehd';
  fragmentDurationTicks: number;
}

export interface TrexSnapshot {
  type: 'trex';
  trackId: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
}

export interface TrakSnapshot {
  size: number;
  fileOffset: number;
  tkhd: TkhdSnapshot | null;
  mdhd: MdhdSnapshot | null;
  elst: ElstSnapshot | null;
}

export interface MvexSnapshot {
  size: number;
  mehd: MehdSnapshot | null;
  trex: TrexSnapshot[];
}

export interface MoovSnapshot {
  size: number;
  fileOffset: number;
  mvhd: MvhdSnapshot | null;
  traks: TrakSnapshot[];
  mvex: MvexSnapshot | null;
}

export interface FileSnapshot {
  ftyp: FtypSnapshot | null;
  moov: MoovSnapshot | null;
  warnings: string[];
}

/**
 * Tolerant moov inspector for diagnostics — emits warnings for moov-at-end
 * and truncated buffers, locates moov anywhere in the buffer (not just at
 * offset ftypSize). Used by the admin /mp4-inspect endpoint.
 */
export function inspectFileDetailed(buf: Buffer): FileSnapshot {
  const warnings: string[] = [];

  // 1. ftyp
  let ftypSnap: FtypSnapshot | null = null;
  let cursor = 0;
  const ftypHdr = readBoxHeader(buf, 0);
  if (ftypHdr && ftypHdr.type === 'ftyp' && ftypHdr.size > 0) {
    const dataStart = ftypHdr.headerSize;
    const majorBrand = buf.toString('ascii', dataStart, dataStart + 4);
    const minorVersion = buf.readUInt32BE(dataStart + 4);
    const compatibleBrands: string[] = [];
    let p = dataStart + 8;
    while (p + 4 <= ftypHdr.size) {
      compatibleBrands.push(buf.toString('ascii', p, p + 4));
      p += 4;
    }
    ftypSnap = { size: ftypHdr.size, majorBrand, minorVersion, compatibleBrands };
    cursor = ftypHdr.size;
  } else {
    warnings.push('no ftyp at offset 0');
  }

  // 2. moov — walk all top-level boxes until we find moov.
  let moovSnap: MoovSnapshot | null = null;
  let p = cursor;
  while (p + 8 <= buf.length) {
    const h = readBoxHeader(buf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'moov') {
      let actualSize = h.size;
      if (p + h.size > buf.length) {
        warnings.push(
          `moov extends past inspect buffer (size=${h.size}, available=${buf.length - p}) — ` +
          `duration values may be parsed from incomplete data`,
        );
        actualSize = buf.length - p;
      }
      moovSnap = inspectMoovDetailed(buf, p, actualSize, h.headerSize);
      break;
    }
    p += h.size;
  }
  if (!moovSnap) {
    warnings.push('no moov found in inspect buffer (probably moov-at-end → class C)');
  }

  return { ftyp: ftypSnap, moov: moovSnap, warnings };
}

function inspectMoovDetailed(buf: Buffer, moovOff: number, moovSize: number, moovHdrSize: number): MoovSnapshot {
  const dataStart = moovOff + moovHdrSize;
  const dataEnd = moovOff + moovSize;

  const mvhdBox = findChildBox(buf, dataStart, dataEnd, 'mvhd');
  const mvhdInfo = mvhdBox ? parseMvhd(buf, mvhdBox.offset, mvhdBox.header.headerSize) : null;
  const mvhdSnap: MvhdSnapshot | null = mvhdInfo ? {
    type: 'mvhd',
    version: mvhdInfo.version,
    flags: mvhdInfo.flags,
    timescale: mvhdInfo.timescale,
    durationTicks: mvhdInfo.duration,
    durationSeconds: mvhdInfo.timescale > 0 ? mvhdInfo.duration / mvhdInfo.timescale : 0,
  } : null;
  // tkhd.durationSeconds uses the *mvhd* timescale (per ISO/IEC 14496-12:
  // tkhd.duration is in movie timescale, not the track's own).
  const mvhdTimescale = mvhdInfo?.timescale ?? 0;

  const traks: TrakSnapshot[] = [];
  let p = dataStart;
  while (p + 8 <= dataEnd) {
    const h = readBoxHeader(buf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      const trakDataStart = p + h.headerSize;
      const trakDataEnd = p + h.size;
      const tkhdBox = findChildBox(buf, trakDataStart, trakDataEnd, 'tkhd');
      const edtsBox = findChildBox(buf, trakDataStart, trakDataEnd, 'edts');
      const mdiaBox = findChildBox(buf, trakDataStart, trakDataEnd, 'mdia');

      const tkhdInfo = tkhdBox ? parseTkhd(buf, tkhdBox.offset, tkhdBox.header.headerSize) : null;
      const tkhdSnap: TkhdSnapshot | null = tkhdInfo ? {
        type: 'tkhd',
        version: tkhdInfo.version,
        flags: tkhdInfo.flags,
        trackId: tkhdInfo.trackId,
        durationTicks: tkhdInfo.durationTicks,
        durationSeconds: mvhdTimescale > 0 ? tkhdInfo.durationTicks / mvhdTimescale : 0,
      } : null;

      let mdhdSnap: MdhdSnapshot | null = null;
      if (mdiaBox) {
        const mdhd = findChildBox(
          buf,
          mdiaBox.offset + mdiaBox.header.headerSize,
          mdiaBox.offset + mdiaBox.header.size,
          'mdhd',
        );
        if (mdhd) {
          const mdhdInfo = parseMdhd(buf, mdhd.offset, mdhd.header.headerSize);
          mdhdSnap = {
            type: 'mdhd',
            version: mdhdInfo.version,
            flags: mdhdInfo.flags,
            timescale: mdhdInfo.timescale,
            durationTicks: mdhdInfo.durationTicks,
            durationSeconds: mdhdInfo.timescale > 0 ? mdhdInfo.durationTicks / mdhdInfo.timescale : 0,
          };
        }
      }
      let elstSnap: ElstSnapshot | null = null;
      if (edtsBox) {
        const elst = findChildBox(
          buf,
          edtsBox.offset + edtsBox.header.headerSize,
          edtsBox.offset + edtsBox.header.size,
          'elst',
        );
        if (elst) {
          const elstInfo = parseElst(buf, elst.offset, elst.header.headerSize);
          elstSnap = {
            type: 'elst',
            version: elstInfo.version,
            flags: elstInfo.flags,
            entryCount: elstInfo.entries.length,
            entries: elstInfo.entries,
          };
        }
      }
      traks.push({
        size: h.size,
        fileOffset: p,
        tkhd: tkhdSnap,
        mdhd: mdhdSnap,
        elst: elstSnap,
      });
    }
    p += h.size;
  }

  const mvexBox = findChildBox(buf, dataStart, dataEnd, 'mvex');
  let mvexSnap: MvexSnapshot | null = null;
  if (mvexBox) {
    const mvexDataStart = mvexBox.offset + mvexBox.header.headerSize;
    const mvexDataEnd = mvexBox.offset + mvexBox.header.size;
    const mehdBox = findChildBox(buf, mvexDataStart, mvexDataEnd, 'mehd');
    let mehdSnap: MehdSnapshot | null = null;
    if (mehdBox) {
      const mehdInfo = parseMehd(buf, mehdBox.offset, mehdBox.header.headerSize);
      mehdSnap = {
        type: 'mehd',
        version: mehdInfo.version,
        flags: mehdInfo.flags,
        fragmentDurationTicks: mehdInfo.fragmentDurationTicks,
      };
    }
    const trex: TrexSnapshot[] = [];
    let q = mvexDataStart;
    while (q + 8 <= mvexDataEnd) {
      const h = readBoxHeader(buf, q);
      if (!h || h.size <= 0) break;
      if (h.type === 'trex') {
        const trexInfo = parseTrex(buf, q, h.headerSize);
        trex.push({
          type: 'trex',
          trackId: trexInfo.trackId,
          defaultSampleDescriptionIndex: trexInfo.defaultSampleDescriptionIndex,
          defaultSampleDuration: trexInfo.defaultSampleDuration,
          defaultSampleSize: trexInfo.defaultSampleSize,
          defaultSampleFlags: trexInfo.defaultSampleFlags,
        });
      }
      q += h.size;
    }
    mvexSnap = {
      size: mvexBox.header.size,
      mehd: mehdSnap,
      trex,
    };
  }

  return {
    size: moovSize,
    fileOffset: moovOff,
    mvhd: mvhdSnap,
    traks,
    mvex: mvexSnap,
  };
}
