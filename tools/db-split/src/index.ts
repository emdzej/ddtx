#!/usr/bin/env node
/**
 * Split `ecu.zip` into the static tree the web app fetches.
 *
 * The splitting itself lives in `@ddtx/dbimport`, because the browser does it too and
 * two implementations of that would drift. What is left here is everything that is
 * genuinely Node's: reading the archive off disk, writing files, pre-compressing them
 * for a static host, and hashing the source so a re-run can be skipped.
 *
 * Usage:
 *   db-split <ecu.zip> <outdir> [--if-needed] [--compress=gzip[,br]] [--quiet]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { splitArchive, validateTree, type SplitSink } from "@ddtx/dbimport";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const zipPath = positional[0];
  const outDir = positional[1];

  if (zipPath === undefined || outDir === undefined) {
    console.error(
      "usage: db-split <ecu.zip> <outdir> [--if-needed] [--compress=gzip[,br]] [--quiet]",
    );
    process.exit(2);
  }

  const quiet = args.includes("--quiet");

  // `--if-needed` makes this safe to put in front of `dev`: splitting rewrites
  // 1.19 GB and takes ~15 s, so it should happen once per snapshot, not once per
  // run. The manifest records the source hash, which is what "same snapshot"
  // means — a mtime check would miss a rebuilt zip with identical timestamps.
  if (args.includes("--if-needed") && isUpToDate(zipPath, outDir)) {
    if (!quiet) console.log(`database tree in ${outDir} is current — skipping`);
    return;
  }

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

  log(`reading ${basename(zipPath)} (${fmtBytes(statSync(zipPath).size)})`);
  const zipBytes = readFileSync(zipPath);
  const sourceHash = createHash("sha256").update(zipBytes).digest("hex");

  const sink: SplitSink = {
    mkdir: (path) => {
      mkdirSync(join(outDir, path), { recursive: true });
    },
    write: (path, bytes) => write(join(outDir, path), bytes, encodings),
    log,
  };

  const result = await splitArchive(zipBytes, sink);
  log(`  wrote ${fmtBytes(Object.values(result.bytesOut).reduce((a, b) => a + b, 0))}`);

  const report = validateTree(
    result.ecuSlugs,
    (path) => readFileSync(join(outDir, path), "utf8"),
    log,
  );
  report.counts.indexedButNoFile = result.counts.indexedButNoFile;
  report.counts.fileButNotIndexed = result.counts.fileButNotIndexed;
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1));

  const manifest = {
    format: 1,
    source: { name: basename(zipPath), bytes: zipBytes.length, sha256: sourceHash },
    counts: {
      ecus: result.counts.ecus,
      layouts: result.counts.layouts,
      indexed: result.counts.indexed,
      graphicsSkipped: result.counts.graphicsSkipped,
    },
    bytes: result.bytesOut,
    encodings: [...encodings],
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));

  log("\nintegrity:");
  for (const [kind, count] of Object.entries(report.findingCounts).sort((a, b) => b[1] - a[1])) {
    log(`  ${kind.padEnd(34)} ${String(count).padStart(8)}`);
  }
  if (result.counts.indexedButNoFile > 0) {
    log(`  indexed but no file                 ${result.counts.indexedButNoFile}`);
  }
  if (result.counts.fileButNotIndexed > 0) {
    log(`  file but not indexed               ${result.counts.fileButNotIndexed}`);
  }
  log(`\nwrote ${outDir}`);
}

/**
 * Has this exact archive already been split into this directory?
 *
 * Compares the source SHA-256 recorded in `manifest.json` against the archive on
 * disk, and confirms the index the app loads first is actually present — a run
 * killed part-way leaves a manifest-less tree, and a stale manifest with no index
 * would be worse than no manifest at all.
 */
function isUpToDate(zipPath: string, outDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      source?: { sha256?: string };
    };
    if (manifest.source?.sha256 === undefined) return false;
    if (!statSync(join(outDir, "index.json")).isFile()) return false;
    const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    return actual === manifest.source.sha256;
  } catch {
    return false;
  }
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
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

await main();
