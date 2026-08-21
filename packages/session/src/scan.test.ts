import { describe, expect, it } from "vitest";
import type { DbTreeIndex, IndexAutoIdent, IndexEntry } from "@ddtx/core";
import { ElmDriver, MockElm, type FrameHandler } from "@ddtx/elm";
import {
  addressesToProbe,
  identifyByLocalId,
  identifyByUds,
  parseIdentityBlock,
  probeAddress,
  probeKlineAddress,
  scanAll,
  scanCan,
  scanKline,
} from "./scan.js";

/** `"CAP"` → `"434150"`, so a fixture reads like the string it represents. */
function ascii(text: string, padToBytes = 0): string {
  let hex = [...text]
    .map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
    .join("");
  // Real ECUs pad with spaces; the reader has to strip them.
  while (hex.length / 2 < padToBytes) hex += "20";
  return hex;
}

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    protocol: "CAN",
    ecuname: "Test ECU",
    address: "26",
    group: "Habitacle",
    projects: ["x70"],
    autoidents: [],
    ...overrides,
  };
}

function ident(
  diagnostic_version: string,
  supplier_code: string,
  soft_version: string,
  version: string,
): IndexAutoIdent {
  return { diagnostic_version, supplier_code, soft_version, version };
}

function indexOf(ecus: Record<string, IndexEntry>): DbTreeIndex {
  return { format: 1, ecus, groups: [], projects: [], protocols: [] };
}

/**
 * A mock that answers the UDS identification sequence for one address.
 *
 * Frames arrive already framed by the driver, so the handler is wrapped to see
 * whole requests.
 */
function udsEcu(identity: {
  /**
   * The **raw hex byte** the ECU reports, e.g. `"16"`.
   *
   * Named `diagByte` rather than `diagversion` on purpose: the identity the scanner
   * returns holds the *decimal* value of this byte, so `"16"` here becomes `"22"`
   * there. Conflating the two is the mistake this naming exists to prevent — and it
   * caught me writing these very tests.
   */
  diagByte: string;
  supplier: string;
  soft: string;
  version: string;
}): FrameHandler {
  return (frame) => {
    const request = frame.slice(2); // drop the ISO-TP length byte
    switch (request) {
      case "1003":
        return "035003000000000000";
      case "1001":
        return "035001000000000000";
      case "22F1A0":
        return frameReply(`62F1A0${identity.diagByte}`);
      case "22F18A":
        return frameReply(`62F18A${ascii(identity.supplier, 20)}`);
      case "22F194":
        return frameReply(`62F194${ascii(identity.soft, 16)}`);
      case "22F195":
        return frameReply(`62F195${ascii(identity.version, 16)}`);
      default:
        return undefined; // NO DATA
    }
  };
}

/** ISO-TP frame a payload, single or multi as needed. */
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

function harness(onFrame: FrameHandler) {
  const mock = new MockElm({ onFrame });
  return { mock, driver: new ElmDriver(mock, { sleep: () => Promise.resolve() }) };
}

describe("addressesToProbe", () => {
  it("takes only the CAN addresses a vehicle uses", () => {
    const index = indexOf({
      a: entry({ address: "26", projects: ["x70"] }),
      b: entry({ address: "7A", projects: ["x84"] }),
      c: entry({ address: "01", projects: ["x70", "x84"] }),
    });
    expect(addressesToProbe(index, "can", "x70")).toEqual(["01", "26"]);
  });

  it("skips the bus pseudo-addresses", () => {
    // `00` is the primary bus and `FF` the secondary; neither is an ECU, and the
    // original skips both as "NON ISO-TP".
    const index = indexOf({
      bus: entry({ address: "00" }),
      bus2: entry({ address: "FF" }),
      real: entry({ address: "26" }),
    });
    expect(addressesToProbe(index, "can", "x70")).toEqual(["26"]);
  });

  it("separates the two buses, since a CAN sweep cannot reach a K-line ECU", () => {
    // Master II is 15 K-line ECUs to 2 on CAN, so getting this split wrong would
    // miss almost the whole vehicle.
    const index = indexOf({
      can: entry({ address: "26" }),
      kline: entry({ address: "7A", protocol: "KWP2000" }),
      iso8: entry({ address: "51", protocol: "ISO8" }),
    });
    expect(addressesToProbe(index, "can", "x70")).toEqual(["26"]);
    // ISO8 is reached the same way as KWP2000, so it belongs to the K-line sweep.
    expect(addressesToProbe(index, "kline", "x70")).toEqual(["51", "7A"]);
  });

  it("matches the project code case-insensitively", () => {
    // The index spells them `x70`; a caller may well pass `X70`.
    const index = indexOf({ a: entry({ address: "26", projects: ["x70"] }) });
    expect(addressesToProbe(index, "can", "X70")).toEqual(["26"]);
  });

  it("covers every mapped address when no vehicle is given", () => {
    const all = addressesToProbe(indexOf({}), "can");
    expect(all.length).toBeGreaterThan(200);
    expect(all).not.toContain("00");
    expect(all).not.toContain("FF");
  });
});

