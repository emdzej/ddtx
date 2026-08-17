/**
 * Port of `ddt4all/core/ecu/ecu_request.py` — turning a request definition plus
 * user input into bytes to send, and a response into named values.
 *
 * Transport is deliberately absent. The original's `send_request` reaches
 * straight into the `options.elm` module global (one of 92 such references);
 * here the caller owns the round trip, so this module stays pure and testable.
 *
 * `minbytes`, `replybytes`, and `shiftbytescount` are carried on the type but
 * unused here: `replybytes` is simulation-mode canned data, and the other two
 * are only read by the DTC reader (`param_widget.py:1305`) and the DB editor.
 */

import type { DataDef, DataItemDef, Endianness, RequestDef } from "@ddtx/core";
import { chunkHex } from "./bits.js";
import { getDisplayValue, resolveData, setValue, type ResolvedData } from "./ecuData.js";

/**
 * A request definition bound to the data dictionary of its ECU file.
 *
 * The `data` map is the ECU-wide one, keyed by the (French) data name — the
 * same string a layout widget's `text` field carries. Never translate before
 * looking up here; see docs/i18n-overlay.md.
 */
export interface BoundRequest {
  def: RequestDef;
  endianness: Endianness | undefined;
  data: ReadonlyMap<string, ResolvedData>;
}

/** Raised when a request references a data name its ECU file doesn't define. */
export class DbIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbIntegrityError";
  }
}

/** Bind an ECU file's `data` dictionary once, for reuse across its requests. */
export function resolveDataDictionary(data: Record<string, DataDef>): Map<string, ResolvedData> {
  const out = new Map<string, ResolvedData>();
  for (const [name, def] of Object.entries(data)) out.set(name, resolveData(def, name));
  return out;
}

/** `sentbytes` split into the mutable 2-char-per-byte array the codec writes into. */
export function formatSentBytes(sentbytes: string | undefined): string[] {
  return chunkHex(sentbytes ?? "");
}

/**
 * Build the outgoing byte array, applying each supplied input to its field.
 *
 * `inputs` is keyed by data name. A value that matches one of the field's enum
 * labels is converted back to its raw integer first — which is why the UI must
 * hand back the untranslated label or, better, the integer itself.
 *
 * Returns `null` if any field failed to encode, matching `setValue`.
 */
export function buildDataStream(
  request: BoundRequest,
  inputs: Record<string, string | string[]> = {},
): string[] | null {
  const stream = formatSentBytes(request.def.sentbytes);
  const sendItems = request.def.sendbyte_dataitems ?? {};

  for (const [name, supplied] of Object.entries(inputs)) {
    const item: DataItemDef | undefined = sendItems[name];
    if (item === undefined) {
      throw new DbIntegrityError(
        `buildDataStream: request has no send field ${JSON.stringify(name)}`,
      );
    }

    const data = request.data.get(name);
    if (data === undefined) {
      throw new DbIntegrityError(`buildDataStream: ECU defines no data ${JSON.stringify(name)}`);
    }

    let value = supplied;
    if (typeof value === "string") {
      const raw = data.items.get(value);
      // `hex(...)[2:].upper()` — the enum's integer as uppercase hex, which the
      // non-scaled branch of setValue then parses back out.
      if (raw !== undefined) value = raw.toString(16).toUpperCase();
    }

    if (setValue(data, item, request.endianness, value, stream) === null) return null;
  }

  return stream;
}

/** The hex text to send, e.g. `"31 A0 01"`. */
export function formatRequestStream(stream: readonly string[]): string {
  return stream.join(" ");
}

/**
 * Decode every field the request declares out of a raw response.
 *
 * A field whose bits fall outside the frame comes back as `null` rather than
 * being omitted, so callers can tell "not present in this response" from
 * "decoded to an empty string".
 */
export function decodeStream(request: BoundRequest, stream: string): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  const recvItems = request.def.receivebyte_dataitems ?? {};

  for (const [name, item] of Object.entries(recvItems)) {
    const data = request.data.get(name);
    if (data === undefined) {
      throw new DbIntegrityError(`decodeStream: ECU defines no data ${JSON.stringify(name)}`);
    }
    values[name] = getDisplayValue(data, item, request.endianness, stream);
  }

  return values;
}
