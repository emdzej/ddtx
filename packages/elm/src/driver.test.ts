import { describe, expect, it } from "vitest";
import {
  ElmDriver,
  extractVersion,
  parseStn,
  stnFirmwareAtLeast,
  uartBufferFor,
} from "./driver.js";
import { ElmLink } from "./link.js";
import { MockElm, respondWithPayload, type MockElmOptions } from "./mock.js";

const noSleep = () => Promise.resolve();

/** A driver over a mock adapter, with timing removed. */
function harness(mockOptions: MockElmOptions = {}) {
  const mock = new MockElm(mockOptions);
  const driver = new ElmDriver(mock, { sleep: noSleep, now: () => 0 });
  return { mock, driver };
}

describe("adapter identification", () => {
  it("reads the version off a plain ELM327 clone", async () => {
    const { driver } = harness({ version: "ELM327 v1.5" });
    const info = await driver.identify();

    expect(info.version).toBe("ELM327 v1.5");
    expect(info.isStn).toBe(false);
    expect(info.supportsStpx).toBe(false);
  });

  it("detects an STN part and enables STPX", async () => {
    const { driver } = harness({ version: "ELM327 v1.4", stnVersion: "STN1170 v4.3.1" });
    const info = await driver.identify();

    expect(info.isStn).toBe(true);
    expect(info.supportsStpx).toBe(true);
    expect(driver.canStrategy).toBe("stpx");
  });

  it("refuses STPX on firmware older than 4.2.0", async () => {
    // Earlier STN parts accept the command but mis-handle it, so the version
    // gate is what keeps us off that path.
    const { driver } = harness({ stnVersion: "STN1110 v4.0.1" });
    const info = await driver.identify();

    expect(info.isStn).toBe(true);
    expect(info.supportsStpx).toBe(false);
    expect(driver.canStrategy).toBe("manual");
  });

  it("honours a forced strategy over what the adapter can do", async () => {
    const mock = new MockElm({ stnVersion: "STN2120 v5.0.0" });
    const driver = new ElmDriver(mock, { sleep: noSleep, strategy: "manual" });
    await driver.identify();
    expect(driver.canStrategy).toBe("manual");
  });

  it("sizes the UART buffer from the part number", () => {
    expect(uartBufferFor(undefined)).toBe(0x100);
    expect(uartBufferFor("STN1170 v4.3.1")).toBe(0x1ff);
    expect(uartBufferFor("STN2120 v5.0.0")).toBe(0x3ff);
  });
});

describe("version parsing", () => {
  it("ignores the echo and the prompt", () => {
    expect(extractVersion("ATZ\nELM327 v1.5\n>")).toBe("ELM327 v1.5");
  });

  it("returns nothing when there is no version line", () => {
    expect(extractVersion("ATZ\n?\n>")).toBeUndefined();
  });

  it("treats ? as not-an-STN", () => {
    expect(parseStn("STI\n?\n>")).toBeUndefined();
    expect(parseStn("STI\nSTN1170 v4.3.1\n>")).toBe("STN1170 v4.3.1");
  });

  it("compares firmware versions component-wise", () => {
    expect(stnFirmwareAtLeast("STN1110 v4.2.0", 4, 2, 0)).toBe(true);
    expect(stnFirmwareAtLeast("STN1110 v4.1.9", 4, 2, 0)).toBe(false);
    expect(stnFirmwareAtLeast("STN1110 v5.0.0", 4, 2, 0)).toBe(true);
    expect(stnFirmwareAtLeast("STN1110 v4.2", 4, 2, 0)).toBe(false);
    expect(stnFirmwareAtLeast(undefined, 4, 2, 0)).toBe(false);
  });
});

