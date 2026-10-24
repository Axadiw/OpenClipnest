/**
 * Byte-range sets. Every range is half-open `[start, end)`; every function returns a fresh
 * array that is sorted, non-overlapping and has touching ranges merged. Inputs are never
 * mutated and need not be normalised.
 */
export type ByteRange = { start: number; end: number };

function normalize(ranges: readonly ByteRange[]): ByteRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ start: r.start, end: r.end }));
  sorted.sort((x, y) => x.start - y.start || x.end - y.end);
  const out: ByteRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push(r);
    }
  }
  return out;
}

export function union(a: readonly ByteRange[], b: readonly ByteRange[]): ByteRange[] {
  return normalize([...a, ...b]);
}

export function subtract(a: readonly ByteRange[], b: readonly ByteRange[]): ByteRange[] {
  const A = normalize(a);
  const B = normalize(b);
  const out: ByteRange[] = [];
  let j = 0;
  for (const r of A) {
    let cur = r.start;
    while (j < B.length && B[j].end <= cur) j++;
    let k = j;
    while (k < B.length && B[k].start < r.end) {
      if (B[k].start > cur) out.push({ start: cur, end: B[k].start });
      cur = Math.max(cur, B[k].end);
      k++;
    }
    if (cur < r.end) out.push({ start: cur, end: r.end });
  }
  return out;
}

/** True when `r` lies entirely inside one range of `set` (an empty `r` is trivially covered). */
export function covers(set: readonly ByteRange[], r: ByteRange): boolean {
  if (r.end <= r.start) return true;
  const s = normalize(set);
  let lo = 0;
  let hi = s.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].end <= r.start) lo = mid + 1;
    else if (s[mid].start > r.start) hi = mid - 1;
    else return s[mid].end >= r.end;
  }
  return false;
}

export function totalBytes(set: readonly ByteRange[]): number {
  let n = 0;
  for (const r of normalize(set)) n += r.end - r.start;
  return n;
}
