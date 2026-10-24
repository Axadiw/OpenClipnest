import { union, type ByteRange } from '../lib/byteRanges';

/** A read within this long protects a piece from eviction (the playhead's neighbourhood). */
const READ_PROTECT_MS = 2000;
/** The default (and largest) memory budget: desktops. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** No page can push the budget below this: it must hold a few seconds around the playhead. */
export const MIN_MAX_BYTES = 16 * 1024 * 1024;

type Piece = {
  start: number;
  bytes: Uint8Array;
  /** Monotonic use counter (put or read) — the LRU order. */
  used: number;
  /** Clock time of the last read, `-Infinity` until read. */
  readAt: number;
};

type Entry = { total: number; contentType: string; pieces: Piece[] /* sorted, non-overlapping */ };

/**
 * In-memory byte-range cache, one entry per recording key. Pieces never overlap: a `put`
 * stores only the bytes not cached yet. Eviction is LRU by piece across every key and never
 * removes a piece read in the last 2 s, so the cache can sit above `maxBytes` briefly while
 * everything in it is in use.
 */
export class RangeCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private seq = 0;
  /** Per-key invalidation marks (drop/reset) and the last wipe's mark — see `stamp`. */
  private marks = new Map<string, number>();
  private wipeMark = 0;
  private cap: number;
  private readonly now: () => number;
  /** Called with a key whenever its cached ranges change (put, eviction, drop, reset). */
  onChange: ((key: string) => void) | null = null;
  /** Per-key change counter; never reset, so a page can order snapshots and announcements. */
  private versions = new Map<string, number>();
  /** Identifies this worker boot: the counters restart from 0 when the worker is restarted. */
  readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  private changed(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.onChange?.(key);
  }

  constructor(maxBytes = DEFAULT_MAX_BYTES, now: () => number = () => Date.now()) {
    this.cap = maxBytes;
    this.now = now;
  }

  /** The current memory budget in bytes. */
  get maxBytes(): number {
    return this.cap;
  }

  /**
   * Lowers the memory budget to `maxBytes` (clamped to at least MIN_MAX_BYTES) and evicts down
   * to it at once, except pieces read in the last 2 s. A larger value is ignored: the budget is
   * the smallest any page has asked for since the worker started.
   */
  lowerCap(maxBytes: number): void {
    if (Number.isNaN(maxBytes)) return;
    const next = Math.max(MIN_MAX_BYTES, maxBytes);
    if (next >= this.cap) return;
    this.cap = next;
    this.evict();
  }

  /** Records the file's size and type. A different size means a different file: the old bytes go. */
  setMeta(key: string, total: number, contentType: string): 'ok' | 'reset' {
    const e = this.entries.get(key);
    if (e && e.total === total) {
      e.contentType = contentType;
      return 'ok';
    }
    if (e) this.drop(key); // bumps the stamp: writers of the old representation stop
    this.entries.set(key, { total, contentType, pieces: [] });
    if (e) this.changed(key);
    return e ? 'reset' : 'ok';
  }

  /**
   * Identity of a key's current contents. It changes whenever the key is dropped, its file
   * changed size (reset) or the whole cache was wiped, and never otherwise. A writer captures
   * it before its upstream await and passes it to `put`, so bytes fetched for an entry that
   * has since been invalidated are never stored (no splicing of two representations, nothing
   * cached after a close or sign-out).
   */
  stamp(key: string): number {
    return Math.max(this.marks.get(key) ?? 0, this.wipeMark);
  }

  meta(key: string): { total: number; contentType: string } | undefined {
    const e = this.entries.get(key);
    return e ? { total: e.total, contentType: e.contentType } : undefined;
  }

  /** Stores bytes; a no-op without an entry, or when `stamp` is given and no longer current. */
  put(key: string, start: number, bytes: Uint8Array, stamp?: number): void {
    const e = this.entries.get(key);
    if (!e || bytes.length === 0) return;
    if (stamp !== undefined && stamp !== this.stamp(key)) return;
    const end = start + bytes.length;
    // Store only the parts not cached yet, so pieces stay disjoint.
    const fresh: Piece[] = [];
    let cur = start;
    for (const p of e.pieces) {
      const pEnd = p.start + p.bytes.length;
      if (pEnd <= cur) continue;
      if (p.start >= end) break;
      if (p.start > cur) fresh.push(this.piece(start, bytes, cur, p.start));
      cur = Math.max(cur, pEnd);
      if (cur >= end) break;
    }
    if (cur < end) fresh.push(this.piece(start, bytes, cur, end));
    if (fresh.length === 0) return;
    for (const p of fresh) this.bytes += p.bytes.length;
    e.pieces.push(...fresh);
    e.pieces.sort((a, b) => a.start - b.start);
    this.changed(key);
    this.evict();
  }

  /** Bytes `[start, endExcl)`, or `null` unless every one of them is cached. */
  read(key: string, start: number, endExcl: number): Uint8Array | null {
    const e = this.entries.get(key);
    if (!e || endExcl <= start) return null;
    if (this.contiguousFrom(key, start, endExcl - start) < endExcl - start) return null;
    const out = new Uint8Array(endExcl - start);
    const now = this.now();
    for (const p of e.pieces) {
      const pEnd = p.start + p.bytes.length;
      if (pEnd <= start) continue;
      if (p.start >= endExcl) break;
      const from = Math.max(start, p.start);
      const to = Math.min(endExcl, pEnd);
      out.set(p.bytes.subarray(from - p.start, to - p.start), from - start);
      p.used = ++this.seq;
      p.readAt = now;
    }
    return out;
  }

  /** How many bytes from `start` on are cached without a gap, at most `maxLen`. */
  contiguousFrom(key: string, start: number, maxLen: number): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    let cur = start;
    for (const p of e.pieces) {
      const pEnd = p.start + p.bytes.length;
      if (pEnd <= cur) continue;
      if (p.start > cur) break;
      cur = pEnd;
      if (cur - start >= maxLen) break;
    }
    return Math.min(cur - start, maxLen);
  }

  ranges(key: string): ByteRange[] {
    const e = this.entries.get(key);
    if (!e) return [];
    return union(e.pieces.map((p) => ({ start: p.start, end: p.start + p.bytes.length })), []);
  }

  /** What a page needs to draw the cached stretches: the total size (0 when unknown) and the ranges. */
  snapshot(key: string): { total: number; ranges: ByteRange[]; seq: number; epoch: string } {
    return { total: this.meta(key)?.total ?? 0, ranges: this.ranges(key), seq: this.versions.get(key) ?? 0, epoch: this.epoch };
  }

  drop(key: string): void {
    // Invalidate in-flight writers even when nothing is cached yet.
    this.marks.set(key, ++this.seq);
    const e = this.entries.get(key);
    if (!e) return;
    for (const p of e.pieces) this.bytes -= p.bytes.length;
    this.entries.delete(key);
    this.changed(key);
  }

  wipe(): void {
    this.wipeMark = ++this.seq;
    this.marks.clear();
    const held = [...this.entries.keys()];
    this.entries.clear();
    this.bytes = 0;
    // Pages still showing these recordings learn their cached stretches are gone.
    for (const key of held) this.changed(key);
  }

  size(): number {
    return this.bytes;
  }

  private piece(base: number, bytes: Uint8Array, from: number, to: number): Piece {
    const whole = from === base && to === base + bytes.length;
    // A partial piece is copied so it does not pin the whole source buffer in memory.
    const b = whole ? bytes : bytes.slice(from - base, to - base);
    return { start: from, bytes: b, used: ++this.seq, readAt: -Infinity };
  }

  private evict(): void {
    while (this.bytes > this.cap) {
      const now = this.now();
      let victim: { key: string; e: Entry; i: number; used: number } | null = null;
      for (const [key, e] of this.entries) {
        for (let i = 0; i < e.pieces.length; i++) {
          const p = e.pieces[i];
          if (now - p.readAt < READ_PROTECT_MS) continue;
          if (!victim || p.used < victim.used) victim = { key, e, i, used: p.used };
        }
      }
      if (!victim) return;
      this.bytes -= victim.e.pieces[victim.i].bytes.length;
      victim.e.pieces.splice(victim.i, 1);
      this.changed(victim.key);
    }
  }
}