describe("CAN setup", () => {
  it("turns off automatic formatting, spaces and short messages", async () => {
    // All three are load-bearing: CAF0 because this driver adds the ISO-TP
    // prefixes itself, S0 so echo cancellation matches, AL for long replies.
    const { mock, driver } = harness();
    await driver.initCan();

    expect(mock.written).toContain("AT CAF0");
    expect(mock.written).toContain("AT S0");
    expect(mock.written).toContain("AT AL");
  });

  it("lets the adapter do flow control unless told otherwise", async () => {
    const { mock, driver } = harness();
    await driver.initCan();
    expect(mock.written).toContain("AT CFC1");
    expect(mock.written).not.toContain("AT CFC0");
  });

  it("hands flow control to us when the cfc0 strategy is forced", async () => {
    // Without identify() first — a forced strategy has to apply from construction,
    // since initCan is exactly the caller that would otherwise miss it.
    const mock = new MockElm();
    const driver = new ElmDriver(mock, { sleep: noSleep, strategy: "cfc0" });
    await driver.initCan();
    expect(mock.written).toContain("AT CFC0");
    expect(mock.written).not.toContain("AT CFC1");
  });

  it("sets an 11-bit header and 500 kbit/s by default", async () => {
    const { mock, driver } = harness();
    await driver.initCan();
    mock.drain();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });

    expect(mock.written).toContain("AT SH 7E0");
    expect(mock.written).toContain("AT SP 6");
    expect(mock.written).toContain("AT CRA 7E8");
  });

  it("splits a 29-bit id into priority and header", async () => {
    const { mock, driver } = harness();
    await driver.initCan();
    mock.drain();
    await driver.setCanAddress({ idTx: "18DA01F1", idRx: "18DAF101", ecuname: "Test" });

    expect(mock.written).toContain("AT CP 18");
    expect(mock.written).toContain("AT SH DA01F1");
    // 29-bit uses protocol 7 rather than 6.
    expect(mock.written).toContain("AT SP 7");
  });

  it("selects the 250 kbit/s protocol when the ECU says so", async () => {
    const { mock, driver } = harness();
    await driver.initCan();
    mock.drain();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "T", baudrate: 250000 });
    expect(mock.written).toContain("AT SP 8");
  });

  it("re-applies CAF0, S0 and AL after the protocol change", async () => {
    // Several clones reset them on AT SP, and sendCan depends on all three.
    const { mock, driver } = harness();
    await driver.initCan();
    mock.drain();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });

    const afterSp = mock.written.slice(mock.written.indexOf("AT SP 6"));
    expect(afterSp).toContain("AT CAF0");
    expect(afterSp).toContain("AT S0");
    expect(afterSp).toContain("AT AL");
  });

  it("does not reconfigure for the ECU it is already addressing", async () => {
    const { mock, driver } = harness();
    await driver.initCan();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });
    mock.drain();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });
    expect(mock.written).toEqual([]);
  });
});

describe("requests over CAN", () => {
  async function canDriver(payloads: Record<string, string>) {
    const mock = new MockElm({ onFrame: respondWithPayload(payloads) });
    const driver = new ElmDriver(mock, { sleep: noSleep, now: () => 0 });
    await driver.initCan();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "Test" });
    mock.drain();
    return { mock, driver };
  }

  it("frames a request, cancels the echo, and returns the payload", async () => {
    const { mock, driver } = await canDriver({ "2110": "6100123456" });
    expect(await driver.request("2110")).toBe("61 00 12 34 56");
    // One frame written, prefixed with its length.
    expect(mock.written).toEqual(["022110"]);
  });

  it("reassembles a multi-frame response", async () => {
    const payload = "61" + "AA".repeat(19); // 20 bytes: three frames
    const { driver } = await canDriver({ "2110": payload });
    const value = await driver.request("2110");
    expect(value.replace(/ /g, "")).toBe(payload);
  });

  it("returns a negative response for the caller to read", async () => {
    const mock = new MockElm({ onFrame: () => "037F2111" });
    const driver = new ElmDriver(mock, { sleep: noSleep });
    await driver.initCan();
    expect(await driver.request("2110")).toBe("7F 21 11");
  });

  it("says WRONG RESPONSE rather than inventing a payload", async () => {
    // A first frame with nothing behind it: AT CAF0 was reset, or FC failed.
    const mock = new MockElm({ onFrame: () => "100A610011223344" });
    const driver = new ElmDriver(mock, { sleep: noSleep });
    await driver.initCan();
    expect(await driver.request("2110")).toBe("WRONG RESPONSE");
    expect(driver.errors.frame).toBe(1);
  });

  it("rejects a malformed request without touching the bus", async () => {
    const { mock, driver } = await canDriver({});
    expect(await driver.request("211")).toBe("ODD ERROR");
    expect(await driver.request("21ZZ")).toBe("HEX ERROR");
    expect(mock.written).toEqual([]);
  });

  it("serves a repeated request from the cache until it is cleared", async () => {
    const { mock, driver } = await canDriver({ "2110": "6100123456" });
    await driver.request("2110");
    await driver.request("2110");
    expect(mock.written).toEqual(["022110"]);

    driver.clearCache();
    await driver.request("2110");
    expect(mock.written).toEqual(["022110", "022110"]);
  });

  it("skips the cache when asked", async () => {
    const { mock, driver } = await canDriver({ "2110": "6100123456" });
    await driver.request("2110", { cache: false });
    await driver.request("2110", { cache: false });
    expect(mock.written).toHaveLength(2);
  });

  it("re-sends the session command after a silence", async () => {
    // An ECU drops back to the default session on its own, and the next request
    // would then be refused for no visible reason.
    let clock = 0;
    const mock = new MockElm({ onFrame: respondWithPayload({ "2110": "610012" }) });
    const driver = new ElmDriver(mock, { sleep: noSleep, now: () => clock, keepAliveMs: 4000 });
    await driver.initCan();
    await driver.startCanSession("10C0");
    mock.drain();

    clock = 10_000; // longer than the keepalive
    await driver.request("2110", { cache: false });
    expect(mock.written[0]).toBe("10C0");
  });

  it("counts adapter errors as they go past", async () => {
    const mock = new MockElm({ onFrame: () => "CAN ERROR" });
    const driver = new ElmDriver(mock, { sleep: noSleep });
    await driver.initCan();
    await driver.request("2110");
    expect(driver.errors.can).toBe(1);
  });
});

