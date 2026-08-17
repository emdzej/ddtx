/**
 * Reading and clearing diagnostic trouble codes.
 *
 * Port of `param_widget.readDTC` / `clearDTC`. This is where three parts of the
 * database that nothing else uses finally earn their keep: `shiftbytescount`,
 * `minbytes`, and the `devices` / `devicedata` model.
 *
 * The decoding trick is worth understanding, because it looks wrong at first. A DTC
 * response is a header plus N fixed-size records, and the ECU file describes **one**
 * record — its receive fields have offsets into the first record only. So the
 * original decodes the same field set repeatedly against a response window that
 * slides `shiftbytescount` bytes each time. Nothing describes record 2; record 2 is
 * record 1 read further along.
 *
 * `shiftbytescount` is therefore the record stride, and it is present on only 2,265
 * of 541,061 requests — essentially just the DTC readers. Its value is 4 in 1,545 of
 * those.
 */

import type { ResolvedData } from "@ddtx/codec";
import { getHexValue } from "@ddtx/codec";
import type { LoadedEcu } from "@ddtx/db";
import type { ElmDriver } from "@ddtx/elm";
import { negativeResponse } from "@ddtx/link";

/** One decoded field of one DTC record. */
export interface DtcField {
  name: string;
  /** Raw hex, as extracted. */
  hex: string;
  /** The enum label when the field has one, else the numeric value. */
  value: string;
  /** True when `value` came from a `lists` map rather than being a number. */
  labelled: boolean;
}

export interface DtcRecord {
  index: number;
  fields: DtcField[];
}

export type DtcOutcome =
  | "ok"
  /** The ECU has no stored codes. */
  | "none"
  /** No request in this ECU's file reads DTCs. */
  | "unsupported"
  /** The ECU refused. */
  | "rejected"
  /** Something came back that could not be read as a DTC response. */
  | "unreadable";

export interface DtcReadResult {
  outcome: DtcOutcome;
  /** How many the ECU said it had. */
  declared: number;
  records: DtcRecord[];
  /** The request used, for the trace and for explaining an `unsupported`. */
  requestName?: string;
  /** Raw response, kept because a DTC read is exactly when you want to see it. */
  raw?: string;
  detail?: string;
}

/**
 * Names the original looks for, in order.
 *
 * Matched case-insensitively and by exact name only — a substring match would
 * happily pick `ReadDTCInformation.ReportDTCSnapshot`, which returns freeze-frame
 * data in a different shape.
 */
const READ_DTC_REQUESTS = [
  "ReadDTCInformation.ReportDTC",
  "ReadDTC",
  "Lecture des codes défauts",
  "Lecture DTC",
];

const CLEAR_DTC_REQUESTS = [
  "ClearDiagnosticInformation.All",
  "ClearDTC",
  "Clear Diagnostic Information",
  "Effacement des codes défauts",
];

/** UDS `ClearDiagnosticInformation`, all groups — the original's fallback. */
export const DEFAULT_CLEAR_FRAME = "14FF00";

/** The field naming the DTC count, excluded from each record's own fields. */
const COUNT_FIELD = "NDTC";

function findRequest(ecu: LoadedEcu, candidates: readonly string[]) {
  for (const name of candidates) {
    const exact = ecu.requests.get(name);
    if (exact !== undefined) return exact;
  }
  const lowered = new Map<string, string>();
  for (const key of ecu.requests.keys()) lowered.set(key.toLowerCase(), key);
  for (const name of candidates) {
    const key = lowered.get(name.toLowerCase());
    if (key !== undefined) return ecu.requests.get(key);
  }
  return undefined;
}

/**
 * Does this ECU describe a way to read DTCs *and* name any fields in the answer?
 *
 * Three ECUs in the database (two side radars and a front radar, all C1ARun2)
 * describe `ReadDTCInformation.ReportDTC` with an empty `receivebyte_dataitems`, so
 * there is nothing to pull out of whatever they reply. Reading them can only ever
 * produce an empty list, and a button that always shows nothing is worse than no
 * button, so they count as unsupported.
 */
export function supportsDtcRead(ecu: LoadedEcu): boolean {
  const request = findRequest(ecu, READ_DTC_REQUESTS);
  if (request === undefined) return false;
  return Object.keys(request.def.receivebyte_dataitems ?? {}).length > 0;
}

export function dtcReadRequestName(ecu: LoadedEcu): string | undefined {
  return findRequest(ecu, READ_DTC_REQUESTS)?.def.name;
}

export function dtcClearRequestName(ecu: LoadedEcu): string | undefined {
  return findRequest(ecu, CLEAR_DTC_REQUESTS)?.def.name;
}

