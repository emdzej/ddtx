/**
 * CPython compatibility primitives.
 *
 * Three places where the obvious JavaScript equivalent is subtly wrong, each
 * found by the golden-vector diff against the original codec rather than by
 * reading the code. All three affect what a user reads off a live ECU, so they
 * get exact implementations rather than close-enough ones.
 */

/* ── float parsing ───────────────────────────────────────────────────────── */

/**
 * `float(s)` — returns `null` where Python would raise `ValueError`.
 *
 * `Number()` cannot stand in for this. `Number("")` is **0**, not `NaN`, so an
 * empty input to a scaled field would encode as zero and be written to the car
 * instead of being rejected. `Number()` also accepts `"0x10"`, `"0b1"`, and
 * `"Infinity"` (which Python spells `"inf"`), and rejects `"1_000"` (which
 * Python accepts).
 */
const FLOAT_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;

export function pyFloat(s: string): number | null {
  // Python strips ASCII whitespace, then requires the whole remainder to parse.
  let t = s.trim();
  if (t.length === 0) return null;

  // Underscores are permitted between digits (PEP 515). Reject them anywhere
  // else, which is what Python does.
  if (t.includes("_")) {
    if (/_{2,}|^_|_$|_(?=[.eE])|(?<=[.eE])_/.test(t)) return null;
    t = t.replace(/_/g, "");
  }

  if (!FLOAT_RE.test(t)) return null;

  const lower = t.toLowerCase();
  if (lower.endsWith("nan")) return Number.NaN;
  if (lower.endsWith("inf") || lower.endsWith("infinity")) {
    return t.startsWith("-") ? -Infinity : Infinity;
  }
  return Number(t);
}

/* ── fixed-point formatting ──────────────────────────────────────────────── */

/**
 * `"%.<decimals>f" % value` — correct rounding of the double's *exact* binary
 * value, ties to even.
 *
 * `toFixed` rounds ties away from zero, so it disagrees with Python on every
 * value that lands exactly halfway: `(11.25).toFixed(1)` is `"11.3"` while
 * Python's `"%.1f" % 11.25` is `"11.2"`. Scaled ECU values hit this constantly,
 * because their step sizes are negative powers of two (0.25, 0.125, 0.0078125)
 * and therefore produce exact halfway cases.
 *
 * Works on the exact decimal expansion via BigInt: a double is
 * `mantissa × 2^exponent`, and `2^-k = 5^k / 10^k`, so the exact value is
 * always representable as a BigInt over a power of ten.
 */