describe("K-line setup", () => {
  it("switches the adapter to spaced, line-terminated output", async () => {
    // The opposite of the CAN path: on K-line the reply is read as text.
    const { mock, driver } = harness();
    await driver.initIso();
    expect(mock.written).toContain("AT S1");
    expect(mock.written).toContain("AT L1");
    expect(mock.written).toContain("AT D1");
  });

  it("addresses a KWP2000 ECU with fast init by default", async () => {
    const { mock, driver } = harness();
    await driver.initIso();
    mock.drain();
    await driver.setIsoAddress("7A");

    expect(mock.written).toContain("AT SH 81 7A F1");
    expect(mock.written).toContain("AT WM 81 7A F1 3E");
    expect(mock.written).toContain("AT SP 5");
    expect(mock.written).toContain("AT FI");
    expect(mock.written).toContain("81");
  });

  it("tries slow init first when the ECU wants it", async () => {
    const { mock, driver } = harness();
    await driver.initIso();
    mock.drain();
    await driver.setIsoAddress("7A", { slowInit: true });

    // Slow init answers OK in the mock, so fast init is never attempted.
    expect(mock.written).toContain("AT SP 4");
    expect(mock.written).toContain("AT SI");
    expect(mock.written).not.toContain("AT FI");
  });

  it("uses protocol 3 and slow init for ISO8", async () => {
    const { mock, driver } = harness();
    await driver.initIso();
    mock.drain();
    await driver.setIso8Address("7A");
    expect(mock.written).toContain("AT SP 3");
    expect(mock.written).toContain("AT SI");
  });

  it("joins K-line reply lines and drops the echo", async () => {
    const mock = new MockElm({ onFrame: () => "61 00 12\n34 56" });
    const driver = new ElmDriver(mock, { sleep: noSleep });
    await driver.initIso();
    expect(await driver.request("2110")).toBe("61 00 12 34 56");
  });
});

describe("ElmLink", () => {
  it("presents the driver as an EcuLink, ignoring the hint", async () => {
    const mock = new MockElm({ onFrame: respondWithPayload({ "2110": "6100123456" }) });
    const driver = new ElmDriver(mock, { sleep: noSleep });
    await driver.initCan();
    const link = new ElmLink(driver);

    expect(link.kind).toBe("elm");
    expect(await link.request("2110", { requestName: "ignored" })).toBe("61 00 12 34 56");
  });
});

describe("MockElm settings capture", () => {
  it("records a spaced command under the same key as an unspaced one", async () => {
    // An ELM327 treats `ATSH745` and `AT SH 745` identically, and the driver sends
    // the spaced form — so a test asserting on configuration needs both to land in
    // one place.
    const mock = new MockElm();
    await mock.write("AT SH 745\r");
    await mock.write("ATCRA765\r");
    expect(mock.settings.get("ATSH")).toBe("745");
    expect(mock.settings.get("ATCRA")).toBe("765");
  });

  it("records a flag command with no argument", async () => {
    const mock = new MockElm();
    await mock.write("AT CAF0\r");
    expect(mock.settings.has("ATCAF")).toBe(true);
    expect(mock.settings.get("ATCAF")).toBe("0");
  });
});
