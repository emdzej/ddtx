#!/usr/bin/env node
/**
 * Split `ecu.zip` into the static tree the web app fetches.
 *
 * The zip is 104 MB compressed and **1.278 GB expanded** across 3,749 entries,
 * so it can never be shipped to a browser. Instead each ECU becomes two
 * independently-cacheable files behind a single index, which matches how the
 * app actually reads the data: the index is needed at startup, an ECU's
 * definitions when it's selected, and its layout only when a screen is opened.
 *
 * Emitted files are **byte-identical** to their zip entries. Nothing is
 * normalised, pruned, or reformatted:
 *
 *  - the i18n overlay keys are content hashes over the original strings, so any
 *    rewrite here would invalidate every translation (docs/i18n-overlay.md §3);
 *  - a future database snapshot can be diffed against this one;
 *  - integrity problems belong in a report, not in edits to the data.
 *
 * Dangling references are therefore reported, not fixed. `@ddtx/db` prunes them
 * at load time, because they are real: 24 widgets across the whole database name
 * a data definition that doesn't exist.
 *
 * Usage:
 *   db-split <ecu.zip> <outdir> [--compress=gzip[,br]] [--quiet]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { Unzip, UnzipInflate } from "fflate";
import type { DbIndex, DbTreeIndex, EcuFileDef, IndexEntry, LayoutFileDef } from "@ddtx/core";

interface Finding {
  kind: string;
  ecu: string;
  detail: string;
}

interface Report {
  counts: Record<string, number>;
  findingCounts: Record<string, number>;
  /** Bounded sample — the full list runs to thousands of entries. */
  samples: Finding[];
}

