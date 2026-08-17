/**
 * Bit/hex primitives matching CPython's semantics, because the codec they
 * support is a line-by-line port and its behaviour on edge cases is what the
 * ECU database was authored against.
 *
 * Everything goes through `BigInt`, not `number`. `bitscount` is
 * `bytescount * 8` for byte-defined values, and the database contains values up
 * to 357 bytes wide, so `int(x, 2)` in Python routinely exceeds what a float64
 * can hold exactly. Using `number` here would silently corrupt wide fields —
 * VIN strings, DTC records, calibration blobs.
 */

const HEX = /^[0-9a-fA-F]*$/;

export function isHex(s: string): boolean {
  return HEX.test(s);
}

/**
 * `bin(int(chunk, 16))[2:].zfill(8)`.
 *
 * `chunk` is normally two hex chars, but Python's chunking of an odd-length
 * response yields a one-char final chunk, which it still widens to 8 bits —
 * so a trailing nibble reads as a whole byte. Preserved deliberately.
 */
export function hexChunkToBin(chunk: string): string {
  const v = Number.parseInt(chunk, 16);
  if (Number.isNaN(v)) throw new Error(`not hex: ${JSON.stringify(chunk)}`);
  return v.toString(2).padStart(8, "0");
}

/** `"".join(bin(int(b,16))[2:].zfill(8) for b in chunks)`. */
export function hexToBin(chunks: readonly string[]): string {
  let out = "";
  for (const c of chunks) out += hexChunkToBin(c);
  return out;
}

/**
 * `hex(int("0b" + bits, 2))[2:]` — **lowercase, unpadded**.
 *
 * The lowercase is load-bearing: `EcuData.getDisplayValue` returns this string
 * verbatim for every non-scaled value, so it is what the user sees on screen.
 */
export function binToHexLower(bits: string): string {
  if (bits.length === 0) throw new Error("binToHexLower: empty bit string");
  return BigInt(`0b${bits}`).toString(16);
}

/** Split a hex string into 2-char chunks; a trailing odd nibble stays 1 char. */
export function chunkHex(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

/** `-(value & 0x80) | (value & 0x7f)` */
export function hex8ToSigned(value: bigint): bigint {
  return -(value & 0x80n) | (value & 0x7fn);
}

/** `-(value & 0x8000) | (value & 0x7fff)` */
export function hex16ToSigned(value: bigint): bigint {
  return -(value & 0x8000n) | (value & 0x7fffn);
}

/** `math.ceil(a / b)` for positive integers. */
export function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}
