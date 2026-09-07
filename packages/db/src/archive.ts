/**
 * Read the database straight out of `ecu.zip`, without unpacking it.
 *
 * This replaces a 15-second import of 1.19 GB into the origin private file system with
 * an 88 ms open, and it is *faster* per read afterwards — measured on the real archive,
 * an ECU definition takes p50 1.3 ms out of the zip against 8.1 ms from the extracted
 * tree, because a zip entry is ~20 KB of I/O and inflate where the extracted file is
 * 406 KB. Storage goes from 1.19 GB to the 104 MB of the archive itself.
 *
 * ## The two shapes
 *
 * The archive is flat and the app's paths are not, so this maps between them:
 *
 * | the app asks for       | the archive holds        |
 * | ---------------------- | ------------------------ |
 * | `index.json`           | derived from `db.json`   |
 * | `ecu/<slug>.json`      | `<slug>.json`            |
 * | `layout/<slug>.json`   | `<slug>.json.layout`     |
 *
 * `db-split` performs the same mapping when it writes a tree, which is why a tree and
 * an archive are interchangeable behind `DbSource`. The mapping lives here rather than
 * in a csfs archive mount because csfs's `entry` modes are `"relative"` and
 * `"basename"`, and neither rewrites an extension — `/layout/X.json` →
 * `X.json.layout` is a fact about *this* database, not about archives in general.
 *
 * ## Why the index is synthesised
 *
 * `index.json` is not in the archive; it is derived. `buildIndex` drops the ECUs the
 * upstream `db.json` lists but never shipped a file for, and computes the
 * group/project/protocol facets the catalogue filters on. That runs once at open and
 * the bytes are held, so `Database` reads `index.json` exactly as it would from a tree
 * and cannot tell the difference.
 */

import { buildIndex, type DbTreeIndex } from "@ddtx/core";
import type { CsFile } from "@emdzej/csfs-core";
import { zipFileSystem } from "@emdzej/csfs-zip";
import type { DbSource } from "./source.js";

/** What the archive turned out to contain, for the settings panel and for checks. */
export interface ArchiveFacts {
  /** ECUs with both an index entry and a file. */
  readonly ecus: number;
  /** Entries in the archive, all kinds. */
  readonly entries: number;
  /** ECUs the upstream index declared but shipped no file for. */
  readonly indexedButNoFile: number;
  /** Files present that the index says nothing about. */
  readonly unindexed: number;
}

const LAYOUT_SUFFIX = ".json.layout";

/** `ecu/X.json` → `X.json`, `layout/X.json` → `X.json.layout`, else unchanged. */
export function archiveEntryFor(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (clean.startsWith("ecu/")) return clean.slice("ecu/".length);
  if (clean.startsWith("layout/")) {
    const slug = clean.slice("layout/".length).replace(/\.json$/, "");
    return `${slug}${LAYOUT_SUFFIX}`;
  }
  return clean;
}

export interface ArchiveDbSource extends DbSource {
  readonly facts: ArchiveFacts;
  /** The index, already parsed — the app has it anyway and re-parsing 1.5 MB is waste. */
  readonly index: DbTreeIndex;
}

/**
 * Open an archive as a database source.
 *
 * Rejects if the archive is not a zip, or holds no `db.json` — the same two conditions
 * `inspectArchive` reports on, checked here too because this path no longer goes
 * through the importer.
 */
export async function archiveDbSource(archive: CsFile): Promise<ArchiveDbSource> {
  const zip = zipFileSystem(archive);

  const root = await zip.directory("/");
  if (root === null) {
    throw new Error("That file is not a readable zip archive.");
  }

  // One listing, kept: every read afterwards is a map hit rather than a directory walk,
  // and the slug set is what tells `buildIndex` which entries actually shipped.
  const names = new Set(
    (await root.entries()).filter((entry) => entry.kind === "file").map((entry) => entry.name),
  );

  const raw = await zip.read("/db.json");
  if (raw === null) {
    throw new Error(
      "No `db.json` in the archive. That is the database index, so this is not an " +
        "ECU database archive.",
    );
  }

  const slugs = [...names]
    .filter((name) => name.endsWith(".json") && name !== "db.json")
    .map((name) => name.slice(0, -".json".length));

  const built = buildIndex(raw, slugs);
  const indexBytes = new TextEncoder().encode(JSON.stringify(built.index));

  const facts: ArchiveFacts = {
    ecus: Object.keys(built.index.ecus).length,
    entries: names.size,
    indexedButNoFile: built.indexedButNoFile,
    unindexed: built.unindexed.length,
  };

  if (facts.ecus === 0) {
    throw new Error("`db.json` declares no ECUs that the archive has files for.");
  }

  return {
    facts,
    index: built.index,

    async read(path: string): Promise<Uint8Array> {
      if (path.replace(/^\/+/, "") === "index.json") return indexBytes;

      const entry = archiveEntryFor(path);
      // Checked against the listing first so an absent path is one map hit rather than
      // a zip lookup — `Database` asks for a layout that may not exist on every screen
      // open, and 1,580 of those would otherwise each walk the central directory.
      if (!names.has(entry)) {
        throw new Error(`DbSource: no such path ${path} (looked for ${entry} in the archive)`);
      }
      const bytes = await zip.read(`/${entry}`);
      if (bytes === null) throw new Error(`DbSource: ${entry} vanished from the archive`);
      return bytes;
    },
  };
}
