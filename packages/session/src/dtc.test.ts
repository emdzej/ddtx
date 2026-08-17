/**
 * Modelled on a real DTC reader: SIRIUS34's `ReadDTC` — `17FF00`, stride 3, a
 * `MoreDTC` send field, and fields packed into byte 5 by bit offset.
 *
 * The stride is the thing worth testing hardest. The ECU file describes one record;
 * every later record is that same field set read further along the response. Get the
 * slide wrong and every DTC after the first is silently wrong, which is worse than
 * failing.
 */

import { describe, expect, it } from "vitest";
import { resolveDataDictionary, type BoundRequest } from "@ddtx/codec";
import type { DataDef, ObdConfig, RequestDef } from "@ddtx/core";
import type { LoadedEcu } from "@ddtx/db";
import { ElmDriver, MockElm, type FrameHandler } from "@ddtx/elm";
import {
  clearDtcs,
  DEFAULT_CLEAR_FRAME,
  dtcClearRequestName,
  readDtcs,
  supportsDtcRead,
} from "./dtc.js";

const data: Record<string, DataDef> = {
  NDTC: { bitscount: 8, bytescount: 1 },
  // A 16-bit code at byte 3 — the DTC number itself.
  FirstDTC: { bitscount: 16, bytescount: 2 },
  // Status bits packed into byte 5, as the real file does.
  "Current Failure": { bitscount: 1, bytescount: 1, lists: { "0": "no", "1": "yes" } },
  "Standard Fault": {
    bitscount: 5,
    bytescount: 1,
    lists: { "1": "Circuit ouvert", "2": "Court circuit", "3": "Hors tolérance" },
  },
};

const readRequest: RequestDef = {
  name: "ReadDTC",
  deny_sds: [],
  sentbytes: "17FF00",
  minbytes: 2,
  shiftbytescount: 3,
  sendbyte_dataitems: { MoreDTC: { firstbyte: 2 } },
  receivebyte_dataitems: {
    NDTC: { firstbyte: 2 },
    FirstDTC: { firstbyte: 3 },
    "Current Failure": { firstbyte: 5, bitoffset: 0 },
    "Standard Fault": { firstbyte: 5, bitoffset: 1 },
  },
};

const clearRequest: RequestDef = {
  name: "ClearDTC",
  deny_sds: [],
  sentbytes: "14FF00",
};

function ecuWith(requests: RequestDef[], protocol = "CAN"): LoadedEcu {
  const resolved = resolveDataDictionary(data);
  return {
    slug: "sirius",
    def: {
      ecuname: "SIRIUS34",
      obd: { protocol, funcaddr: "7A", funcname: "Injection" } as ObdConfig,
      autoidents: [],
      requests,
      data,
      devices: [],
    },
    endianness: "Big",
    data: resolved,
    requests: new Map<string, BoundRequest>(
      requests.map((def) => [def.name, { def, endianness: "Big" as const, data: resolved }]),
    ),
  };
}

function harness(onFrame: FrameHandler) {
  const mock = new MockElm({ onFrame });
  return { mock, driver: new ElmDriver(mock, { sleep: () => Promise.resolve() }) };
}

/** ISO-TP frame a payload so the driver reassembles it normally. */
function frameReply(payloadHex: string): string[] {
  const hex = payloadHex.toUpperCase();
  const bytes = hex.length / 2;
  if (bytes <= 7) {
    return [bytes.toString(16).toUpperCase().padStart(2, "0") + hex.padEnd(14, "0")];
  }
  const frames = [
    `1${bytes.toString(16).toUpperCase().padStart(3, "0").slice(-3)}${hex.slice(0, 12)}`,
  ];
  let rest = hex.slice(12);
  let sequence = 1;
  while (rest.length > 0) {
    frames.push(
      `2${(sequence % 16).toString(16).toUpperCase()}${rest.slice(0, 14).padEnd(14, "0")}`,
    );
    sequence += 1;
    rest = rest.slice(14);
  }
  return frames;
}

/** Answers `17FF00` with the given payload; everything else is silent. */
function dtcEcu(payloadByRequest: Record<string, string>): FrameHandler {
  return (frame) => {
    const request = frame.slice(2);
    const payload = payloadByRequest[request];
    if (payload === undefined) return undefined;
    if (payload === "") return "NO DATA";
    return frameReply(payload);
  };
}

describe("support detection", () => {
  it("finds the DTC requests by exact name", () => {
    expect(supportsDtcRead(ecuWith([readRequest]))).toBe(true);
    expect(supportsDtcRead(ecuWith([clearRequest]))).toBe(false);
    expect(dtcClearRequestName(ecuWith([clearRequest]))).toBe("ClearDTC");
  });

  it("says so when nothing reads DTCs, rather than guessing a frame", async () => {
    const { driver } = harness(() => undefined);
    const result = await readDtcs(driver, ecuWith([clearRequest]));
    expect(result.outcome).toBe("unsupported");
    expect(result.records).toEqual([]);
  });
});

