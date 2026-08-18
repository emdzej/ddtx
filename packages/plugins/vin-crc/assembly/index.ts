/**
 * The CRC a Renault ECU expects alongside a VIN.
 *
 * Port of `plugins/vin_crc.py`. The original uses `crcmod.predefined.mkCrcFun('x-25')`
 * and then swaps the two bytes of the result, with the comment "Seems that computed CRC
 * is returned in little endian way". That swap is part of the answer, not a bug: the
 * value goes into a VIN-write request byte-for-byte in that order.
 *
 * CRC-16/X-25, a.k.a. IBM-SDLC: polynomial 0x1021 reflected to 0x8408, init 0xFFFF,
 * input and output reflected, final XOR 0xFFFF. Implemented from the specification
 * rather than ported from a library, and checked against the algorithm's own published
 * check value — 0x906E over "123456789" — which the host-side test asserts.
 *
 * Needs no vehicle. It asks for a VIN and reports the CRC, which is why its manifest
 * declares `ask` and nothing else.
 */

import { ask, done, failed, readResult, field, succeeded } from "../../_sdk/assembly/host";

export { alloc } from "../../_sdk/assembly/host";

export function start(): i32 {
  return ask("Enter the 17-character VIN", "vin");
}

export function resume(ptr: i32, len: i32): i32 {
  const result = readResult(ptr, len);
  if (!succeeded(result)) return failed("No VIN was entered.");

  const vin = field(result, "value").trim().toUpperCase();
  if (vin.length == 0) return failed("No VIN was entered.");

  const crc = x25(vin);
  // High and low byte swapped, as the original returns it.
  const swapped = ((crc & 0xff) << 8) | ((crc >> 8) & 0xff);

  return done(vin + " → CRC " + hex4(swapped) + "  (raw " + hex4(crc) + ")");
}

/** CRC-16/X-25 over the string's bytes. */
function x25(text: string): i32 {
  let crc: i32 = 0xffff;
  for (let i = 0; i < text.length; i++) {
    // The VIN is ASCII, so the code unit is the byte.
    crc ^= text.charCodeAt(i) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) != 0 ? ((crc >> 1) ^ 0x8408) & 0xffff : (crc >> 1) & 0xffff;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

function hex4(value: i32): string {
  const digits = "0123456789ABCDEF";
  let out = "";
  for (let shift = 12; shift >= 0; shift -= 4) {
    out += digits.charAt((value >> shift) & 0xf);
  }
  return out;
}
