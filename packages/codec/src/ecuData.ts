/**
 * Port of `ddt4all/core/ecu/ecu_data.py` — extracting a value out of an ECU
 * response, and packing one back into a request.
 *
 * This is the load-bearing part of the whole system: get it wrong and every
 * screen shows plausible nonsense. It is therefore a deliberately literal
 * translation, quirks included, verified against the Python original across the
 * whole database (see `tools/golden`). Read it next to `ecu_data.py:181-437`.
 *
 * ## Preserved quirks — do not "fix" without a golden-vector rerun
 *
 * - **Non-scaled values render as lowercase hex.** `getDisplayValue` returns the
 *   string from `hex()`, so `0xAB` shows as `"ab"`. Users read this on screen.
 * - **`signed` is honoured only for 1- and 2-byte values.** Wider signed fields
 *   fall through unsigned; the original prints a warning and continues.
 * - **Overflow is not validated on write.** `bin(value)[2:].zfill(bitscount)`
 *   can exceed `bitscount`, after which only the *leading* `bitscount` bits are
 *   written — the high bits — silently corrupting the field.
 * - **The little-endian layout is genuinely strange.** The original author's
 *   comment ("Cannot figure out why it's being used / tried to do my best to
 *   mimic the read/write process") is preserved below because it is the only
 *   documentation that exists. ~7% of ECUs use it.
 *
 * ## Deliberate divergences, all failing closed
 *
 * Each case below raises `ValueError`/`IndexError` in Python — a crash mid-screen
 * in the Qt app. Here they return `null` (read) or `null` (write), because a
 * browser tab that dies on one bad widget takes the whole screen with it:
 *
 * - `bitscount <= 0`, or a bit slice that comes out empty
 * - a field extending past the end of the frame being written
 * - a scaled write whose value goes negative after the transform (Python builds
 *   the malformed bit string `"0000b101"` and dies converting it)
 */

import type { DataDef, DataItemDef, Endianness } from "@ddtx/core";
import {
  binToHexLower,
  ceilDiv,
  chunkHex,
  hex16ToSigned,
  hex8ToSigned,
  hexToBin,
  isHex,
} from "./bits.js";
import { pySlice } from "./pyslice.js";
import { decodeUtf8Ignore, formatFixed, pyFloat, pyIntStr, pyRepr } from "./python.js";

/** {@link DataDef} with `ecu_data.py`'s constructor defaults applied. */
export interface ResolvedData {
  name: string;
  bitscount: number;
  bytescount: number;
  scaled: boolean;
  signed: boolean;
  byte: boolean;
  binary: boolean;
  bytesascii: boolean;
  step: number;
  offset: number;
  divideby: number;
  format: string;
  unit: string;
  comment: string;
  /** Raw integer → label. */
  lists: Map<number, string>;
  /** Label → raw integer. The write path's reverse lookup; see i18n-overlay §6.1. */
  items: Map<string, number>;
}

export function resolveData(def: DataDef, name = ""): ResolvedData {
  const lists = new Map<number, string>();
  const items = new Map<string, number>();
  for (const [k, v] of Object.entries(def.lists ?? {})) {
    // JSON object keys are strings even though the DB means them as integers.
    const key = Number.parseInt(k, 10);
    lists.set(key, v);
    items.set(v, key);
  }
  return {
    name,
    bitscount: def.bitscount ?? 8,
    bytescount: def.bytescount ?? 1,
    scaled: def.scaled ?? false,
    signed: def.signed ?? false,
    byte: def.byte ?? false,
    binary: def.binary ?? false,
    bytesascii: def.bytesascii ?? false,
    step: def.step ?? 1,
    offset: def.offset ?? 0,
    divideby: def.divideby ?? 1,
    format: def.format ?? "",
    unit: def.unit ?? "",
    comment: def.comment ?? "",
    lists,
    items,
  };
}

/**
 * Resolve effective byte order. A data item may override the request's, and
 * `"Big"` on the item overrides `"Little"` on the request — order matters, so
 * this mirrors the original's sequence of ifs rather than collapsing it.
 */
function isLittleEndian(item: DataItemDef, ecuEndian: Endianness | undefined): boolean {
  let little = ecuEndian === "Little";
  if (item.endian === "Little") little = true;
  if (item.endian === "Big") little = false;
  return little;
}

/**
 * Pull this value's bits out of a raw response and return them as **lowercase,
 * zero-padded hex**. `null` when the frame is too short or unusable.
 *
 * `resp` is hex text as it comes off the ELM, spaces and all.
 */