describe("identifyByUds", () => {
  it("reads the four identifiers and strips the padding", async () => {
    const { driver } = harness(
      udsEcu({ diagByte: "16", supplier: "CAP", soft: "1426", version: "1000" }),
    );
    await driver.initCan();

    expect(await identifyByUds(driver)).toEqual({
      // 0x16 is 22 — the decimal form the index stores.
      diagversion: "22",
      supplier: "CAP",
      soft: "1426",
      version: "1000",
    });
  });

  it("gives up when the session is refused", async () => {
    // An older ECU declines 1003 outright, which is the cheap signal to fall back.
    const { driver } = harness((frame) => (frame.slice(2) === "1003" ? "037F1011" : undefined));
    await driver.initCan();
    expect(await identifyByUds(driver)).toBeNull();
  });

  it("gives up rather than return a half-read identity", async () => {
    // A partial identity would match the wrong catalogue entry, which is worse
    // than no match at all.
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      if (request === "1003") return "035003000000000000";
      if (request === "22F1A0") return frameReply("62F1A016");
      return undefined; // supplier and the rest never answer
    });
    await driver.initCan();
    expect(await identifyByUds(driver)).toBeNull();
  });

  it("returns the ECU to the default session either way", async () => {
    // An ECU left in a diagnostic session keeps broadcasting and corrupts the
    // next address's probe.
    const { mock, driver } = harness(
      udsEcu({ diagByte: "16", supplier: "CAP", soft: "1426", version: "1000" }),
    );
    await driver.initCan();
    mock.drain();
    await identifyByUds(driver);
    expect(mock.written.some((command) => command.includes("1001"))).toBe(true);
  });

  it("closes the session even when identification failed part-way", async () => {
    const { mock, driver } = harness((frame) =>
      frame.slice(2) === "1003" ? "035003000000000000" : undefined,
    );
    await driver.initCan();
    mock.drain();
    await identifyByUds(driver);
    expect(mock.written.some((command) => command.includes("1001"))).toBe(true);
  });
});

describe("identifyByLocalId", () => {
  it("slices all four fields out of one 2180 reply", async () => {
    // 61 80 | 16 | supplier ... with the fields at fixed offsets. 0x16 → "22".
    const payload = `618016${ascii("001")}00EA8000`;
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      if (request === "10C0") return "0350C0000000000000";
      if (request === "1081") return "035081000000000000";
      if (request === "2180") return frameReply(payload);
      return undefined;
    });
    await driver.initCan();

    const identity = await identifyByLocalId(driver);
    expect(identity?.diagversion).toBe("22");
    // The short form takes three bytes for soft and version, not two — that is
    // check_ecu's own slicing, and it is why matching is prefix-based: an index
    // entry holding "00EA" still matches a reported "00EA80".
    expect(identity?.soft).toBe("00EA80");
    expect(identity?.version).toBe("00");
  });

  it("still matches an index entry whose soft is a prefix of what was reported", async () => {
    // The consequence of the above, and the reason checkWith compares prefixes
    // rather than whole strings.
    const payload = `618016${ascii("001")}00EA8000`;
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      if (request === "10C0") return "0350C0000000000000";
      if (request === "1081") return "035081000000000000";
      if (request === "2180") return frameReply(payload);
      return undefined;
    });
    await driver.initCan();

    const index = indexOf({
      hit: entry({
        address: "26",
        ecuname: "Prefix ECU",
        autoidents: [ident("22", "001", "00EA", "00")],
      }),
    });
    const result = await probeAddress(driver, index, "26");
    expect(result.outcome).toBe("identified");
    expect(result.matches[0]?.ecuname).toBe("Prefix ECU");
  });

  it("gives up on a reply that is not a 6180 identity block", async () => {
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      if (request === "10C0") return "0350C0000000000000";
      if (request === "2180") return frameReply("7F2180");
      return undefined;
    });
    await driver.initCan();
    expect(await identifyByLocalId(driver)).toBeNull();
  });
});

