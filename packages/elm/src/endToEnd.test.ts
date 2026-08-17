/**
 * Driver → codec, with nothing stubbed in between.
 *
 * The unit tests above check the driver sends the right bytes; this checks the
 * bytes it gets back decode to the right *values* through the real
 * `@ddtx/codec`. That closes the loop the car session would otherwise have to
 * close: a mistake in ISO-TP reassembly or in the `firstbyte` convention shows up
 * here as a wrong number rather than as a puzzling reading in a van.
 *
 * `firstbyte` being 1-based *including* the response SID is the specific thing
 * worth pinning: it is the easiest convention in the whole port to get wrong by
 * one, and it is invisible until a value is off.
 */

import { describe, expect, it } from "vitest";
import { decodeStream, resolveDataDictionary, type BoundRequest } from "@ddtx/codec";
import type { DataDef, RequestDef } from "@ddtx/core";
import { ElmDriver } from "./driver.js";
import { MockElm, respondWithPayload } from "./mock.js";

const data: Record<string, DataDef> = {
  // 0.125 rpm per bit at byte 2 — the classic Renault engine-speed scaling.
  "Régime moteur": { scaled: true, bitscount: 16, bytescount: 2, step: 0.125, unit: "rpm" },
  // Offset −40 °C at byte 4.
  "Température eau": {
    scaled: true,
    bitscount: 8,
    bytescount: 1,
    step: 1,
    offset: -40,
    unit: "°C",
  },
  "Etat relais": { bitscount: 8, bytescount: 1, lists: { "0": "OFF", "1": "ON" } },
  VIN: { bitscount: 136, bytescount: 17, byte: true, bytesascii: true },
};

function bind(def: RequestDef): BoundRequest {
  return { def, endianness: "Big", data: resolveDataDictionary(data) };
}

const liveFrame = bind({
  name: "Trame 10",
  deny_sds: [],
  sentbytes: "2110",
  receivebyte_dataitems: {
    // Byte 1 is the 0x61 response SID, so the first real field is byte 2.
    "Régime moteur": { firstbyte: 2 },
    "Température eau": { firstbyte: 4 },
    "Etat relais": { firstbyte: 5 },
  },
});

const vinRequest = bind({
  name: "Read VIN",
  deny_sds: [],
  sentbytes: "2181",
  receivebyte_dataitems: { VIN: { firstbyte: 2 } },
});

async function driverFor(payloads: Record<string, string>): Promise<ElmDriver> {
  const mock = new MockElm({ onFrame: respondWithPayload(payloads) });
  const driver = new ElmDriver(mock, { sleep: () => Promise.resolve() });
  await driver.initCan();
  await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });
  return driver;
}

describe("driver to codec", () => {
  it("decodes a single-frame response to real values", async () => {
    // 61 | 0BB8 | 78 | 01  →  0x0BB8 × 0.125 = 375 rpm, 0x78 − 40 = 80 °C, relay ON
    const driver = await driverFor({ "2110": "610BB87801" });
    const values = decodeStream(liveFrame, await driver.request("2110"));

    expect(values["Régime moteur"]).toBe("375");
    expect(values["Température eau"]).toBe("80");
    expect(values["Etat relais"]).toBe("ON");
  });

  it("decodes an ASCII field out of a multi-frame response", async () => {
    // A 17-character VIN needs 18 bytes with the SID, so three CAN frames.
    const vin = "VF1MA000512345678";
    const hex = [...vin].map((c) => c.charCodeAt(0).toString(16).toUpperCase()).join("");
    const driver = await driverFor({ "2181": `61${hex}` });

    const values = decodeStream(vinRequest, await driver.request("2181"));
    expect(values.VIN).toBe(vin);
  });

  it("reports no value when the response is too short for a field", async () => {
    // Only 3 bytes back, so the fields at bytes 4 and 5 are not there.
    const driver = await driverFor({ "2110": "610BB8" });
    const values = decodeStream(liveFrame, await driver.request("2110"));

    expect(values["Régime moteur"]).toBe("375");
    expect(values["Température eau"]).toBeNull();
    expect(values["Etat relais"]).toBeNull();
  });

  it("does not decode a negative response as though it were data", async () => {
    // 7F 21 11 would otherwise read as a plausible rpm value.
    const mock = new MockElm({ onFrame: () => "037F2111" });
    const driver = new ElmDriver(mock, { sleep: () => Promise.resolve() });
    await driver.initCan();

    const reply = await driver.request("2110");
    expect(reply).toBe("7F 21 11");
    // The caller checks for 7F before decoding — `send_request` does the same.
    expect(reply.startsWith("7F")).toBe(true);
  });

  it("survives broadcast traffic interleaved with the answer", async () => {
    // Some ECUs transmit continuously on their own id; the right frame is found
    // by its positive-response SID rather than by position.
    const mock = new MockElm({
      onFrame: () => ["08AABBCCDDEEFF00", "05610BB87801", "0812345678000000"],
    });
    const driver = new ElmDriver(mock, { sleep: () => Promise.resolve() });
    await driver.initCan();

    const values = decodeStream(liveFrame, await driver.request("2110"));
    expect(values["Régime moteur"]).toBe("375");
    expect(values["Etat relais"]).toBe("ON");
  });
});