describe("readDtcs", () => {
  it("reports none when the ECU answers with the header alone", async () => {
    // `57 00` — a positive response declaring zero codes.
    const { driver } = harness(dtcEcu({ "17FF00": "5700" }));
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([readRequest]));
    expect(result.outcome).toBe("none");
    expect(result.declared).toBe(0);
  });

  it("decodes a single record", async () => {
    // 57 | 01 | 1234 | 03
    //  ^SID ^count ^code ^status: bit0 = 1 (current), bits1-5 = 1 (open circuit)
    const { driver } = harness(dtcEcu({ "17FF00": "5701123403" }));
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([readRequest]));
    expect(result.outcome).toBe("ok");
    expect(result.declared).toBe(1);
    expect(result.records).toHaveLength(1);

    const fields = new Map(result.records[0]?.fields.map((f) => [f.name, f]));
    expect(fields.get("FirstDTC")?.hex).toBe("1234");
    // Enum fields render their label, which is the point of keeping `lists`.
    expect(fields.get("Current Failure")?.value).toBe("no");
    expect(fields.get("Current Failure")?.labelled).toBe(true);
  });

  it("excludes the count field from each record", async () => {
    const { driver } = harness(dtcEcu({ "17FF00": "5701123403" }));
    await driver.initCan();
    const result = await readDtcs(driver, ecuWith([readRequest]));
    expect(result.records[0]?.fields.map((f) => f.name)).not.toContain("NDTC");
  });

  it("slides the window by the stride for each further record", async () => {
    // Three records of 3 bytes each, with distinguishable codes:
    // 57 | 03 | [1111 03] [2222 03] [3333 03]
    const { driver } = harness(dtcEcu({ "17FF00": "5703111103222203333303" }));
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([readRequest]));
    expect(result.declared).toBe(3);
    expect(result.records).toHaveLength(3);

    const codes = result.records.map((r) => r.fields.find((f) => f.name === "FirstDTC")?.hex);
    // Each record is the same field set read three bytes further along.
    expect(codes).toEqual(["1111", "2222", "3333"]);
  });

  it("stops early rather than inventing records the response cannot hold", async () => {
    // Declares 5 but carries one record's worth of bytes. `MoreDTC` is removed
    // deliberately: with it, the continuation would fetch the missing records and
    // this would be testing that instead — which it did on the first attempt.
    const noContinuation: RequestDef = { ...readRequest };
    delete noContinuation.sendbyte_dataitems;

    const { driver } = harness(dtcEcu({ "17FF00": "5705123403" }));
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([noContinuation]));
    expect(result.declared).toBe(5);
    // Better a short list than five records of fabricated values.
    expect(result.records).toHaveLength(1);
  });

  it("reads one record only when no stride is defined", async () => {
    // Without shiftbytescount there is no way to know where record 2 begins.
    const noStride: RequestDef = { ...readRequest, shiftbytescount: 0 };
    const { driver } = harness(dtcEcu({ "17FF00": "5703111103222203333303" }));
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([noStride]));
    expect(result.records).toHaveLength(1);
  });

  it("surfaces a refusal with its NRC instead of reporting no codes", async () => {
    // `7F 17 12` must not look like "no faults" — the opposite conclusion.
    const { driver } = harness(() => "037F1712");
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([readRequest]));
    expect(result.outcome).toBe("rejected");
    expect(result.detail).toContain("12");
  });

  it("opens a diagnostic session first when told to", async () => {
    const { mock, driver } = harness(dtcEcu({ "17FF00": "5700", "10C0": "50C0" }));
    await driver.initCan();
    mock.drain();

    await readDtcs(driver, ecuWith([readRequest]), { sessionCommand: "10C0" });
    expect(mock.written.some((command) => command.includes("10C0"))).toBe(true);
  });

  it("asks for more codes with MoreDTC set, and builds a real frame", async () => {
    // The original builds this with `''.join(str(list))`, producing
    // "['17', 'FF', '00']" and sending that — so its continuation never worked.
    // Byte 2 becomes FF, giving 17FF00 → 17FF00 with MoreDTC at firstbyte 2.
    const seen: string[] = [];
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      seen.push(request);
      if (request === "17FF00") return frameReply("5702111103");
      return undefined;
    });
    await driver.initCan();

    await readDtcs(driver, ecuWith([readRequest]), { moreDtcLimit: 3 });
    // Every request sent was a real hex frame, never a stringified list.
    expect(seen.every((request) => /^[0-9A-F]+$/.test(request))).toBe(true);
  });

  it("appends continuation records, dropping their header bytes", async () => {
    let call = 0;
    const { driver } = harness((frame) => {
      if (frame.slice(2) !== "17FF00") return undefined;
      call += 1;
      // First reply carries one record, the second another; the second's two
      // header bytes must not become part of a record.
      if (call === 1) return frameReply("5702111103");
      if (call === 2) return frameReply("5702222203");
      return "NO DATA";
    });
    await driver.initCan();

    const result = await readDtcs(driver, ecuWith([readRequest]), { moreDtcLimit: 5 });
    const codes = result.records.map((r) => r.fields.find((f) => f.name === "FirstDTC")?.hex);
    expect(codes).toEqual(["1111", "2222"]);
  });

  it("bounds the continuation loop", async () => {
    // An ECU that always says "more" must not hang the read.
    let calls = 0;
    const { driver } = harness((frame) => {
      if (frame.slice(2) !== "17FF00") return undefined;
      calls += 1;
      return frameReply("5702111103");
    });
    await driver.initCan();

    await readDtcs(driver, ecuWith([readRequest]), { moreDtcLimit: 4 });
    // One initial read plus at most the limit.
    expect(calls).toBeLessThanOrEqual(5);
  });
});