export function getHexValue(
  data: ResolvedData,
  item: DataItemDef,
  ecuEndian: Endianness | undefined,
  resp: string,
): string | null {
  const little = isLittleEndian(item, ecuEndian);

  let cleaned = resp.trim().replace(/ /g, "");
  // Any non-hex character invalidates the entire response, not just its tail.
  if (!isHex(cleaned)) cleaned = "";

  const resBytes = chunkHex(cleaned);

  const startByte = item.firstbyte ?? 0;
  const startBit = item.bitoffset ?? 0;
  const bits = data.bitscount;
  if (bits <= 0) return null; // Python: ValueError from int("0b", 2)

  const databytelen = ceilDiv(bits, 8);
  const reqdatabytelen = ceilDiv(bits + startBit, 8);

  // `firstbyte` is 1-based throughout the database.
  const sb = startByte - 1;
  if (sb * 2 + databytelen * 2 > cleaned.length) return null;

  const hextobin = hexToBin(resBytes.slice(sb, sb + reqdatabytelen));

  // Guards the case where the requested window sits entirely past the frame.
  if (pySlice(cleaned, sb * 2, (sb + reqdatabytelen) * 2).length === 0) return null;

  let hexval: string;
  if (little) {
    // "Little endian coding is really weird :/ Cannot figure out why it's being
    // used, but tried to do my best to mimic the read/write process. Actually,
    // need to do it in 3 steps." — ddt4all, ecu_data.py:250
    let remaining = bits;

    const lastbit = 7 - startBit + 1;
    let firstbit = lastbit - bits;
    if (firstbit < 0) firstbit = 0;

    let tmp = pySlice(hextobin, firstbit, lastbit);
    remaining -= lastbit - firstbit;

    if (remaining > 8) {
      const o1 = 8;
      const o2 = o1 + (reqdatabytelen - 2) * 8;
      tmp += pySlice(hextobin, o1, o2);
      remaining -= o2 - o1;
    }

    if (remaining > 0) {
      const o1 = (reqdatabytelen - 1) * 8;
      const o2 = o1 - remaining;
      tmp += pySlice(hextobin, o2, o1);
      remaining -= o1 - o2;
    }

    // The original prints this and carries on with a truncated value.
    // Surfacing it as null would change what screens display, so: carry on.
    if (tmp.length === 0) return null; // Python: ValueError from int("0b", 2)
    hexval = binToHexLower(tmp);
  } else {
    const slice = pySlice(hextobin, startBit, startBit + bits);
    if (slice.length === 0) return null; // Python: ValueError
    hexval = binToHexLower(slice);
  }

  return hexval.padStart(databytelen * 2, "0");
}

/** `int` form of {@link getHexValue}. */
export function getIntValue(
  data: ResolvedData,
  item: DataItemDef,
  ecuEndian: Endianness | undefined,
  resp: string,
): bigint | null {
  const v = getHexValue(data, item, ecuEndian, resp);
  if (v === null) return null;
  return BigInt(`0x${v}`);
}

/** `bytes.fromhex(hex).decode("utf-8", errors="ignore")`. */
function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return decodeUtf8Ignore(bytes);
}

/** Apply `signed` — only for 1- and 2-byte values, per the original. */
function applySign(value: bigint, data: ResolvedData): bigint {
  if (!data.signed) return value;
  if (data.bytescount === 1) return hex8ToSigned(value);
  if (data.bytescount === 2) return hex16ToSigned(value);
  // Original prints "Warning, cannot get signed value for <name>" and leaves it.
  return value;
}

/**
 * The string a screen shows for this value.
 *
 * Three shapes come out of here, and callers must not assume a number:
 * an ASCII string (`bytesascii`), an enum label (`lists` hit), or lowercase
 * hex (non-scaled miss). Only the `scaled` path yields a decimal.
 */
export function getDisplayValue(
  data: ResolvedData,
  item: DataItemDef,
  ecuEndian: Endianness | undefined,
  resp: string,
): string | null {
  const hexval = getHexValue(data, item, ecuEndian, resp);
  if (hexval === null) return null;

  if (data.bytesascii) return hexToUtf8(hexval);

  if (!data.scaled) {
    const val = applySign(BigInt(`0x${hexval}`), data);
    const label = data.lists.get(Number(val));
    if (label !== undefined) return label;
    // Hex, lowercase, as produced by getHexValue. This is intentional.
    return hexval;
  }

  const value = applySign(BigInt(`0x${hexval}`), data);

  if (data.divideby === 0) return null; // original prints "Division by zero"

  const res = (Number(value) * data.step + data.offset) / data.divideby;

  if (data.format.length > 0 && data.format.includes(".")) {
    const decimals = data.format.split(".")[1]?.length ?? 0;
    // Python's "%.Nf", not toFixed — they disagree on exact halfway values,
    // which power-of-two step sizes produce constantly. See python.ts.
    return formatFixed(res, decimals);
  }

  // Python `int()` raises on inf/nan; fail closed rather than print "Infinity".
  if (!Number.isFinite(res)) return null;

  // Python: `if int(res) == res: return str(int(res))` — truncation, not
  // rounding, so only exact integers take this branch. `pyIntStr`, not
  // `String()`: above 2^53 they disagree. See python.ts.
  if (Math.trunc(res) === res) return pyIntStr(res);

  return pyRepr(res);
}

/**
 * Pack `value` into `bytesList` (an array of 2-char hex strings, mutated in
 * place and also returned). `null` if the value can't be encoded.
 *
 * `testMode` mirrors the original's flag: ASCII fields become `FF` filler and
 * scaled inputs are read as hex rather than decimal, for round-trip self-tests.
 */