/** Nothing usable came back — empty, an adapter complaint, or not hex at all. */
function isEmpty(response: string): boolean {
  const compact = response.replace(/\s+/g, "").toUpperCase();
  return (
    compact.length === 0 ||
    compact.includes("WRONG") ||
    compact.includes("NODATA") ||
    !/^[0-9A-F]+$/.test(compact)
  );
}

/**
 * Split a response into 2-char byte tokens, ignoring how it was spaced.
 *
 * Returns nothing for anything that is not pure hex. That guard is load-bearing:
 * `getHexValue` invalidates the **whole** response on a single non-hex character, so
 * letting `"NO DATA"` through as `["NO", "DA", "TA"]` does not corrupt one field —
 * it silently blanks every field of every record. Which is exactly what happened
 * before this check existed, and `NO DATA` is precisely what an ELM327 answers when
 * an ECU has no more codes to give.
 */
function toBytes(response: string): string[] {
  const compact = response.replace(/\s+/g, "").toUpperCase();
  if (compact.length === 0 || !/^[0-9A-F]+$/.test(compact)) return [];
  return compact.match(/.{1,2}/g) ?? [];
}

/**
 * Decode one field, rendering an enum label where the database defines one.
 *
 * The original shows `label` for an enum and `decimal [hex]` otherwise, and that
 * distinction is worth keeping: a failure type reads as "Circuit ouvert", while a
 * counter reads as a number.
 */
function decodeField(
  name: string,
  data: ResolvedData,
  item: Parameters<typeof getHexValue>[1],
  endianness: LoadedEcu["endianness"],
  window: string,
): DtcField | null {
  const hex = getHexValue(data, item, endianness, window);
  if (hex === null) return null;

  const numeric = Number.parseInt(hex, 16);
  const label = Number.isNaN(numeric) ? undefined : data.lists.get(numeric);
  if (label !== undefined) return { name, hex, value: label, labelled: true };
  return { name, hex, value: Number.isNaN(numeric) ? hex : String(numeric), labelled: false };
}

/**
 * The slice of the adapter the fault reader needs.
 *
 * Narrower than `ElmDriver` on purpose: it lets demo mode drive this panel through a
 * mock, so the fault UI can be built and checked without a vehicle. The two timeout
 * calls are optional because only clearing needs the longer window, and a simulated
 * link has no timeout to widen.
 */
export interface DtcLink {
  request(frame: string, options?: { cache?: boolean }): Promise<string>;
  setCanTimeout?(milliseconds: number): Promise<void>;
  resetCanTimeout?(): Promise<void>;
}

/**
 * Read stored DTCs.
 *
 * `moreDtcLimit` bounds the continuation loop — the original caps it at 50 for the
 * same reason, since an ECU that keeps saying "more" would otherwise hang the read.
 */
