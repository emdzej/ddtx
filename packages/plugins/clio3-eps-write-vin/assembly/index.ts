/**
 * Modus / Clio III EPS — write a VIN.
 *
 * Port of the `write_vin` half of `plugins/clio3_eps_reset.py`. Asks for the VIN,
 * computes its CRC, and writes both in one request.
 *
 * ## The CRC has to go across as raw bytes, not as hex text
 *
 * `CRC VIN` is a two-byte `bytesascii` field, so the codec writes the *code point* of
 * each character of the supplied string. The original does `calc_crc(vin).decode('hex')`
 * — it turns the hex text `"108B"` into the two bytes `0x10 0x8B` and passes those. So
 * this emits the CRC as two `\u` escapes, which puts exactly those two bytes on the
 * wire. Sending `"108B"` as text would write four bytes of ASCII digits instead, into a
 * two-byte field.
 *
 * The CRC is CRC-16/X-25 byte-swapped, the same computation `vin-crc` performs and
 * verified there against the algorithm's published check value.
 *
 * The VIN length check is the original's: exactly 17 characters, refused otherwise.
 *
 * **Unverified on a vehicle.** A wrong VIN or CRC leaves the module paired to a vehicle
 * that does not exist, so this one especially is not something to run on a guess.
 */

import { ask, done, escape, failed, field, readResult, session, succeeded, write } from "../../_sdk/assembly/host";

export { alloc } from "../../_sdk/assembly/host";

let step: i32 = -1;
let vin: string = "";

export function start(): i32 {
  step = 0;
  return next("");
}

export function resume(ptr: i32, len: i32): i32 {
  step += 1;
  return next(readResult(ptr, len));
}

function next(result: string): i32 {
  switch (step) {
    case 0:
      return ask("Enter the 17-character VIN to write", "vin");

    case 1: {
      if (!succeeded(result)) return failed("No VIN was entered.");
      vin = field(result, "value").trim().toUpperCase();
      // The original refuses anything but 17 characters rather than padding or
      // truncating, and a VIN is the wrong place to be lenient.
      if (vin.length != 17) return failed("A VIN is 17 characters; got " + vin.length.toString() + ".");
      return session("Start Diagnostic Session");
    }

    case 2: {
      const crc = swapped(x25(vin));
      // Two \u escapes, so the field receives the two bytes rather than four hex digits.
      const crcBytes = "\\u" + hex4(crc >> 8) + "\\u" + hex4(crc & 0xff);
      return write(
        "WDBLI - VIN",
        '{"VIN":"' + escape(vin) + '","CRC VIN":"' + crcBytes + '"}',
      );
    }

    case 3:
      return succeeded(result)
        ? done("VIN written: " + vin + ". Read it back to confirm.")
        : failed("The module refused the VIN write.");

    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}

/** CRC-16/X-25 over the string's bytes. Same implementation as `vin-crc`. */
function x25(text: string): i32 {
  let crc: i32 = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) != 0 ? ((crc >> 1) ^ 0x8408) & 0xffff : (crc >> 1) & 0xffff;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

/** High and low byte exchanged, as the original returns it. */
function swapped(crc: i32): i32 {
  return ((crc & 0xff) << 8) | ((crc >> 8) & 0xff);
}

/** Four hex digits, for a `\uXXXX` escape. */
function hex4(value: i32): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let shift = 12; shift >= 0; shift -= 4) out += digits.charAt((value >> shift) & 0xf);
  return out;
}