export function setValue(
  data: ResolvedData,
  item: DataItemDef,
  ecuEndian: Endianness | undefined,
  value: string | string[],
  bytesList: string[],
  testMode = false,
): string[] | null {
  const startByte = (item.firstbyte ?? 0) - 1;
  const startBit = item.bitoffset ?? 0;
  const little = isLittleEndian(item, ecuEndian);

  let raw = value;

  if (data.bytesascii) {
    let s = Array.isArray(raw) ? raw.join("") : String(raw);
    if (data.bytescount > s.length) s = s.padEnd(data.bytescount, " ");
    if (data.bytescount < s.length) s = s.slice(0, data.bytescount);

    let ascii = "";
    for (let i = 0; i < data.bytescount; i++) {
      // Faithful to `hex(ord(c))[2:]`: chars below 0x10 yield ONE hex digit and
      // misalign everything after them. Harmless for printable ASCII, which is
      // all the database uses.
      ascii += testMode ? "FF" : (s.codePointAt(i) ?? 0).toString(16).toUpperCase();
    }
    raw = ascii;
  }

  let intValue: bigint;

  if (data.scaled) {
    if (!testMode) {
      // `float()`, not `Number()` — `Number("")` is 0, which would silently
      // write zero to the ECU where Python rejects the input. See python.ts.
      const f = pyFloat(Array.isArray(raw) ? raw.join("") : raw);
      if (f === null || Number.isNaN(f)) return null;
      const scaled = (f * data.divideby - data.offset) / data.step;
      // Python truncates toward zero here (`int(...)`).
      const truncated = Math.trunc(scaled);
      // Python would build "0000b101" from bin(-5) and die on int(_, 2).
      if (truncated < 0) return null;
      intValue = BigInt(truncated);
    } else {
      const s = Array.isArray(raw) ? raw.join("") : raw;
      if (!isHex(s) || s.length === 0) return null;
      intValue = BigInt(`0x${s}`);
    }
  } else if (!testMode) {
    if (Array.isArray(raw)) {
      if (!raw.every((b) => b.length === 2 && isHex(b))) return null;
      const joined = raw.join("");
      if (joined.length === 0) return null;
      intValue = BigInt(`0x${joined}`);
    } else if (typeof raw === "string") {
      if (!isHex(raw) || raw.length === 0) return null;
      intValue = BigInt(`0x${raw}`);
    } else {
      return null;
    }
  } else {
    const s = Array.isArray(raw) ? raw.join("") : raw;
    if (!isHex(s) || s.length === 0) return null;
    intValue = BigInt(`0x${s}`);
  }

  // Not clamped to bitscount — see the overflow note in the file header.
  const valueasbin = intValue.toString(2).padStart(data.bitscount, "0");

  const numreqbytes = ceilDiv(data.bitscount + startBit, 8);

  if (startByte < 0 || startByte + numreqbytes > bytesList.length) {
    return null; // Python: IndexError while writing back
  }

  const requestBytes = bytesList.slice(startByte, startByte + numreqbytes);
  if (requestBytes.some((b) => b === undefined || !isHex(b) || b.length === 0)) return null;
  const requestasbin = hexToBin(requestBytes).split("");

  if (little) {
    // Mirror of the 3-step read above; see ecu_data.py:250-288.
    let remaining = data.bitscount;

    const lastbit = 7 - startBit + 1;
    let firstbit = lastbit - data.bitscount;
    if (firstbit < 0) firstbit = 0;

    let count = 0;
    for (let i = firstbit; i < lastbit; i++) {
      const bit = valueasbin[count];
      if (bit === undefined || i < 0 || i >= requestasbin.length) return null;
      requestasbin[i] = bit;
      count += 1;
    }
    remaining -= count;

    let currentbyte = 1;
    while (remaining >= 8) {
      for (let i = 0; i < 8; i++) {
        const bit = valueasbin[count];
        const at = currentbyte * 8 + i;
        if (bit === undefined || at >= requestasbin.length) return null;
        requestasbin[at] = bit;
        count += 1;
      }
      remaining -= 8;
      currentbyte += 1;
    }

    if (remaining > 0) {
      const lb = 8;
      const fb = lb - remaining;
      for (let i = fb; i < lb; i++) {
        const bit = valueasbin[count];
        const at = currentbyte * 8 + i;
        if (bit === undefined || at >= requestasbin.length) return null;
        requestasbin[at] = bit;
        count += 1;
      }
    }
  } else {
    for (let i = 0; i < data.bitscount; i++) {
      const bit = valueasbin[i];
      const at = i + startBit;
      if (bit === undefined || at >= requestasbin.length) return null;
      requestasbin[at] = bit;
    }
  }

  const packed = BigInt(`0b${requestasbin.join("")}`);
  const valueashex = packed
    .toString(16)
    .padStart(numreqbytes * 2, "0")
    .toUpperCase();

  for (let i = 0; i < numreqbytes; i++) {
    bytesList[i + startByte] = valueashex.slice(i * 2, i * 2 + 2).padStart(2, "0");
  }

  return bytesList;
}