describe("probeAddress", () => {
  const index = indexOf({
    bcm: entry({
      address: "26",
      ecuname: "UCH X83",
      // Decimal, as the real index stores it: 0x16 reported is "22" here.
      autoidents: [ident("22", "CAP", "1426", "1000")],
    }),
  });

  it("matches a reported identity to the catalogue", async () => {
    const { driver } = harness(
      udsEcu({ diagByte: "16", supplier: "CAP", soft: "1426", version: "1000" }),
    );
    await driver.initCan();

    const result = await probeAddress(driver, index, "26");
    expect(result.outcome).toBe("identified");
    expect(result.via).toBe("uds");
    expect(result.matches[0]?.ecuname).toBe("UCH X83");
    // The canonical name comes from the addressing table, not the index's group.
    expect(result.name).toBe("Body Control Module");
  });

  it("reports an ECU that answers but is not in the catalogue", async () => {
    const { driver } = harness(
      udsEcu({ diagByte: "99", supplier: "NOPE", soft: "0000", version: "0000" }),
    );
    await driver.initCan();

    const result = await probeAddress(driver, index, "26");
    expect(result.outcome).toBe("unknown-ecu");
    // Still worth surfacing: something is fitted, we just cannot name it.
    expect(result.identity?.supplier).toBe("NOPE");
  });

  it("reports silence for an address with nothing fitted", async () => {
    const { driver } = harness(() => undefined);
    await driver.initCan();
    expect((await probeAddress(driver, index, "26")).outcome).toBe("silent");
  });

  it("refuses an address with no CAN mapping instead of guessing one", async () => {
    const { mock, driver } = harness(() => undefined);
    await driver.initCan();
    mock.drain();

    const result = await probeAddress(driver, index, "ZZ");
    expect(result.outcome).toBe("unmapped");
    // Nothing was put on the bus for it.
    expect(mock.written).toEqual([]);
  });

  it("falls back to the local-id method when UDS is refused", async () => {
    const payload = `618016${ascii("001")}00EA8000`;
    const { driver } = harness((frame) => {
      const request = frame.slice(2);
      if (request === "1003") return "037F1011"; // UDS declined
      if (request === "10C0") return "0350C0000000000000";
      if (request === "2180") return frameReply(payload);
      if (request === "1081") return "035081000000000000";
      return undefined;
    });
    await driver.initCan();

    const result = await probeAddress(driver, index, "26");
    expect(result.via).toBe("local-id");
    expect(result.identity?.diagversion).toBe("22");
  });
});