export function formatFixed(value: number, decimals: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";

  const negative = value < 0 || Object.is(value, -0);
  const { mantissa, exponent } = decompose(Math.abs(value));

  // |value| = mantissa * 2^exponent, mantissa integral.
  let numerator: bigint;
  let scale: number; // implied denominator of 10^scale

  if (exponent >= 0) {
    numerator = mantissa << BigInt(exponent);
    scale = 0;
  } else {
    const k = -exponent;
    numerator = mantissa * 5n ** BigInt(k);
    scale = k;
  }

  let digits: bigint;
  if (decimals >= scale) {
    digits = numerator * 10n ** BigInt(decimals - scale);
  } else {
    const divisor = 10n ** BigInt(scale - decimals);
    const q = numerator / divisor;
    const r = numerator % divisor;
    const twice = r * 2n;
    if (twice > divisor) digits = q + 1n;
    else if (twice < divisor) digits = q;
    else digits = q % 2n === 0n ? q : q + 1n; // ties to even
  }

  let text = digits.toString();
  if (decimals > 0) {
    text = text.padStart(decimals + 1, "0");
    text = `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
  }
  return negative ? `-${text}` : text;
}

/** Split a positive finite double into an integral mantissa and a base-2 exponent. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);

  const rawExponent = (hi >>> 20) & 0x7ff;
  const rawMantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);

  if (rawExponent === 0) {
    // Subnormal: no implicit leading bit.
    return { mantissa: rawMantissa, exponent: -1074 };
  }
  return { mantissa: rawMantissa | (1n << 52n), exponent: rawExponent - 1075 };
}

/* ── number to string ────────────────────────────────────────────────────── */

/**
 * `str(int(x))` for an integer-valued double — the double's **exact** value.
 *
 * `String(3997075599374417000)` prints the shortest decimal that round-trips,
 * but Python's `int()` converts to the exact binary value first, giving
 * `3997075599374416896`. They differ for anything above 2^53, which 64-bit
 * scaled fields reach routinely.
 */
export function pyIntStr(x: number): string {
  return BigInt(x).toString();
}

/**
 * `str(x)` / `repr(x)` for a non-integral double.
 *
 * Both languages pick the shortest decimal that round-trips, then disagree on
 * when to switch to scientific notation and how to write the exponent:
 *
 * | value    | Python     | JavaScript |
 * |----------|------------|------------|
 * | 1e-5     | `1e-05`    | `0.00001`  |
 * | 3.48e-06 | `3.48e-06` | `0.00000348` |
 * | 1e16     | `1e+16`    | `10000000000000000` |
 *
 * Python uses fixed notation only for decimal exponents in `[-4, 15]`, and pads
 * the exponent to two digits. JavaScript's window is `[-7, 20]` with an
 * unpadded exponent.
 */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";

  const negative = x < 0;
  const abs = Math.abs(x);

  // Shortest round-tripping digits, as "d.dddde±k".
  const [mantissa, exponentText] = abs.toExponential().split("e") as [string, string];
  const exponent = Number.parseInt(exponentText, 10);
  const digits = mantissa.replace(".", "");

  let body: string;
  if (exponent >= -4 && exponent <= 15) {
    if (exponent >= 0) {
      const intLength = exponent + 1;
      const whole = digits.padEnd(intLength, "0").slice(0, intLength);
      const frac = digits.length > intLength ? digits.slice(intLength) : "";
      // Python always shows a fractional part for a float.
      body = frac.length > 0 ? `${whole}.${frac}` : `${whole}.0`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const lead = digits[0] ?? "0";
    const rest = digits.slice(1);
    const sign = exponent < 0 ? "-" : "+";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    // Unlike the fixed branch, Python does *not* force a fractional part here:
    // `repr(4e-05)` is "4e-05", not "4.0e-05".
    body = `${lead}${rest.length > 0 ? `.${rest}` : ""}e${sign}${magnitude}`;
  }

  return negative ? `-${body}` : body;
}

/* ── UTF-8 decoding ─────────────────────────────────────────────────────── */

/**
 * `bytes.decode("utf-8", errors="ignore")` — invalid sequences are **dropped**,
 * not replaced.
 *
 * `TextDecoder` with `fatal: false` substitutes U+FFFD, which shows up on
 * screen as `����` where Python shows nothing. Since ASCII fields in this
 * database are routinely read out of frames that are partly binary, this is the
 * single most visible decode difference — it accounted for most of the initial
 * golden-vector mismatches.
 *
 * On an invalid sequence, CPython resumes at the byte that *caused* the failure
 * rather than skipping past it, so `C3 28` yields `"("` and `E1 80 41` yields
 * `"A"`. Only an invalid lead byte is itself consumed.
 */
export function decodeUtf8Ignore(bytes: Uint8Array): string {
  let out = "";
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i] as number;

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }

    // Continuation byte or an over-long/out-of-range lead: consume and drop.
    if (b0 < 0xc2 || b0 > 0xf4) {
      i += 1;
      continue;
    }

    const length = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;

    // Range of the *first* continuation byte is narrower for some leads, which
    // is what rejects surrogates (ED A0..BF) and out-of-range planes (F4 90..).
    let lowMin = 0x80;
    let lowMax = 0xbf;
    if (b0 === 0xe0) lowMin = 0xa0;
    else if (b0 === 0xed) lowMax = 0x9f;
    else if (b0 === 0xf0) lowMin = 0x90;
    else if (b0 === 0xf4) lowMax = 0x8f;

    let valid = true;
    let codePoint = b0 & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
    let consumed = 1;

    for (let k = 1; k < length; k++) {
      const b = bytes[i + k];
      const min = k === 1 ? lowMin : 0x80;
      const max = k === 1 ? lowMax : 0xbf;
      if (b === undefined || b < min || b > max) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (b & 0x3f);
      consumed += 1;
    }

    if (!valid) {
      // Resume at the offending byte: advance by what validated, minimum one.
      i += consumed;
      continue;
    }

    out += String.fromCodePoint(codePoint);
    i += length;
  }

  return out;
}
