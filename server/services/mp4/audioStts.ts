import { Buffer } from 'buffer';
import { readBoxHeader, findChildBox, readFlags } from './boxes.js';

// ---------------------------------------------------------------------------
// patchAudioStts — fix Reolink stts sample_delta=0 for audio tracks.
//
// Reolink cameras write `stts sample_delta = 0` for audio tracks in their
// MP4 files. When served as-is, AVPlayer sees `mdhd.duration = 0` and
// silently drops the audio track entirely. The audio data (AAC-LC, 16kHz
// mono) is intact — only the timing table is wrong.
//
// The correct delta is 1024: standard AAC frame = 1024 samples. At any
// sample rate, the frame size is fixed at 1024 samples by the AAC-LC spec
// (ISO/IEC 13818-7 §8.2.2). A 16kHz mono AAC-LC frame is therefore
// 1024/16000 = 64ms per frame. The stts delta is always expressed in
// track timescale ticks, and the track timescale for these files equals the
// audio sample rate (16000 Hz), so delta=1024 is always correct here.
//
// This module is used in two places:
//   1. classicMoovBuilder.ts — when synthesising a classic moov from a
//      fragmented MP4 (class A path), audio track samples parsed from moof/
//      trun carry durationTicks=0 from the Reolink firmware bug; the builder
//      calls fixAudioSampleDurations() before building stts.
//   2. video.ts class B pass-through — raw moov read from S3 is patched
//      in-memory with patchAudioStts() before being written to the response.
// ---------------------------------------------------------------------------

/** Standard AAC-LC frame size in samples (fixed by spec, all sample rates). */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * Read the 4-char handler type from an hdlr box buffer (starts at offset 0).
 * Returns 'soun', 'vide', etc., or '' on malformed input.
 */
export function readHdlrType(hdlrBytes: Buffer): string {
  // hdlr layout (full box):
  //   box header (8B) + version(1) flags(3) = 12B before payload
  //   payload: pre_defined(4) handler_type(4) reserved(12) name(variable)
  const hdr = readBoxHeader(hdlrBytes, 0);
  if (!hdr || hdr.type !== 'hdlr') return '';
  const payloadStart = hdr.headerSize + 4; // +4 for ver+flags
  // pre_defined(4) then handler_type(4)
  const handlerTypeOff = payloadStart + 4;
  if (handlerTypeOff + 4 > hdlrBytes.length) return '';
  return hdlrBytes.toString('ascii', handlerTypeOff, handlerTypeOff + 4);
}

/**
 * For classicMoovBuilder: if all sample durations in an audio track are 0,
 * replace them all with AAC_FRAME_SAMPLES. Returns a new array so the
 * original samples array is not mutated.
 *
 * @param durationTicks - Array of per-sample durationTicks values.
 * @param isAudio - Whether this track is an audio track (hdlr=soun).
 * @returns Corrected array (same reference if no fix needed).
 */
export function fixAudioSampleDurations(
  durationTicks: number[],
  isAudio: boolean,
): number[] {
  if (!isAudio) return durationTicks;
  if (durationTicks.length === 0) return durationTicks;
  if (durationTicks.every((d) => d === 0)) {
    return durationTicks.map(() => AAC_FRAME_SAMPLES);
  }
  return durationTicks;
}

/**
 * Any per-sample duration at or above this is treated as a 32-bit underflow,
 * never a real frame interval. 2^31 ticks is ~3.9 hours even at a 150 kHz
 * media timescale — no legitimate single frame lasts that long.
 */
export const VIDEO_SAMPLE_DURATION_UNDERFLOW_THRESHOLD = 0x80000000; // 2^31