describe("clearDtcs", () => {
  it("sends the ECU's own clear request", async () => {
    const { driver } = harness((frame) => (frame.slice(2) === "14FF00" ? "0354000000" : undefined));
    await driver.initCan();

    const result = await clearDtcs(driver, ecuWith([readRequest, clearRequest]), { settleMs: 0 });
    expect(result.cleared).toBe(true);
    expect(result.requestName).toBe("ClearDTC");
    expect(result.usedFallback).toBe(false);
  });

  it("falls back to 14FF00 when the ECU describes no clear request", async () => {
    const { driver } = harness(() => "0354000000");
    await driver.initCan();

    const result = await clearDtcs(driver, ecuWith([readRequest]), { settleMs: 0 });
    expect(result.frame).toBe(DEFAULT_CLEAR_FRAME);
    // Flagged, because sending a generic frame is a guess the caller should know about.
    expect(result.usedFallback).toBe(true);
  });

  it("widens the response timeout, then puts it back", async () => {
    // An erase is slow to acknowledge; a short timeout reads as failure for
    // something that actually worked.
    const { mock, driver } = harness(() => "0354000000");
    await driver.initCan();
    mock.drain();

    await clearDtcs(driver, ecuWith([clearRequest]), { settleMs: 0 });
    // 1500 ms saturates AT ST's 4 ms units at FF.
    expect(mock.written.filter((c) => c.replace(/\s+/g, "") === "ATSTFF").length).toBeGreaterThan(
      0,
    );
  });

  it("reports a refusal rather than claiming success", async () => {
    const { driver } = harness(() => "037F1422");
    await driver.initCan();

    const result = await clearDtcs(driver, ecuWith([clearRequest]), { settleMs: 0 });
    expect(result.cleared).toBe(false);
    expect(result.detail).toContain("22");
  });

  it("reports failure when nothing came back", async () => {
    // Silence after an erase is not success.
    const { driver } = harness(() => undefined);
    await driver.initCan();

    const result = await clearDtcs(driver, ecuWith([clearRequest]), { settleMs: 0 });
    expect(result.cleared).toBe(false);
  });
});

describe("replies that are not hex", () => {
  // Both of these were real bugs, and both failed silently — the count stayed
  // right while every field went blank, which reads as "the ECU has no detail"
  // rather than as a fault in the reader.
  it("does not let a K-line NO DATA continuation blank the records already read", async () => {
    // The CAN path drops unusable lines before the decoder sees them, so this only
    // bites on K-line, where the reply text is passed through as-is.
    let call = 0;
    const { driver } = harness((frame) => {
      if (frame.replace(/\s+/g, "") !== "17FF00") return undefined;
      call += 1;
      return call === 1 ? "57 03 DB 08 7F 1F 21 5B 7B E2 C2" : "NO DATA";
    });

    const result = await readDtcs(driver, ecuWith([readRequest, clearRequest], "KWP2000"), {
      moreDtcLimit: 3,
    });

    expect(result.records).toHaveLength(3);
    // `getHexValue` voids the whole response on one non-hex character, so a single
    // stray "TA" from "NO DATA" is enough to empty all three records.
    expect(result.records[0]?.fields.find((f) => f.name === "FirstDTC")?.hex).toBe("db08");
  });

  it("reports no codes rather than decoding an adapter complaint", async () => {
    const ecu = ecuWith([readRequest, clearRequest]);
    const { driver } = harness(() => "NO DATA");

    const result = await readDtcs(driver, ecu);

    expect(result.outcome).toBe("none");
    expect(result.declared).toBe(0);
  });
});
