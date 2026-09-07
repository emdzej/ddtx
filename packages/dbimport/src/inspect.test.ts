/**
 * Structural checks on an archive and on a tree.
 *
 * The reason these exist: the importer clears the installed tree before it writes, and
 * the only structural guard used to be `db.json not found` at the *end* of streaming.
 * So picking the wrong file deleted a working database and then failed. The check has
 * to be cheap enough to always run first, and specific enough that its message names
 * the mistake.
 */

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { inspectTree } from "./inspect.js";

const encoder = new TextEncoder();

function archive(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = encoder.encode(body);
  return zipSync(entries);
}

/** A minimal but structurally valid database. */
function goodArchive(ecus = 3): Uint8Array {
  const files: Record<string, string> = {
    "db.json": JSON.stringify(
      Object.fromEntries(
        Array.from({ length: ecus }, (_, i) => [
          `ecu${i}.json`,
          { address: "7A", protocol: "CAN", projects: ["x70"], group: "Injection" },
        ]),
      ),
    ),
  };
  for (let i = 0; i < ecus; i++) {
    files[`ecu${i}.json`] = JSON.stringify({ ecuname: `ECU ${i}` });
    files[`ecu${i}.json.layout`] = JSON.stringify({ screens: {} });
  }
  return archive(files);
}

describe("inspectTree", () => {
  /** A read function over a plain map, rejecting what is absent. */
  function reader(files: Record<string, string>) {
    return (path: string): Promise<Uint8Array> => {
      const body = files[path];
      if (body === undefined) return Promise.reject(new Error(`no ${path}`));
      return Promise.resolve(encoder.encode(body));
    };
  }

  function goodTree(n = 20): Record<string, string> {
    const slugs = Array.from({ length: n }, (_, i) => `ecu${i}`);
    const files: Record<string, string> = {
      "index.json": JSON.stringify({
        format: 1,
        ecus: Object.fromEntries(slugs.map((s) => [s, { address: "7A" }])),
      }),
    };
    for (const s of slugs) {
      files[`ecu/${s}.json`] = "{}";
      files[`layout/${s}.json`] = "{}";
    }
    return files;
  }

  it("accepts a complete tree", async () => {
    const report = await inspectTree(reader(goodTree()));
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.indexed).toBe(20);
    expect(report.sampled?.missingEcu).toBe(0);
  });

  it("tells the user which folder to pick when there is no index", async () => {
    // What picking "Downloads" looks like. The message has to be directive.
    const report = await inspectTree(reader({ "something.txt": "x" }));
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/index\.json/);
    expect(report.findings[0]?.message).toMatch(/db-split/);
  });

  it("rejects an index with no ecus", async () => {
    const report = await inspectTree(reader({ "index.json": '{"format":1}' }));
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => /not a split database index/.test(f.message))).toBe(true);
  });

  it("rejects an index whose ECU files are absent", async () => {
    // An import killed early, or a folder holding only the index.
    const files = goodTree();
    for (const key of Object.keys(files)) if (key.startsWith("ecu/")) delete files[key];
    const report = await inspectTree(reader(files));
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => /no ECU files are/.test(f.message))).toBe(true);
  });

  it("samples across the index rather than taking the first few", async () => {
    // A tree whose import died half-way has a complete start. Sampling the head only
    // would call it healthy.
    const files = goodTree(100);
    for (let i = 50; i < 100; i++) delete files[`ecu/ecu${i}.json`];
    const report = await inspectTree(reader(files));
    expect(report.ok).toBe(false);
    expect(report.sampled?.missingEcu).toBeGreaterThan(0);
  });

  it("warns rather than fails when only layouts are missing", async () => {
    const files = goodTree();
    for (const key of Object.keys(files)) if (key.startsWith("layout/")) delete files[key];
    const report = await inspectTree(reader(files));
    expect(report.ok).toBe(true);
    expect(report.findings.some((f) => f.severity === "warning")).toBe(true);
  });

  it("reports the archive a tree came from when a manifest is there", async () => {
    const files = goodTree();
    files["manifest.json"] = JSON.stringify({ source: { name: "ecu.zip", sha256: "abc123" } });
    const report = await inspectTree(reader(files));
    expect(report.manifest).toMatchObject({ name: "ecu.zip", sha256: "abc123" });
  });
});
