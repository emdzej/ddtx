/**
 * Is an installed tree structurally sound?
 *
 * Reads the index and samples ECUs across it, reporting anything missing or malformed.
 * This is the on-demand check in settings, for when something looks wrong later.
 *
 * There used to be an archive pass here too, run before an import so a bad zip could be
 * refused before 1.19 GB was written. The archive is no longer unpacked and
 * `archiveDbSource` refuses to open one it cannot read, so that check is now structural
 * rather than a pass someone has to remember to run.
 */


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
