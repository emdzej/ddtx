/**
 * Is this archive, or this folder, actually the ECU database?
 *
 * Answering that **before** touching anything is the point. The importer clears the
 * installed tree before it starts writing, so without a pre-flight check the sequence
 * for a wrong file was: delete a working database, unpack whatever was in the zip, then
 * fail at the end with "db.json not found". The check that mattered ran after the damage.
 *
 * Enumerating a zip is cheap because fflate only inflates an entry when `start()` is
 * called on it. So the names of all 3,749 entries can be read without decompressing
 * 1.19 GB, and `db.json` — the one entry worth reading — is a few hundred KB.
 */

import { Unzip, UnzipInflate } from "fflate";

/**
 * Something wrong with the *structure*, and whether it stops the import.
 *
 * Distinct from `validate.ts`'s `Finding`, which is a dangling cross-reference inside
 * data that is otherwise fine. This one says the thing is not a database.
 */
export interface StructureFinding {
  severity: "error" | "warning";
  message: string;
}

export interface ArchiveReport {
  ok: boolean;
  findings: StructureFinding[];
  /** Entries seen, by kind. */
  counts: { entries: number; ecu: number; layout: number; graphics: number; other: number };
  /** ECUs the index declares, if `db.json` could be read. */
  indexed?: number;
}

/** A zip starts `PK\x03\x04`. An empty archive starts `PK\x05\x06`. */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Check an archive's structure without writing anything.
 *
 * Reads entry names and `db.json` only. On a 100 MB archive this is well under a
 * second, against ~11 s for the real import — cheap enough to always run first.
 */