/**
 * 32-bit underflow guard for VIDEO sample durations.
 *
 * Reolink firmware occasionally writes a single video `sample_duration` as a
 * small NEGATIVE frame interval stored unsigned — e.g. -10350 lands in the
 * `trun` as 2^32 - 10350 ≈ 4.29e9 ticks. Summed into the track/movie duration
 * it inflates an N-second clip to ~8 hours (mvhd duration ≈ 479:28 for a real
 * 2-minute clip), which AVPlayer shows as the total length and which stretches
 * the frame grid across the bogus gap.
 *
 * Any sample whose duration is ≥ 2^31 ticks is an unambiguous underflow and is
 * replaced with the track's MEDIAN plausible duration, so the synthesized
 * mvhd/tkhd/mdhd/stts and the frame grid all reflect the true timeline. The
 * conservative threshold leaves legitimate VFR gaps untouched.
 *
 * @param durationTicks - Array of per-sample durationTicks values.
 * @param isVideo - Whether this track is a video track (hdlr=vide).
 * @returns Corrected array (same reference if no fix needed).
 */
export function fixVideoSampleDurations(
  durationTicks: number[],
  isVideo: boolean,
): number[] {
  if (!isVideo) return durationTicks;
  let hasUnderflow = false;
  for (const d of durationTicks) {
    if (d >= VIDEO_SAMPLE_DURATION_UNDERFLOW_THRESHOLD) {
      hasUnderflow = true;
      break;
    }
  }
  if (!hasUnderflow) return durationTicks;

  const plausible = durationTicks
    .filter((d) => d > 0 && d < VIDEO_SAMPLE_DURATION_UNDERFLOW_THRESHOLD)
    .sort((a, b) => a - b);
  const median = plausible.length > 0 ? plausible[Math.floor(plausible.length / 2)] : 0;
  return durationTicks.map((d) =>
    d >= VIDEO_SAMPLE_DURATION_UNDERFLOW_THRESHOLD ? median : d,
  );
}

/**
 * For the class B raw pass-through path: walk moovBuf looking for audio
 * tracks (hdlr.handler_type === 'soun') whose stts has any entry with
 * sample_delta === 0 and patch them to 1024 in-place. Also patches
 * mdhd.duration to totalSamples * 1024 when it would be 0 because of this.
 *
 * Returns a writable copy of the buffer with patches applied, or the
 * original buffer if no audio stts fix was needed (safe to call on any moov).
 *
 * The buffer must start with the moov box header at offset 0.
 */
