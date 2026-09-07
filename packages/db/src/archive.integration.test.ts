/**
 * The archive and the extracted tree must be the same database.
 *
 * The whole change rests on that: if reading `ecu.zip` in place produced even a
 * slightly different index, the catalogue would filter differently and nothing would
 * throw. So this loads both and compares — the index entry for entry, and a sample of
 * definitions byte for byte.
 *
 * Needs both artefacts, so it skips without them:
 *
 *   DDTX_DB_ZIP=data/ecu.zip DDTX_DB_TREE=data/tree pnpm test
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveDbSource, archiveEntryFor } from "./archive.js";
import { csfsDbSource } from "./csfs.js";

const zipPath = process.env.DDTX_DB_ZIP ?? "data/ecu.zip";
const treePath = process.env.DDTX_DB_TREE ?? "data/tree";
const runnable = existsSync(resolve(zipPath)) && existsSync(resolve(treePath));

describe.skipIf(!runnable)("ecu.zip read in place", () => {
  it("maps the app's paths onto the archive's flat names", () => {
    expect(archiveEntryFor("ecu/BCM95.json")).toBe("BCM95.json");
    expect(archiveEntryFor("layout/BCM95.json")).toBe("BCM95.json.layout");
    // A leading slash is optional throughout the app; both spellings occur.
    expect(archiveEntryFor("/ecu/BCM95.json")).toBe("BCM95.json");
    // Anything else is passed through, so an unexpected path fails as "not found"
    // rather than being silently rewritten into something that happens to exist.
    expect(archiveEntryFor("db.json")).toBe("db.json");
  });

  it("derives the same index the tree ships", async () => {
    const { nodeFileSystem } = await import("@emdzej/csfs-node");
    const disk = nodeFileSystem(resolve(zipPath, ".."));
    const archiveFile = await disk.file(`/${zipPath.split("/").pop() as string}`);
    expect(archiveFile).not.toBeNull();

    const fromZip = await archiveDbSource(archiveFile!);
    const fromTree = csfsDbSource(nodeFileSystem(resolve(treePath)));

    const treeIndex = JSON.parse(new TextDecoder().decode(await fromTree.read("index.json")));
    const zipIndex = fromZip.index;

    expect(zipIndex.format).toBe(treeIndex.format);
    expect(Object.keys(zipIndex.ecus).sort()).toEqual(Object.keys(treeIndex.ecus).sort());
    // The facets drive the catalogue's filters, so a difference here is visible.
    expect(zipIndex.groups).toEqual(treeIndex.groups);
    expect(zipIndex.projects).toEqual(treeIndex.projects);
    expect(zipIndex.protocols).toEqual(treeIndex.protocols);
    expect(fromZip.facts.ecus).toBe(Object.keys(treeIndex.ecus).length);
  }, 60_000);

  it("returns byte-identical definitions and layouts", async () => {
    const { nodeFileSystem } = await import("@emdzej/csfs-node");
    const disk = nodeFileSystem(resolve(zipPath, ".."));
    const archiveFile = await disk.file(`/${zipPath.split("/").pop() as string}`);
    const fromZip = await archiveDbSource(archiveFile!);
    const fromTree = csfsDbSource(nodeFileSystem(resolve(treePath)));

    // Spread across the index rather than the first N: entries near the start of a zip
    // would be unrepresentative if anything about the read were sequential.
    const slugs = Object.keys(fromZip.index.ecus);
    const step = Math.max(1, Math.floor(slugs.length / 25));
    const sample = slugs.filter((_, i) => i % step === 0).slice(0, 25);
    expect(sample.length).toBeGreaterThan(10);

    for (const slug of sample) {
      const a = await fromZip.read(`ecu/${slug}.json`);
      const b = await fromTree.read(`ecu/${slug}.json`);
      expect(a, `ecu/${slug}.json differs`).toEqual(b);

      // Not every ECU has a layout; where the tree has one, the archive must agree.
      const layout = await fromTree.read(`layout/${slug}.json`).catch(() => null);
      if (layout !== null) {
        expect(await fromZip.read(`layout/${slug}.json`), `layout/${slug}.json differs`).toEqual(
          layout,
        );
      }
    }
  }, 120_000);

  it("rejects a path the archive does not hold", async () => {
    const { nodeFileSystem } = await import("@emdzej/csfs-node");
    const disk = nodeFileSystem(resolve(zipPath, ".."));
    const archiveFile = await disk.file(`/${zipPath.split("/").pop() as string}`);
    const fromZip = await archiveDbSource(archiveFile!);
    await expect(fromZip.read("ecu/does-not-exist.json")).rejects.toThrow(/no such path/);
  }, 60_000);
});
