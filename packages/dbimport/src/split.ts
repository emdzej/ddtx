/**
 * Split `ecu.zip` into the static tree the app reads.
 *
 * The zip is 104 MB compressed and **1.278 GB expanded** across 3,749 entries, so it
 * can never be shipped to a browser whole. Each ECU becomes two independently
 * cacheable files behind a single index, which matches how the app actually reads the
 * data: the index at startup, an ECU's definitions when it is selected, and its
 * layout only when a screen is opened.
 *
 * Emitted files are **byte-identical** to their zip entries. Nothing is normalised,
 * pruned, or reformatted:
 *
 *  - the i18n overlay keys are content hashes over the original strings, so any
 *    rewrite here would invalidate every translation (docs/i18n-overlay.md §3);
 *  - a future database snapshot can be diffed against this one;
 *  - integrity problems belong in a report, not in edits to the data.
 *
 * Dangling references are therefore reported, not fixed. `@ddtx/db` prunes them at
 * load time, because they are real: 24 widgets across the whole database name a data
 * definition that doesn't exist.
 *
 * ## Why this module has no Node imports
 *
 * Two hosts run it: the CLI writes with `writeFileSync`, and the web app writes into
 * OPFS. Keeping it host-free is what stops there being two implementations of the one
 * piece of code that must not drift.
 *
 * ## Why `write` is sync but the function is async
 *
 * fflate dispatches each entry from inside the previous entry's `ondata`, so there is
 * no way to await *inside* the entry handler. But the archive is pushed to fflate in
 * slices, and between slices there is nothing on the stack — so that is where an async
 * host gets its chance. `write` buffers, `flush` drains, and the queue only ever holds
 * the entries that completed within one 256 KB slice. See docs/database-install.md §2.
 */

import { Unzip, UnzipInflate } from "fflate";
import type { DbIndex, DbTreeIndex, IndexEntry } from "@ddtx/core";

const GRAPHICS_PREFIX = "graphics/";

/**
 * Where split output goes.
 *
 * `write` must be synchronous, because it is called from inside fflate's entry
 * handler where nothing can be awaited. A host that can only write asynchronously
 * implements `flush` as well: `write` queues, `flush` drains, and it is awaited
 * between archive slices. The queue holds only what completed inside one 256 KB
 * slice — a few MB, not the 543 MB the whole tree would cost.
 */
export interface SplitSink {
  /** Write `bytes` to a path relative to the tree root, e.g. `ecu/SIRIUS34.json`. */
  write(path: string, bytes: Uint8Array): void;
  /**
   * Awaited between archive slices. Async hosts drain their queue here.
   *
   * Not called after the final slice — callers await `splitArchive`, which flushes
   * once more before returning.
   */
  flush?(): Promise<void>;
  /** Create a directory. Awaited before any file is written. */
  mkdir?(path: string): Promise<void> | void;
  log?(message: string): void;
  /** Entries seen so far, for a progress bar. Called often; keep it cheap. */
  progress?(done: number, bytesOut: number): void;
}

export interface SplitCounts {
  ecus: number;
  layouts: number;
  indexed: number;
  graphicsSkipped: number;
  /** In the index but with no file behind it. */
  indexedButNoFile: number;
  /** A file the index never mentions. */
  fileButNotIndexed: number;
}

export interface SplitResult {
  index: DbTreeIndex;
  /** Slugs that produced an ECU file, in archive order. */
  ecuSlugs: string[];
  layoutSlugs: string[];
  counts: SplitCounts;
  /** Uncompressed bytes emitted, by directory. */
  bytesOut: Record<string, number>;
  unrecognised: string[];
}

/**
 * Read the archive and emit the tree through `sink`.
 *
 * Streamed rather than `unzipSync`'d: decompressing every entry at once would hold
 * 1.28 GB. Writes happen inside the entry handler, which keeps the memory ceiling at
 * one entry — 5.4 MB at the largest — and needs no backpressure plumbing.
 */