export function patchAudioStts(moovBuf: Buffer): Buffer {
  const moovHdr = readBoxHeader(moovBuf, 0);
  if (!moovHdr || moovHdr.type !== 'moov') return moovBuf;

  // First pass: check if any fix is needed, to avoid an unnecessary copy.
  let needsFix = false;
  let p = moovHdr.headerSize;
  const moovEnd = moovHdr.size;
  while (p + 8 <= moovEnd) {
    const h = readBoxHeader(moovBuf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      if (_trakNeedsAudioSttsFix(moovBuf, p, h.size)) {
        needsFix = true;
        break;
      }
    }
    p += h.size;
  }

  if (!needsFix) return moovBuf;

  // Second pass: apply patches on a writable copy.
  const out = Buffer.from(moovBuf);
  p = moovHdr.headerSize;
  while (p + 8 <= moovEnd) {
    const h = readBoxHeader(out, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      _patchTrakAudioStts(out, p, h.size);
    }
    p += h.size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if this trak is an audio track (hdlr=soun) whose stts
 * contains at least one entry with sample_delta === 0.
 */
function _trakNeedsAudioSttsFix(buf: Buffer, trakOff: number, trakSize: number): boolean {
  const trakHdr = readBoxHeader(buf, trakOff);
  if (!trakHdr) return false;
  const trakDataStart = trakOff + trakHdr.headerSize;
  const trakDataEnd = trakOff + trakSize;

  const mdiaBox = findChildBox(buf, trakDataStart, trakDataEnd, 'mdia');
  if (!mdiaBox) return false;
  const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
  const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;

  const hdlrBox = findChildBox(buf, mdiaStart, mdiaEnd, 'hdlr');
  if (!hdlrBox) return false;
  const hdlrType = _readHandlerTypeInBuf(buf, hdlrBox.offset, hdlrBox.header.size);
  if (hdlrType !== 'soun') return false;

  const sttsInfo = _findStts(buf, mdiaStart, mdiaEnd);
  if (!sttsInfo) return false;

  return _sttsHasZeroDelta(buf, sttsInfo.offset, sttsInfo.size, sttsInfo.headerSize);
}

/**
 * Patch the audio stts and mdhd.duration in-place in `out` for one trak.
 * Only operates when hdlr=soun and stts has zero deltas.
 */
function _patchTrakAudioStts(out: Buffer, trakOff: number, trakSize: number): void {
  const trakHdr = readBoxHeader(out, trakOff);
  if (!trakHdr) return;
  const trakDataStart = trakOff + trakHdr.headerSize;
  const trakDataEnd = trakOff + trakSize;

  const mdiaBox = findChildBox(out, trakDataStart, trakDataEnd, 'mdia');
  if (!mdiaBox) return;
  const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
  const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;

  const hdlrBox = findChildBox(out, mdiaStart, mdiaEnd, 'hdlr');
  if (!hdlrBox) return;
  if (_readHandlerTypeInBuf(out, hdlrBox.offset, hdlrBox.header.size) !== 'soun') return;

  const sttsInfo = _findStts(out, mdiaStart, mdiaEnd);
  if (!sttsInfo) return;
  if (!_sttsHasZeroDelta(out, sttsInfo.offset, sttsInfo.size, sttsInfo.headerSize)) return;

  // Compute total sample count from all stts entries (sum of sample_count fields).
  const totalSamples = _sttsTotalSamples(out, sttsInfo.offset, sttsInfo.size, sttsInfo.headerSize);

  // Rewrite all stts entries: collapse to one entry
  //   { sample_count: totalSamples, sample_delta: AAC_FRAME_SAMPLES }
  // stts layout (full box):
  //   headerSize bytes: box header
  //   4 bytes: version(1) flags(3)
  //   4 bytes: entry_count
  //   per-entry: sample_count(4) sample_delta(4)
  const sttsPayloadStart = sttsInfo.offset + sttsInfo.headerSize;
  const entryCountOff = sttsPayloadStart + 4; // +4 for ver+flags
  const existingEntryCount = out.readUInt32BE(entryCountOff);

  // Write the new single entry starting at the first entry slot.
  // We MUST NOT shrink/grow the stts box (that would invalidate all
  // absolute offsets in the file). Instead we write ONE real entry and
  // zero-fill the rest (entry_count=1 means remaining bytes are ignored).
  const firstEntryOff = entryCountOff + 4;
  if (firstEntryOff + 8 > sttsInfo.offset + sttsInfo.size) return; // sanity

  out.writeUInt32BE(1, entryCountOff);                    // entry_count = 1
  out.writeUInt32BE(totalSamples, firstEntryOff);         // sample_count
  out.writeUInt32BE(AAC_FRAME_SAMPLES, firstEntryOff + 4); // sample_delta = 1024

  // Zero-fill remaining stale entries (bytes that are now logically unused).
  const remainingEntries = existingEntryCount - 1;
  if (remainingEntries > 0) {
    const fillStart = firstEntryOff + 8;
    const fillEnd = Math.min(fillStart + remainingEntries * 8, sttsInfo.offset + sttsInfo.size);
    out.fill(0, fillStart, fillEnd);
  }

  // Patch mdhd.duration = totalSamples * AAC_FRAME_SAMPLES (in track timescale).
  // Since the timescale equals the AAC sample rate (e.g. 16000), this gives the
  // correct duration in ticks. We use the computed totalSamples from stts.
  const mdhdBox = findChildBox(out, mdiaStart, mdiaEnd, 'mdhd');
  if (mdhdBox) {
    _patchMdhdDuration(out, mdhdBox.offset, mdhdBox.header.headerSize, totalSamples * AAC_FRAME_SAMPLES);
  }
}

/** Read hdlr handler_type (4-char) from within an already-located hdlr box. */
function _readHandlerTypeInBuf(buf: Buffer, hdlrOff: number, hdlrSize: number): string {
  const hdr = readBoxHeader(buf, hdlrOff);
  if (!hdr || hdr.type !== 'hdlr') return '';
  // full-box: headerSize + 4 bytes ver+flags + 4 bytes pre_defined = headerSize+8
  const handlerTypeOff = hdr.headerSize + 8;
  if (hdlrOff + handlerTypeOff + 4 > hdlrOff + hdlrSize) return '';
  return buf.toString('ascii', hdlrOff + handlerTypeOff, hdlrOff + handlerTypeOff + 4);
}

/** Find the stts box by navigating mdia → minf → stbl. */
function _findStts(
  buf: Buffer,
  mdiaStart: number,
  mdiaEnd: number,
): { offset: number; size: number; headerSize: number } | null {
  const minfBox = findChildBox(buf, mdiaStart, mdiaEnd, 'minf');
  if (!minfBox) return null;
  const minfStart = minfBox.offset + minfBox.header.headerSize;
  const minfEnd = minfBox.offset + minfBox.header.size;

  const stblBox = findChildBox(buf, minfStart, minfEnd, 'stbl');
  if (!stblBox) return null;
  const stblStart = stblBox.offset + stblBox.header.headerSize;
  const stblEnd = stblBox.offset + stblBox.header.size;

  const sttsBox = findChildBox(buf, stblStart, stblEnd, 'stts');
  if (!sttsBox) return null;
  return {
    offset: sttsBox.offset,
    size: sttsBox.header.size,
    headerSize: sttsBox.header.headerSize,
  };
}

/** Returns true if any stts entry has sample_delta === 0. */
function _sttsHasZeroDelta(
  buf: Buffer,
  sttsOff: number,
  sttsSize: number,
  sttsHdrSize: number,
): boolean {
  // stts payload: ver+flags(4) entry_count(4) [sample_count(4) sample_delta(4)] ...
  const payloadStart = sttsOff + sttsHdrSize;
  const entryCountOff = payloadStart + 4;
  if (entryCountOff + 4 > sttsOff + sttsSize) return false;
  const entryCount = buf.readUInt32BE(entryCountOff);
  const firstEntry = entryCountOff + 4;
  for (let i = 0; i < entryCount; i++) {
    const deltaOff = firstEntry + i * 8 + 4; // +4 past sample_count
    if (deltaOff + 4 > sttsOff + sttsSize) break;
    if (buf.readUInt32BE(deltaOff) === 0) return true;
  }
  return false;
}

/** Sum all sample_count values in an stts box. */
function _sttsTotalSamples(
  buf: Buffer,
  sttsOff: number,
  sttsSize: number,
  sttsHdrSize: number,
): number {
  const payloadStart = sttsOff + sttsHdrSize;
  const entryCountOff = payloadStart + 4;
  if (entryCountOff + 4 > sttsOff + sttsSize) return 0;
  const entryCount = buf.readUInt32BE(entryCountOff);
  const firstEntry = entryCountOff + 4;
  let total = 0;
  for (let i = 0; i < entryCount; i++) {
    const sampleCountOff = firstEntry + i * 8;
    if (sampleCountOff + 4 > sttsOff + sttsSize) break;
    total += buf.readUInt32BE(sampleCountOff);
  }
  return total;
}

/**
 * Patch mdhd.duration in-place.
 * mdhd full-box layout:
 *   headerSize + ver+flags(4) + creation(4|8) + modification(4|8) + timescale(4) + duration(4|8)
 */
function _patchMdhdDuration(buf: Buffer, mdhdOff: number, mdhdHdrSize: number, durationTicks: number): void {
  const p0 = mdhdOff + mdhdHdrSize;
  const { version } = readFlags(buf, p0);
  let p = p0 + 4; // skip ver+flags
  p += version === 1 ? 16 : 8; // creation + modification
  p += 4; // timescale
  // p now points at duration field
  if (p + (version === 1 ? 8 : 4) > buf.length) return;
  if (version === 1) {
    const hi = Math.floor(durationTicks / 0x100000000);
    const lo = durationTicks >>> 0;
    buf.writeUInt32BE(hi, p);
    buf.writeUInt32BE(lo, p + 4);
  } else {
    buf.writeUInt32BE(durationTicks >>> 0, p);
  }
}
