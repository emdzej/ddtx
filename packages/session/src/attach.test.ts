import { describe, expect, it } from "vitest";
import { resolveDataDictionary, type BoundRequest } from "@ddtx/codec";
import type { ObdConfig } from "@ddtx/core";
import type { LoadedEcu } from "@ddtx/db";
import { ElmDriver, MockElm } from "@ddtx/elm";
import { attachEcu, describeAttachment, isReachable, UnsupportedProtocolError } from "./attach.js";

/**
 * `protocol` is widened to `string` deliberately: the real index contains `DOIP`
 * and one entry with `""`, and the point of these tests is that those are handled
 * rather than assumed away by the type.
 */
function ecuWith(obd: Omit<Partial<ObdConfig>, "protocol"> & { protocol: string }): LoadedEcu {
  const data = resolveDataDictionary({});
  return {
    slug: "test",
    def: {
      ecuname: "Test ECU",
      obd: { funcaddr: "7A", funcname: "Test", ...obd } as ObdConfig,
      autoidents: [],
      requests: [],
      data: {},
      devices: [],
    },
    endianness: "Big",
    data,
    requests: new Map<string, BoundRequest>(),
  };
}

function harness() {
  const mock = new MockElm();
  return { mock, driver: new ElmDriver(mock, { sleep: () => Promise.resolve() }) };
}

describe("attachEcu", () => {
  it("configures CAN from the ECU's own ids and baud rate", async () => {
    const { mock, driver } = harness();
    const result = await attachEcu(
      driver,
      ecuWith({ protocol: "CAN", send_id: "7E0", recv_id: "7E8", baudrate: 250000 }),
    );

    expect(result).toEqual({ protocol: "CAN", idTx: "7E0", idRx: "7E8" });
    expect(mock.written).toContain("AT SH 7E0");
    expect(mock.written).toContain("AT CRA 7E8");
    // 250 kbit/s on an 11-bit id is protocol 8.
    expect(mock.written).toContain("AT SP 8");
  });

  it("falls back to the OBD-II ids when the ECU names none", async () => {
    const { mock, driver } = harness();
    await attachEcu(driver, ecuWith({ protocol: "CAN" }));
    expect(mock.written).toContain("AT SH 7E0");
  });

  it("uses slow init for KWP2000 unless the ECU asks for fast init", async () => {
    // The database marks fast init explicitly; its absence means slow init, and
    // getting this backwards is silent — the ECU simply never answers.
    const slow = harness();
    await attachEcu(slow.driver, ecuWith({ protocol: "KWP2000", funcaddr: "7A" }));
    expect(slow.mock.written).toContain("AT SP 4");
    expect(slow.mock.written).toContain("AT SI");

    const fast = harness();
    await attachEcu(fast.driver, ecuWith({ protocol: "KWP2000", funcaddr: "7A", fastinit: true }));
    expect(fast.mock.written).toContain("AT SP 5");
    expect(fast.mock.written).toContain("AT FI");
    expect(fast.mock.written).not.toContain("AT SI");
  });

  it("treats fastinit: false as slow init, not as absent", async () => {
    const { mock, driver } = harness();
    await attachEcu(driver, ecuWith({ protocol: "KWP2000", fastinit: false }));
    expect(mock.written).toContain("AT SI");
  });

  it("uses protocol 3 and slow init for ISO8", async () => {
    const { mock, driver } = harness();
    const result = await attachEcu(driver, ecuWith({ protocol: "ISO8", funcaddr: "7A" }));
    expect(result.protocol).toBe("ISO8");
    expect(mock.written).toContain("AT SP 3");
  });

  it("refuses a protocol no transport here can reach", async () => {
    // DoIP needs raw TCP, which a browser cannot open at all.
    const { driver } = harness();
    await expect(attachEcu(driver, ecuWith({ protocol: "DOIP" }))).rejects.toThrow(
      UnsupportedProtocolError,
    );
  });

  it("says so before anything is attempted", () => {
    expect(isReachable(ecuWith({ protocol: "CAN" }))).toBe(true);
    expect(isReachable(ecuWith({ protocol: "KWP2000" }))).toBe(true);
    expect(isReachable(ecuWith({ protocol: "ISO8" }))).toBe(true);
    expect(isReachable(ecuWith({ protocol: "DOIP" }))).toBe(false);
    expect(isReachable(ecuWith({ protocol: "" }))).toBe(false);
  });
});

describe("describeAttachment", () => {
  it("names the CAN ids", () => {
    expect(describeAttachment({ protocol: "CAN", idTx: "7E0", idRx: "7E8" })).toBe(
      "CAN — tx 7E0 / rx 7E8",
    );
  });

  it("flags a K-line init that did not confirm", () => {
    // Worth surfacing: the adapter accepted the command but the ECU never
    // acknowledged, which usually means the wrong init mode.
    expect(
      describeAttachment({ protocol: "KWP2000", address: "7A", initialised: false }),
    ).toContain("init did not confirm");
    expect(describeAttachment({ protocol: "KWP2000", address: "7A", initialised: true })).toBe(
      "KWP2000 — address 7A",
    );
  });
});