export async function splitArchive(zipBytes: Uint8Array, sink: SplitSink): Promise<SplitResult> {
  await sink.mkdir?.("ecu");
  await sink.mkdir?.("layout");

  const ecuSlugs: string[] = [];
  const layoutSlugs: string[] = [];
  const unrecognised: string[] = [];
  const bytesOut: Record<string, number> = { ecu: 0, layout: 0 };
  let dbIndexRaw: Uint8Array | null = null;
  let graphicsSkipped = 0;
  let seen = 0;

  await streamZip(zipBytes, sink, (name, bytes) => {
    seen += 1;

    if (name === "db.json") {
      dbIndexRaw = bytes;
    } else if (name.startsWith(GRAPHICS_PREFIX)) {
      // Unreferenced: no layout in the database mentions any graphics filename.
      // They are DDT2000 leftovers, so 588 files and 3.4 MB stay behind.
      graphicsSkipped += 1;
    } else if (name.endsWith(".json.layout")) {
      const slug = name.slice(0, -".json.layout".length);
      layoutSlugs.push(slug);
      sink.write(`layout/${slug}.json`, bytes);
      bytesOut.layout = (bytesOut.layout ?? 0) + bytes.length;
    } else if (name.endsWith(".json")) {
      const slug = name.slice(0, -".json".length);
      ecuSlugs.push(slug);
      sink.write(`ecu/${slug}.json`, bytes);
      bytesOut.ecu = (bytesOut.ecu ?? 0) + bytes.length;
    } else {
      unrecognised.push(name);
      sink.log?.(`  skipping unrecognised entry: ${name}`);
    }

    sink.progress?.(seen, (bytesOut.ecu ?? 0) + (bytesOut.layout ?? 0));
  });

  sink.log?.(
    `  extracted ${ecuSlugs.length} ECU + ${layoutSlugs.length} layout files, ` +
      `skipped ${graphicsSkipped} graphics`,
  );

  if (dbIndexRaw === null) throw new Error("db.json not found in archive");

  const built = buildIndex(dbIndexRaw, ecuSlugs);
  sink.write("index.json", encode(JSON.stringify(built.index)));
  // The last slice's entries and the index are still queued at this point.
  await sink.flush?.();
  sink.log?.(
    `  index: ${Object.keys(built.index.ecus).length} ECUs, ` +
      `${built.index.groups.length} groups, ${built.index.projects.length} projects`,
  );

  return {
    index: built.index,
    ecuSlugs,
    layoutSlugs,
    unrecognised,
    bytesOut,
    counts: {
      ecus: ecuSlugs.length,
      layouts: layoutSlugs.length,
      indexed: Object.keys(built.index.ecus).length,
      graphicsSkipped,
      indexedButNoFile: built.indexedButNoFile,
      fileButNotIndexed: built.unindexed.length,
    },
  };
}

/** Turn the archive's `db.json` into the faceted index the app loads at startup. */
function buildIndex(
  dbIndexRaw: Uint8Array,
  ecuSlugs: readonly string[],
): { index: DbTreeIndex; indexedButNoFile: number; unindexed: string[] } {
  const upstream = JSON.parse(new TextDecoder().decode(dbIndexRaw)) as DbIndex;
  const ecus: Record<string, IndexEntry> = {};
  const groups = new Set<string>();
  const projects = new Set<string>();
  const protocols = new Set<string>();
  const knownEcus = new Set(ecuSlugs);

  let indexedButNoFile = 0;
  for (const [key, entry] of Object.entries(upstream)) {
    const slug = key.endsWith(".json") ? key.slice(0, -".json".length) : key;
    if (!knownEcus.has(slug)) {
      indexedButNoFile += 1;
      continue;
    }
    ecus[slug] = entry;
    if (entry.group) groups.add(entry.group);
    for (const project of entry.projects) {
      // `#text` and friends are XML node names that leaked through the original
      // converter (`projects.append(project.nodeName)` doesn't skip text nodes).
      // They are not vehicles, so they stay out of the facet — the raw entries keep
      // them, since the files are emitted byte-identical.
      if (project && !project.startsWith("#")) projects.add(project);
    }
    if (entry.protocol) protocols.add(entry.protocol);
  }

  return {
    index: {
      format: 1,
      ecus,
      groups: [...groups].sort(),
      projects: [...projects].sort(),
      protocols: [...protocols].sort(),
    },
    indexedButNoFile,
    unindexed: ecuSlugs.filter((slug) => ecus[slug] === undefined),
  };
}

/**
 * Feed the archive to fflate in slices rather than one call.
 *
 * `Unzip` dispatches the next entry from inside the previous entry's `ondata`, so a
 * single `push()` of the whole 100 MB archive recurses once per entry and overflows
 * the stack somewhere in the first few hundred of 3,749. Chunking bounds the
 * recursion to the entries that happen to complete within one slice; the stack
 * unwinds between pushes.
 */
const PUSH_CHUNK = 256 * 1024;

async function streamZip(
  zipBytes: Uint8Array,
  sink: SplitSink,
  emit: (name: string, bytes: Uint8Array) => void,
): Promise<void> {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  unzip.onfile = (file) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      if (chunk.length > 0) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (final) {
        const joined = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          joined.set(c, at);
          at += c.length;
        }
        chunks.length = 0;
        emit(file.name, joined);
      }
    };
    file.start();
  };

  for (let at = 0; at < zipBytes.length; at += PUSH_CHUNK) {
    const end = Math.min(at + PUSH_CHUNK, zipBytes.length);
    unzip.push(zipBytes.subarray(at, end), end === zipBytes.length);
    // Between slices the stack is empty, so this is the one place an async host can
    // actually write. It is also what yields to the event loop, which is what keeps a
    // progress bar moving instead of freezing for the whole import.
    await sink.flush?.();
  }
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