describe("scanCan", () => {
  const index = indexOf({
    bcm: entry({
      address: "26",
      ecuname: "UCH X83",
      projects: ["x70"],
      autoidents: [ident("16", "CAP", "1426", "1000")],
    }),
    abs: entry({ address: "01", ecuname: "ABS", projects: ["x70"], autoidents: [] }),
  });

  it("sweeps a vehicle's addresses and reports what answered", async () => {
    // Only 26 answers; 01 is silent, as an unfitted address would be.
    const { driver } = harness((frame, mock) => {
      const answering = mock.settings.get("ATSH") === "745";
      if (!answering) return undefined;
      return udsEcu({ diagByte: "16", supplier: "CAP", soft: "1426", version: "1000" })(
        frame,
        mock,
      );
    });

    const report = await scanCan(driver, index, { project: "x70" });
    expect(report.addressesProbed).toBe(2);
    expect(report.found).toHaveLength(1);
    expect(report.found[0]?.address).toBe("26");
    expect(report.results.find((r) => r.address === "01")?.outcome).toBe("silent");
    expect(report.cancelled).toBe(false);
  });

  it("initialises CAN once, not per address", async () => {
    // The per-address cost has to be the probe, not a protocol setup, or a
    // 223-address sweep would be unusable.
    const { mock, driver } = harness(() => undefined);
    await scanCan(driver, index, { project: "x70" });
    expect(mock.written.filter((command) => command === "AT CAF0").length).toBeLessThan(4);
  });

  it("reports progress for every address", async () => {
    const { driver } = harness(() => undefined);
    const seen: number[] = [];
    await scanCan(driver, index, {
      project: "x70",
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it("stops when cancelled, and still closes the protocol", async () => {
    const { mock, driver } = harness(() => undefined);
    const signal = { aborted: false };
    const report = await scanCan(driver, index, {
      project: "x70",
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });

    expect(report.cancelled).toBe(true);
    expect(report.addressesProbed).toBe(1);
    expect(mock.written.some((command) => command.includes("ATPC"))).toBe(true);
  });
});

describe("parseIdentityBlock", () => {
  it("reads the long form, with the diagnostic version in decimal", () => {
    // A real KWP reply the original carries as test data. Byte 7 is 0x04, so the
    // diagnostic version is "4" — decimal, matching the index, not hex.
    const reply = "61 80 77 00 31 38 31 04 41 42 45 E3 17 03 00 38 00 07 00 00 00 00 09 11 12 00";
    expect(parseIdentityBlock(reply)).toEqual({
      diagversion: "4",
      supplier: "ABE",
      soft: "0007",
      version: "0000",
    });
  });

  it("reads another long-form reply from the original's fixtures", () => {
    const reply = "61 80 82 00 23 66 18 14 30 33 37 82 00 08 53 86 00 CB A4 00 70 06 3C 02 B1 A4";
    const identity = parseIdentityBlock(reply);
    // Byte 7 is 0x14 = 20 decimal.
    expect(identity?.diagversion).toBe("20");
    expect(identity?.supplier).toBe("037");
  });

  it("converts a version byte above 0x99, which decimal makes unambiguous", () => {
    // 0xC1 is 193 — a value the index does hold, and which no hex byte spells
    // without letters. This is the check that proves the index is decimal.
    const reply = `61 80 77 00 31 38 31 C1 41 42 45 E3 17 03 00 38 00 07 00 00 00 00 09 11 12 00`;
    expect(parseIdentityBlock(reply)?.diagversion).toBe("193");
  });

  it("returns nothing for a reply too short to hold an identity", () => {
    expect(parseIdentityBlock("61 80 04")).toBeNull();
    expect(parseIdentityBlock("")).toBeNull();
  });
});

describe("K-line scanning", () => {
  const longReply = "61 80 77 00 31 38 31 04 41 42 45 E3 17 03 00 38 00 07 00 00 00 00 09 11 12 00";

  /** K-line replies are read as spaced text, so the mock answers in that form. */
  function klineEcu(answerAt: string): FrameHandler {
    return (frame, mock) => {
      const addressed = mock.settings.get("ATSH")?.includes(answerAt) === true;
      if (!addressed) return undefined;
      if (frame === "10C0") return "50 C0";
      if (frame === "2180") return longReply;
      if (frame === "1081") return "50 81";
      return undefined;
    };
  }

  const index = indexOf({
    inj: entry({
      address: "7A",
      protocol: "KWP2000",
      ecuname: "SIRIUS 34",
      projects: ["x70"],
      autoidents: [ident("4", "ABE", "0007", "0000")],
    }),
    other: entry({ address: "26", protocol: "KWP2000", projects: ["x70"], autoidents: [] }),
  });

  it("identifies a K-line ECU from its 2180 block", async () => {
    const { driver } = harness(klineEcu("7A"));
    await driver.initIso();

    const result = await probeKlineAddress(driver, index, "7A");
    expect(result.bus).toBe("kline");
    expect(result.outcome).toBe("identified");
    expect(result.matches[0]?.ecuname).toBe("SIRIUS 34");
  });

  it("forces slow init, because the ECU's own flag is not yet known", async () => {
    // During a sweep we do not know which ECU is at the address, so its fastinit
    // flag cannot be consulted — `scan_kwp` sets opt_si for exactly this reason.
    const { mock, driver } = harness(klineEcu("7A"));
    await driver.initIso();
    mock.drain();
    await probeKlineAddress(driver, index, "7A");
    expect(mock.written).toContain("AT SP 4");
    expect(mock.written).toContain("AT SI");
  });

  it("reports silence for an address that does not answer", async () => {
    const { driver } = harness(klineEcu("99"));
    await driver.initIso();
    expect((await probeKlineAddress(driver, index, "7A")).outcome).toBe("silent");
  });

  it("sweeps the K-line addresses of a vehicle", async () => {
    const { driver } = harness(klineEcu("7A"));
    const report = await scanKline(driver, index, { project: "x70" });

    expect(report.addressesProbed).toBe(2);
    expect(report.found.map((r) => r.address)).toEqual(["7A"]);
    expect(report.results.every((r) => r.bus === "kline")).toBe(true);
  });

  it("initialises the K-line once for the whole sweep", async () => {
    const { mock, driver } = harness(klineEcu("7A"));
    await scanKline(driver, index, { project: "x70" });
    // AT S1 belongs to initIso; more than one means it re-initialised per address.
    expect(mock.written.filter((command) => command === "AT S1")).toHaveLength(1);
  });
});

describe("scanAll", () => {
  const index = indexOf({
    can: entry({ address: "26", protocol: "CAN", projects: ["x70"], autoidents: [] }),
    kline: entry({ address: "7A", protocol: "KWP2000", projects: ["x70"], autoidents: [] }),
  });

  it("covers both buses in one report", async () => {
    const { driver } = harness(() => undefined);
    const report = await scanAll(driver, index, { project: "x70" });

    expect(report.addressesProbed).toBe(2);
    expect(report.results.map((r) => r.bus)).toEqual(["can", "kline"]);
  });

  it("numbers progress continuously, against one stable total", async () => {
    // One sweep from the operator's point of view: the counter must not restart
    // and the denominator must not change part-way, which reads as a bug even when
    // the count is right.
    const { driver } = harness(() => undefined);
    const seen: Array<[number, number]> = [];
    await scanAll(driver, index, {
      project: "x70",
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("does not start the second bus after a cancellation", async () => {
    const { driver } = harness(() => undefined);
    const signal = { aborted: false };
    const report = await scanAll(driver, index, {
      project: "x70",
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });
    expect(report.cancelled).toBe(true);
    expect(report.results.every((r) => r.bus === "can")).toBe(true);
  });
});

describe("addressesToProbe and the project-code split", () => {
  /** Two codes for one model, with an address only the later one carries. */
  const index = {
    format: 1 as const,
    ecus: {
      abs: {
        address: "01",
        protocol: "KWP2000",
        projects: ["x70", "x70Ph3"],
        group: "",
        ecuname: "ABS",
      },
      parking: {
        address: "0E",
        protocol: "KWP2000",
        projects: ["x70Ph3"],
        group: "",
        ecuname: "Parking",
      },
      other: { address: "44", protocol: "KWP2000", projects: ["x83"], group: "", ecuname: "Other" },
    },
    groups: [],
    projects: ["x70", "x70Ph3", "x83"],
    protocols: ["KWP2000"],
  } as unknown as Parameters<typeof addressesToProbe>[0];

  it("includes addresses that only a later variant of the same model carries", () => {
    // The bug this fixes was found on a real car: asking for `x70` on a Master II
    // probed 7 addresses and silently skipped 3 that only `x70Ph3` declares — the
    // parking aid, the SVT and the tacho. A module the vehicle has, never asked.
    expect(addressesToProbe(index, "kline", "x70")).toEqual(["01", "0E"]);
  });

  it("still excludes other models", () => {
    expect(addressesToProbe(index, "kline", "x70")).not.toContain("44");
  });

  it("matches when given the fuller code too", () => {
    expect(addressesToProbe(index, "kline", "x70Ph3")).toEqual(["01", "0E"]);
  });

  it("is case-insensitive, as the index is inconsistent about it", () => {
    expect(addressesToProbe(index, "kline", "X70")).toEqual(["01", "0E"]);
  });
});