const GRAPHICS_PREFIX = "graphics/";

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const zipPath = positional[0];
  const outDir = positional[1];

  if (zipPath === undefined || outDir === undefined) {
    console.error("usage: db-split <ecu.zip> <outdir> [--compress=gzip[,br]] [--quiet]");
    process.exit(2);
  }

  const quiet = args.includes("--quiet");
  const compressArg = args.find((a) => a.startsWith("--compress"));
  const encodings = new Set(
    (compressArg?.split("=")[1] ?? (compressArg ? "gzip" : ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const log = (msg: string): void => {
    if (!quiet) console.log(msg);
  };

  for (const dir of ["ecu", "layout"]) mkdirSync(join(outDir, dir), { recursive: true });

  // ── pass 1: extract ──────────────────────────────────────────────────────
  //
  // Streamed rather than `unzipSync`'d: decompressing every entry at once would
  // hold 1.28 GB. Writes are synchronous inside the handler, which keeps the
  // memory ceiling at one entry (max 5.4 MB) and needs no backpressure plumbing.

  const ecuNames: string[] = [];
  const layoutNames: string[] = [];
  let dbIndexRaw: Uint8Array | null = null;
  let skippedGraphics = 0;
  const bytesOut: Record<string, number> = { ecu: 0, layout: 0 };

  const emit = (name: string, bytes: Uint8Array): void => {
    if (name === "db.json") {
      dbIndexRaw = bytes;
      return;
    }
    if (name.startsWith(GRAPHICS_PREFIX)) {
      // Unreferenced: no layout in the database mentions any graphics filename.
      // They are DDT2000 leftovers, so 588 files and 3.4 MB stay behind.
      skippedGraphics += 1;
      return;
    }

    if (name.endsWith(".json.layout")) {
      const slug = name.slice(0, -".json.layout".length);
      layoutNames.push(slug);
      write(join(outDir, "layout", `${slug}.json`), bytes, encodings);
      bytesOut.layout = (bytesOut.layout ?? 0) + bytes.length;
    } else if (name.endsWith(".json")) {
      const slug = name.slice(0, -".json".length);
      ecuNames.push(slug);
      write(join(outDir, "ecu", `${slug}.json`), bytes, encodings);
      bytesOut.ecu = (bytesOut.ecu ?? 0) + bytes.length;
    } else {
      log(`  skipping unrecognised entry: ${name}`);
    }
  };

  log(`reading ${basename(zipPath)} (${fmtBytes(statSync(zipPath).size)})`);
  const zipBytes = readFileSync(zipPath);
  const sourceHash = createHash("sha256").update(zipBytes).digest("hex");

  streamZip(zipBytes, emit);

  log(
    `  extracted ${ecuNames.length} ECU + ${layoutNames.length} layout files ` +
      `(${fmtBytes((bytesOut.ecu ?? 0) + (bytesOut.layout ?? 0))}), skipped ${skippedGraphics} graphics`,
  );

  if (dbIndexRaw === null) throw new Error("db.json not found in archive");

  // ── index ────────────────────────────────────────────────────────────────

  const upstream = JSON.parse(new TextDecoder().decode(dbIndexRaw)) as DbIndex;
  const ecus: Record<string, IndexEntry> = {};
  const groups = new Set<string>();
  const projects = new Set<string>();
  const protocols = new Set<string>();
  const knownEcus = new Set(ecuNames);

  let indexedMissingFile = 0;
  for (const [key, entry] of Object.entries(upstream)) {
    const slug = key.endsWith(".json") ? key.slice(0, -".json".length) : key;
    if (!knownEcus.has(slug)) {
      indexedMissingFile += 1;
      continue;
    }
    ecus[slug] = entry;
    if (entry.group) groups.add(entry.group);
    for (const p of entry.projects) if (p) projects.add(p);
    if (entry.protocol) protocols.add(entry.protocol);
  }

  const unindexed = ecuNames.filter((slug) => ecus[slug] === undefined);

  const index: DbTreeIndex = {
    format: 1,
    ecus,
    groups: [...groups].sort(),
    projects: [...projects].sort(),
    protocols: [...protocols].sort(),
  };
  write(join(outDir, "index.json"), encode(JSON.stringify(index)), encodings);
  log(
    `  index: ${Object.keys(ecus).length} ECUs, ${index.groups.length} groups, ` +
      `${index.projects.length} projects`,
  );

  // ── pass 2: validate ─────────────────────────────────────────────────────

  const report = validate(outDir, ecuNames, log);
  report.counts.indexedButNoFile = indexedMissingFile;
  report.counts.fileButNotIndexed = unindexed.length;
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1));

  const manifest = {
    format: 1,
    source: { name: basename(zipPath), bytes: zipBytes.length, sha256: sourceHash },
    counts: {
      ecus: ecuNames.length,
      layouts: layoutNames.length,
      indexed: Object.keys(ecus).length,
      graphicsSkipped: skippedGraphics,
    },
    bytes: bytesOut,
    encodings: [...encodings],
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));

  log("\nintegrity:");
  for (const [kind, count] of Object.entries(report.findingCounts).sort((a, b) => b[1] - a[1])) {
    log(`  ${kind.padEnd(34)} ${String(count).padStart(8)}`);
  }
  if (indexedMissingFile > 0) log(`  indexed but no file                 ${indexedMissingFile}`);
  if (unindexed.length > 0) log(`  file but not indexed               ${unindexed.length}`);
  log(`\nwrote ${outDir}`);
}

/**
 * Feed the archive to fflate in slices rather than one call.
 *
 * `Unzip` dispatches the next entry from inside the previous entry's `ondata`,
 * so a single `push()` of the whole 100 MB archive recurses once per entry and
 * overflows the stack somewhere in the first few hundred of 3,749. Chunking
 * bounds the recursion to the entries that happen to complete within one slice;
 * the stack unwinds between pushes.
 */
const PUSH_CHUNK = 256 * 1024;

/**
 * Walk every entry of a zip held in memory, handing each decompressed entry to
 * `emit`. Only the archive bytes and one inflated entry are resident at a time.
 */
function streamZip(zipBytes: Uint8Array, emit: (name: string, bytes: Uint8Array) => void): void {
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
  }
}