export async function readDtcs(
  driver: DtcLink,
  ecu: LoadedEcu,
  options: { sessionCommand?: string; moreDtcLimit?: number } = {},
): Promise<DtcReadResult> {
  const request = findRequest(ecu, READ_DTC_REQUESTS);
  if (request === undefined) {
    return {
      outcome: "unsupported",
      declared: 0,
      records: [],
      detail: "no request in this ECU's file reads trouble codes",
    };
  }

  const requestName = request.def.name;
  const sentBytes = (request.def.sentbytes ?? "").toUpperCase();
  if (sentBytes === "") {
    return { outcome: "unsupported", declared: 0, records: [], requestName };
  }

  if (options.sessionCommand !== undefined) {
    await driver.request(options.sessionCommand, { cache: false });
  }

  const reply = await driver.request(sentBytes, { cache: false });
  const rejected = negativeResponse(reply);
  if (rejected !== null) {
    return {
      outcome: "rejected",
      declared: 0,
      records: [],
      requestName,
      raw: reply,
      detail: `${rejected.code} ${rejected.message}`,
    };
  }

  if (isEmpty(reply)) {
    return { outcome: "none", declared: 0, records: [], requestName, raw: reply };
  }

  let bytes = toBytes(reply);

  // Two bytes is the header alone: a positive response declaring nothing.
  if (bytes.length <= 2) {
    return { outcome: "none", declared: 0, records: [], requestName, raw: reply };
  }

  // Byte 2 (1-indexed) is the count. `NDTC` names it in the database, but the
  // original reads the position directly and so does this.
  const declared = Number.parseInt(bytes[1] ?? "", 16);
  if (Number.isNaN(declared)) {
    return {
      outcome: "unreadable",
      declared: 0,
      records: [],
      requestName,
      raw: reply,
      detail: `expected a DTC count at byte 2, got ${JSON.stringify(bytes[1] ?? "")}`,
    };
  }
  if (declared === 0) {
    return { outcome: "none", declared: 0, records: [], requestName, raw: reply };
  }

  // Fetch continuation frames while the ECU has more to give.
  //
  // The original builds this command with `''.join(str(bytestosend))`, which
  // stringifies a Python *list* — producing `"['19', '02', 'FF']"` and sending that
  // as a command. So its continuation has never worked. Built properly here: the
  // `MoreDTC` send field is set to FF, which is what the field is for.
  const moreField = (request.def.sendbyte_dataitems ?? {})["MoreDTC"];
  if (moreField !== undefined) {
    const limit = options.moreDtcLimit ?? 50;
    const template = toBytes(sentBytes);
    const at = (moreField.firstbyte ?? 0) - 1;
    if (at >= 0 && at < template.length) {
      template[at] = "FF";
      const moreFrame = template.join("");
      for (let i = 0; i < limit; i++) {
        const more = await driver.request(moreFrame, { cache: false });
        if (isEmpty(more) || negativeResponse(more) !== null) break;
        const moreBytes = toBytes(more);
        // Nothing usable, or a header with no records behind it: we are done.
        if (moreBytes.length <= 2) break;
        // Drop the two header bytes and append the records.
        bytes = [...bytes, ...moreBytes.slice(2)];
      }
    }
  }

  const stride = request.def.shiftbytescount ?? 0;
  const receiveItems = Object.entries(request.def.receivebyte_dataitems ?? {}).filter(
    ([name]) => name !== COUNT_FIELD,
  );

  const records: DtcRecord[] = [];
  let window = bytes;

  for (let n = 0; n < declared; n++) {
    const spaced = window.join(" ");
    const fields: DtcField[] = [];

    for (const [name, item] of receiveItems) {
      const data = ecu.data.get(name);
      if (data === undefined) continue;
      const field = decodeField(name, data, item, ecu.endianness, spaced);
      if (field !== null) fields.push(field);
    }

    // A record that decoded nothing means the response ran out; stop rather than
    // emit empty records to reach the declared count.
    if (fields.length === 0) break;
    records.push({ index: n, fields });

    // Slide the window. With no stride there is only ever one record to read.
    if (stride <= 0) break;
    window = window.slice(stride);
    if (window.length === 0) break;
  }

  return { outcome: "ok", declared, records, requestName, raw: reply };
}

export interface DtcClearResult {
  cleared: boolean;
  /** The frame sent, which may be the generic fallback. */
  frame: string;
  requestName?: string;
  /** True when no request described it and `14FF00` was used. */
  usedFallback: boolean;
  raw?: string;
  detail?: string;
}

/**
 * Clear stored DTCs.
 *
 * Irreversible, and the caller is expected to have gone through the write gates
 * first — this function does not ask. It is separate from `readDtcs` for that
 * reason: reading is safe and clearing is not.
 *
 * The original widens the CAN timeout to 1500 ms and waits half a second before
 * sending, because an ECU erasing its fault memory can take a while to answer and a
 * timeout here reads as a failure when the erase actually happened.
 */
export async function clearDtcs(
  driver: DtcLink,
  ecu: LoadedEcu,
  options: { sessionCommand?: string; settleMs?: number } = {},
): Promise<DtcClearResult> {
  const request = findRequest(ecu, CLEAR_DTC_REQUESTS);
  const frame = (request?.def.sentbytes ?? DEFAULT_CLEAR_FRAME).toUpperCase();
  const usedFallback = request === undefined;

  if (options.sessionCommand !== undefined) {
    await driver.request(options.sessionCommand, { cache: false });
  }

  // An erase can be slow to acknowledge; a short timeout would report failure for
  // something that worked.
  // 1500 ms saturates AT ST at its 1020 ms ceiling, which is what the original
  // asks for too; the point is "much longer than a read", not the exact figure.
  await driver.setCanTimeout?.(1500).catch(() => undefined);
  if ((options.settleMs ?? 500) > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 500));
  }

  const reply = await driver.request(frame, { cache: false });
  await driver.resetCanTimeout?.().catch(() => undefined);

  const rejected = negativeResponse(reply);
  if (rejected !== null) {
    return {
      cleared: false,
      frame,
      ...(request === undefined ? {} : { requestName: request.def.name }),
      usedFallback,
      raw: reply,
      detail: `${rejected.code} ${rejected.message}`,
    };
  }
  if (reply.includes("WRONG") || reply.trim() === "") {
    return {
      cleared: false,
      frame,
      ...(request === undefined ? {} : { requestName: request.def.name }),
      usedFallback,
      raw: reply,
      detail: "no usable response",
    };
  }

  return {
    cleared: true,
    frame,
    ...(request === undefined ? {} : { requestName: request.def.name }),
    usedFallback,
    raw: reply,
  };
}
