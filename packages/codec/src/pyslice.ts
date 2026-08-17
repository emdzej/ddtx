/**
 * CPython's `str[i:j]` semantics, which differ from `String.prototype.slice`
 * in ways the little-endian decode path in `ecu_data.py` actually hits.
 *
 * Specifically, `getHexValue`'s little-endian branch computes
 * `offset2 = offset1 - totalremainingbits`, which goes negative for narrow
 * fields. Python then reads that as an index *from the end* of the string.
 * `String.slice` agrees on negatives but not on the clamping order, and
 * `substring` disagrees entirely by swapping reversed bounds. Rather than
 * reason about which cases coincide, this reproduces the algorithm.
 */
export function pySlice(s: string, start: number, stop: number): string {
  const n = s.length;

  let i = start;
  if (i < 0) {
    i += n;
    if (i < 0) i = 0;
  } else if (i > n) {
    i = n;
  }

  let j = stop;
  if (j < 0) {
    j += n;
    if (j < 0) j = 0;
  } else if (j > n) {
    j = n;
  }

  if (j <= i) return "";
  return s.slice(i, j);
}