/**
 * Re-read the emitted tree and check every cross-reference.
 *
 * Reads from disk rather than keeping parsed objects from pass 1 — that would
 * mean holding 1.28 GB of JSON. It also validates what was actually written.
 */
function validate(outDir: string, slugs: string[], log: (m: string) => void): Report {
  const counts: Record<string, number> = {};
  const findingCounts: Record<string, number> = {};
  const samples: Finding[] = [];

  const bump = (k: string, by = 1): void => {
    counts[k] = (counts[k] ?? 0) + by;
  };
  const finding = (kind: string, ecu: string, detail: string): void => {
    findingCounts[kind] = (findingCounts[kind] ?? 0) + 1;
    if (samples.length < 200) samples.push({ kind, ecu, detail });
  };

  log("validating cross-references…");

  for (const slug of slugs) {
    const ecu = JSON.parse(readFileSync(join(outDir, "ecu", `${slug}.json`), "utf8")) as EcuFileDef;
    let layout: LayoutFileDef;
    try {
      layout = JSON.parse(
        readFileSync(join(outDir, "layout", `${slug}.json`), "utf8"),
      ) as LayoutFileDef;
    } catch {
      finding("ecu without layout", slug, "");
      continue;
    }

    bump("ecus");
    const dataNames = new Set(Object.keys(ecu.data ?? {}));
    const requestNames = new Set((ecu.requests ?? []).map((r) => r.name));

    for (const req of ecu.requests ?? []) {
      bump("requests");
      for (const group of ["sendbyte_dataitems", "receivebyte_dataitems"] as const) {
        for (const name of Object.keys(req[group] ?? {})) {
          bump("dataitems");
          if (!dataNames.has(name)) {
            finding("dataitem names missing data", slug, `${req.name} → ${name}`);
          }
        }
      }
    }

    const screens = layout.screens ?? {};
    for (const [category, members] of Object.entries(layout.categories ?? {})) {
      for (const screen of members) {
        bump("categoryScreenRefs");
        if (screens[screen] === undefined) {
          finding("category names missing screen", slug, `${category} → ${screen}`);
        }
      }
    }

    for (const [screenName, screen] of Object.entries(screens)) {
      bump("screens");

      for (const kind of ["displays", "inputs"] as const) {
        for (const widget of screen[kind] ?? []) {
          bump(kind);
          if (!requestNames.has(widget.request)) {
            finding(`${kind} names missing request`, slug, `${screenName} → ${widget.request}`);
          } else if (widget.text === "") {
            // Decoration, not a binding: 1,421 of these exist and they render
            // as a static box with no value. Counted, never reported.
            bump("unboundDecorations");
          } else if (!dataNames.has(widget.text)) {
            finding(`${kind} names missing data`, slug, `${screenName} → ${widget.text}`);
          }
        }
      }

      for (const button of screen.buttons ?? []) {
        bump("buttons");
        if (button.send === undefined) {
          bump("buttonsWithoutSend");
          continue;
        }
        for (const entry of button.send) {
          bump("buttonSends");
          if (!requestNames.has(entry.RequestName)) {
            finding(
              "button send names missing request",
              slug,
              `${screenName} → ${entry.RequestName}`,
            );
          }
        }
      }

      for (const entry of screen.presend ?? []) {
        bump("presends");
        if (!requestNames.has(entry.RequestName)) {
          finding("presend names missing request", slug, `${screenName} → ${entry.RequestName}`);
        }
      }
    }
  }

  return { counts, findingCounts, samples };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Write the file, plus any pre-compressed siblings a static host can serve. */
function write(path: string, bytes: Uint8Array, encodings: ReadonlySet<string>): void {
  writeFileSync(path, bytes);
  if (encodings.has("gzip")) {
    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  }
  if (encodings.has("br")) {
    // Quality 11 over 543 MB of JSON takes minutes; opt in deliberately.
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    );
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

main();
