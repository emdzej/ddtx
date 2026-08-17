import { describe, expect, it } from "vitest";
import type { DbTreeIndex, IndexAutoIdent, IndexEntry } from "@ddtx/core";
import { matchAutoIdent } from "./autoident.js";

function ident(
  diagnostic_version: string,
  supplier_code: string,
  soft_version: string,
  version: string,
): IndexAutoIdent {
  return { diagnostic_version, supplier_code, soft_version, version };
}

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    protocol: "KWP2000",
    ecuname: "SIRIUS34",
    address: "7A",
    group: "Injection",
    projects: ["X65"],
    autoidents: [],
    ...overrides,
  };
}

function indexOf(ecus: Record<string, IndexEntry>): DbTreeIndex {
  return { format: 1, ecus, groups: [], projects: [], protocols: [] };
}

const reported = { diagversion: "16", supplier: "001", soft: "00EA", version: "8000" };

describe("matchAutoIdent", () => {
  it("matches on all four fields", () => {
    const index = indexOf({ sirius: entry({ autoidents: [ident("16", "001", "00EA", "8000")] }) });
    const hits = matchAutoIdent(index, "7A", reported, "KWP");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.quality).toBe("exact");
    expect(hits[0]?.slug).toBe("sirius");
  });

  it("compares diagversion numerically, so 016 matches 16", () => {
    const index = indexOf({ a: entry({ autoidents: [ident("016", "001", "00EA", "8000")] }) });
    expect(matchAutoIdent(index, "7A", reported, "KWP")[0]?.quality).toBe("exact");
  });

  it("accepts a stored value that is a prefix of what the ECU reported", () => {
    // Stored soft "00" against reported "00EA" — the database abbreviates.
    const index = indexOf({ a: entry({ autoidents: [ident("16", "001", "00", "80")] }) });
    expect(matchAutoIdent(index, "7A", reported, "KWP")[0]?.quality).toBe("exact");
  });

  it("rejects the reverse direction: a stored value longer than reported", () => {
    const index = indexOf({ a: entry({ autoidents: [ident("16", "001", "00EA55", "8000")] }) });
    expect(matchAutoIdent(index, "7A", reported, "KWP")).toEqual([]);
  });

  it("never matches an entry with an empty diagversion", () => {
    const index = indexOf({ a: entry({ autoidents: [ident("", "001", "00EA", "8000")] }) });
    expect(matchAutoIdent(index, "7A", reported, "KWP")).toEqual([]);
  });

  it("falls back to approximate matches ordered by version distance", () => {
    const index = indexOf({
      far: entry({ autoidents: [ident("16", "001", "00EA", "9000")] }),
      near: entry({ autoidents: [ident("16", "001", "00EA", "8010")] }),
      other: entry({ autoidents: [ident("16", "002", "00EA", "8000")] }),
    });

    // Version mismatch defeats the exact test but not supplier+soft.
    const hits = matchAutoIdent(index, "7A", reported, "KWP");
    expect(hits.map((h) => h.slug)).toEqual(["near", "far"]);
    expect(hits[0]?.quality).toBe("approximate");
    expect(hits[0]?.versionDelta).toBe(0x8010 - 0x8000);
  });

  it("skips approximate candidates whose version is not hex", () => {
    // "If version contains ASCII characters, I can do nothing for you..."
    const index = indexOf({ a: entry({ autoidents: [ident("16", "001", "00EA", "REV-A")] }) });
    expect(matchAutoIdent(index, "7A", reported, "KWP")).toEqual([]);
  });

  it("filters by transport, folding ISO8 in with KWP", () => {
    const index = indexOf({
      can: entry({ protocol: "CAN", autoidents: [ident("16", "001", "00EA", "8000")] }),
      iso: entry({ protocol: "ISO8", autoidents: [ident("16", "001", "00EA", "8000")] }),
    });

    expect(matchAutoIdent(index, "7A", reported, "CAN").map((h) => h.slug)).toEqual(["can"]);
    expect(matchAutoIdent(index, "7A", reported, "KWP").map((h) => h.slug)).toEqual(["iso"]);
  });

  it("only considers entries at the requested address", () => {
    const index = indexOf({
      here: entry({ address: "7A", autoidents: [ident("16", "001", "00EA", "8000")] }),
      elsewhere: entry({ address: "26", autoidents: [ident("16", "001", "00EA", "8000")] }),
    });
    expect(matchAutoIdent(index, "7a", reported, "KWP").map((h) => h.slug)).toEqual(["here"]);
  });
});
