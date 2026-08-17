import { describe, expect, it } from "vitest";
import type { DbTreeIndex, EcuFileDef, LayoutFileDef } from "@ddtx/core";
import { EcuDatabase, getRequest } from "./database.js";
import { MemoryDbSource, type DbSource } from "./source.js";

const index: DbTreeIndex = {
  format: 1,
  ecus: {
    sirius: {
      protocol: "KWP2000",
      ecuname: "SIRIUS34 - EMS3134",
      address: "7A",
      group: "Injection",
      projects: ["X65", "X90"],
      autoidents: [],
    },
    bcm: {
      protocol: "CAN",
      ecuname: "BCM95",
      address: "26",
      group: "Habitacle",
      projects: ["X95"],
      autoidents: [],
    },
  },
  groups: ["Habitacle", "Injection"],
  projects: ["X65", "X90", "X95"],
  protocols: ["CAN", "KWP2000"],
};

const sirius: EcuFileDef = {
  ecuname: "SIRIUS34 - EMS3134",
  obd: { protocol: "KWP2000", funcaddr: "7A", funcname: "Injection", fastinit: true },
  endian: "Big",
  autoidents: [],
  requests: [
    {
      name: "Trame 10",
      deny_sds: [],
      sentbytes: "2110",
      receivebyte_dataitems: { "Régime moteur": { firstbyte: 2 } },
    },
  ],
  data: {
    "Régime moteur": { scaled: true, bitscount: 16, bytescount: 2, step: 0.125, unit: "rpm" },
  },
  devices: [],
};

const siriusLayout: LayoutFileDef = {
  screens: {
    "Infos Moteur": {
      width: 12000,
      height: 8580,
      color: "rgb(128,128,128)",
      displays: [
        {
          rect: { left: 0, top: 0, width: 100, height: 300 },
          color: "rgb(255,255,255)",
          fontcolor: "rgb(0,0,0)",
          font: { name: "Arial", size: 9, bold: "0", italic: "0" },
          text: "Régime moteur",
          request: "Trame 10",
          width: 50,
        },
      ],
      inputs: [],
      labels: [],
      buttons: [],
      presend: [],
    },
  },
  categories: { "Ecrans MAP": ["Infos Moteur"] },
};

function source(): MemoryDbSource {
  return MemoryDbSource.fromJson({
    "index.json": index,
    "ecu/sirius.json": sirius,
    "layout/sirius.json": siriusLayout,
  });
}

/** Wraps a source to count reads, for the caching assertions. */
class CountingSource implements DbSource {
  reads: string[] = [];
  constructor(private readonly inner: DbSource) {}
  read(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    return this.inner.read(path);
  }
}

describe("EcuDatabase", () => {
  it("loads the index and exposes its facets", async () => {
    const db = await EcuDatabase.open(source());
    expect(db.size).toBe(2);
    expect(db.groups).toEqual(["Habitacle", "Injection"]);
    expect(db.summary("sirius")?.ecuname).toBe("SIRIUS34 - EMS3134");
    expect(db.summary("nope")).toBeUndefined();
  });

  it("rejects an index format it doesn't understand", async () => {
    const bad = MemoryDbSource.fromJson({ "index.json": { ...index, format: 2 } });
    await expect(EcuDatabase.open(bad)).rejects.toThrow(/unsupported index format/);
  });

  it("filters by group, project, address, protocol and name", async () => {
    const db = await EcuDatabase.open(source());
    expect(db.list({ group: "Injection" }).map((e) => e.slug)).toEqual(["sirius"]);
    expect(db.list({ project: "x95" }).map((e) => e.slug)).toEqual(["bcm"]);
    expect(db.list({ address: "7a" }).map((e) => e.slug)).toEqual(["sirius"]);
    expect(db.list({ protocol: "can" }).map((e) => e.slug)).toEqual(["bcm"]);
    expect(db.list({ search: "sirius" }).map((e) => e.slug)).toEqual(["sirius"]);
    expect(db.list({ group: "Injection", project: "X95" })).toEqual([]);
    expect(db.list().map((e) => e.slug)).toEqual(["bcm", "sirius"]);
  });

  it("resolves requests bound to the ECU's data dictionary", async () => {
    const db = await EcuDatabase.open(source());
    const ecu = await db.loadEcu("sirius");
    const request = ecu.requests.get("Trame 10");
    expect(request?.endianness).toBe("Big");
    expect(request?.data.get("Régime moteur")?.step).toBe(0.125);
    // Defaults from ecu_data.py must be applied, not left undefined.
    expect(request?.data.get("Régime moteur")?.divideby).toBe(1);
  });

  it("looks requests up case-insensitively, as ecu_file.get_request does", async () => {
    const db = await EcuDatabase.open(source());
    const ecu = await db.loadEcu("sirius");
    expect(getRequest(ecu, "Trame 10")).toBeDefined();
    expect(getRequest(ecu, "trame 10")).toBeDefined();
    expect(getRequest(ecu, "no such request")).toBeUndefined();
  });

  it("fetches an ECU once however many callers ask concurrently", async () => {
    const counting = new CountingSource(source());
    const db = await EcuDatabase.open(counting);
    counting.reads.length = 0;

    await Promise.all([db.loadEcu("sirius"), db.loadEcu("sirius"), db.loadEcu("sirius")]);
    await db.loadEcu("sirius");

    expect(counting.reads).toEqual(["ecu/sirius.json"]);
  });

  it("loads the layout and its ECU together, then caches both", async () => {
    const counting = new CountingSource(source());
    const db = await EcuDatabase.open(counting);
    counting.reads.length = 0;

    const layout = await db.loadLayout("sirius");
    expect(layout.categories).toEqual([{ name: "Ecrans MAP", screens: ["Infos Moteur"] }]);
    expect(layout.screens.get("Infos Moteur")?.widgets[0]?.dataName).toBe("Régime moteur");
    expect(layout.warnings).toEqual([]);

    await db.loadLayout("sirius");
    expect(counting.reads.sort()).toEqual(["ecu/sirius.json", "layout/sirius.json"]);
  });

  it("does not cache a failure, so a transient error can be retried", async () => {
    let attempts = 0;
    const flaky: DbSource = {
      read: async (path) => {
        if (path === "ecu/sirius.json" && attempts++ === 0) throw new Error("network");
        return source().read(path);
      },
    };
    const db = await EcuDatabase.open(flaky);

    await expect(db.loadEcu("sirius")).rejects.toThrow("network");
    await expect(db.loadEcu("sirius")).resolves.toMatchObject({ slug: "sirius" });
    expect(attempts).toBe(2);
  });

  it("clears cached definitions on request", async () => {
    const counting = new CountingSource(source());
    const db = await EcuDatabase.open(counting);
    await db.loadEcu("sirius");
    counting.reads.length = 0;

    db.clearCache();
    await db.loadEcu("sirius");
    expect(counting.reads).toEqual(["ecu/sirius.json"]);
  });
});