export function inspectArchive(bytes: Uint8Array): ArchiveReport {
  const counts = { entries: 0, ecu: 0, layout: 0, graphics: 0, other: 0 };
  const findings: StructureFinding[] = [];

  if (!looksLikeZip(bytes)) {
    return {
      ok: false,
      findings: [
        {
          severity: "error",
          message:
            "This is not a zip archive — it does not start with a zip signature. " +
            "The database is distributed as `ecu.zip`.",
        },
      ],
      counts,
    };
  }

  let indexRaw: Uint8Array | null = null;
  const ecuNames = new Set<string>();
  const layoutNames = new Set<string>();

  try {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      counts.entries += 1;
      const name = file.name;

      if (name === "db.json") {
        // The only entry worth inflating: it is the index, and its absence is fatal.
        const chunks: Uint8Array[] = [];
        let total = 0;
        file.ondata = (err, chunk, final) => {
          if (err !== null) return;
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
            indexRaw = joined;
          }
        };
        file.start();
        return;
      }

      // Everything else: name only. Not calling `start()` is what keeps this cheap.
      if (name.startsWith("graphics/")) counts.graphics += 1;
      else if (name.endsWith(".json.layout")) {
        counts.layout += 1;
        layoutNames.add(name.slice(0, -".json.layout".length));
      } else if (name.endsWith(".json")) {
        counts.ecu += 1;
        ecuNames.add(name.slice(0, -".json".length));
      } else counts.other += 1;
    };

    // Same chunking as the splitter: a single push recurses once per entry and
    // overflows the stack on an archive this size.
    const CHUNK = 256 * 1024;
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const end = Math.min(at + CHUNK, bytes.length);
      unzip.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch (cause) {
    return {
      ok: false,
      findings: [
        {
          severity: "error",
          message: `The archive could not be read — it may be truncated or corrupt (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
        },
      ],
      counts,
    };
  }

  if (counts.entries === 0) {
    findings.push({ severity: "error", message: "The archive is empty." });
  }

  let indexed: number | undefined;
  if (indexRaw === null) {
    findings.push({
      severity: "error",
      message:
        "No `db.json` in the archive. That is the database index, so this is not an " +
        "ECU database — check it is `ecu.zip` and not some other archive.",
    });
  } else {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(indexRaw)) as Record<string, unknown>;
      indexed = Object.keys(parsed).length;
      if (indexed === 0) {
        findings.push({ severity: "error", message: "`db.json` declares no ECUs." });
      }
    } catch {
      findings.push({
        severity: "error",
        message: "`db.json` is not valid JSON, so the archive is corrupt.",
      });
    }
  }

  if (counts.ecu === 0) {
    findings.push({
      severity: "error",
      message: "The archive contains no ECU definition files.",
    });
  }

  // Every ECU should have a layout beside it. A mismatch is survivable — the loader
  // prunes what it cannot resolve — but it means an incomplete archive.
  if (counts.ecu > 0 && counts.layout === 0) {
    findings.push({
      severity: "error",
      message: `${counts.ecu} ECU file(s) but no layouts, so no screens could be drawn.`,
    });
  } else if (counts.ecu !== counts.layout) {
    findings.push({
      severity: "warning",
      message: `${counts.ecu} ECU file(s) against ${counts.layout} layout(s) — some ECUs will have no screens.`,
    });
  }

  if (indexed !== undefined && counts.ecu > 0) {
    const missing = [...ecuNames].filter((slug) => !layoutNames.has(slug)).length;
    if (missing > 0 && counts.ecu === counts.layout) {
      findings.push({
        severity: "warning",
        message: `${missing} ECU file(s) have no matching layout.`,
      });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    counts,
    ...(indexed === undefined ? {} : { indexed }),
  };
}

export interface TreeReport {
  ok: boolean;
  findings: StructureFinding[];
  /** ECUs the index declares. */
  indexed?: number;
  /** How many of the sampled slugs had both files present. */
  sampled?: { checked: number; missingEcu: number; missingLayout: number };
  manifest?: { name?: string; sha256?: string };
}

/** Reads a path relative to the tree root. Rejects if absent. */
export type ReadBytes = (path: string) => Promise<Uint8Array>;

/**
 * Check that a directory really holds a split tree, before adopting it.
 *
 * Cheap on purpose: the index plus a sample of ECUs, not all 1,580. A folder picker
 * hands back whatever the user clicked, and "Downloads" should be rejected in a moment
 * with a reason, not by failing on the first ECU they open half an hour later.
 */
export async function inspectTree(read: ReadBytes, sampleSize = 12): Promise<TreeReport> {
  const findings: StructureFinding[] = [];
  const decoder = new TextDecoder();

  let indexRaw: Uint8Array;
  try {
    indexRaw = await read("index.json");
  } catch {
    return {
      ok: false,
      findings: [
        {
          severity: "error",
          message:
            "No `index.json` here. Pick the folder that `db-split` wrote — the one " +
            "containing `index.json` beside `ecu/` and `layout/`.",
        },
      ],
    };
  }

  let slugs: string[] = [];
  let indexed: number | undefined;
  try {
    const index = JSON.parse(decoder.decode(indexRaw)) as {
      format?: number;
      ecus?: Record<string, unknown>;
    };
    if (index.ecus === undefined || typeof index.ecus !== "object") {
      findings.push({
        severity: "error",
        message: "`index.json` has no `ecus`, so it is not a split database index.",
      });
    } else {
      slugs = Object.keys(index.ecus);
      indexed = slugs.length;
      if (indexed === 0)
        findings.push({ severity: "error", message: "The index declares no ECUs." });
    }
    if (index.format !== undefined && index.format !== 1) {
      findings.push({
        severity: "warning",
        message: `The index says format ${String(index.format)}; this build expects 1.`,
      });
    }
  } catch {
    return {
      ok: false,
      findings: [{ severity: "error", message: "`index.json` is not valid JSON." }],
    };
  }

  // Spread the sample across the index rather than taking the first few, so a tree
  // whose import died half-way is caught.
  const step = Math.max(1, Math.floor(slugs.length / Math.max(1, sampleSize)));
  const sample = slugs.filter((_, i) => i % step === 0).slice(0, sampleSize);

  let missingEcu = 0;
  let missingLayout = 0;
  for (const slug of sample) {
    try {
      await read(`ecu/${slug}.json`);
    } catch {
      missingEcu += 1;
    }
    try {
      await read(`layout/${slug}.json`);
    } catch {
      missingLayout += 1;
    }
  }

  if (missingEcu === sample.length && sample.length > 0) {
    findings.push({
      severity: "error",
      message:
        "The index is here but no ECU files are — `ecu/` is missing or empty, so the " +
        "tree is incomplete.",
    });
  } else if (missingEcu > 0) {
    findings.push({
      severity: "error",
      message: `${missingEcu} of ${sample.length} sampled ECUs are missing their definition file.`,
    });
  }

  if (missingLayout > 0 && missingLayout < sample.length) {
    findings.push({
      severity: "warning",
      message: `${missingLayout} of ${sample.length} sampled ECUs are missing a layout.`,
    });
  } else if (missingLayout === sample.length && sample.length > 0) {
    findings.push({
      severity: "warning",
      message: "No layouts found, so no screens can be drawn.",
    });
  }

  let manifest: TreeReport["manifest"];
  try {
    const raw = JSON.parse(decoder.decode(await read("manifest.json"))) as {
      source?: { name?: string; sha256?: string };
    };
    manifest = { ...(raw.source ?? {}) };
  } catch {
    // Only the importer writes one; a CLI-produced tree read from a folder has it too,
    // but its absence is not a fault.
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    ...(indexed === undefined ? {} : { indexed }),
    sampled: { checked: sample.length, missingEcu, missingLayout },
    ...(manifest === undefined ? {} : { manifest }),
  };
}
