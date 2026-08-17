/**
 * Differential test against the original DDT4All Python codec.
 *
 * Vectors are produced by `tools/golden/generate.py`, which runs the real
 * `ecu_data.py`. A mismatch here means the port diverges from what the ECU
 * database was authored against — which shows up in the field as plausible but
 * wrong values on screen, so these are hard failures, not warnings.
 *
 * `synthetic.json` is committed. `db.json` is derived from real ECU files and
 * is not, so its block skips when absent (see docs/plan.md §6.4). Regenerate:
 *
 *   PYTHONPATH=<stub>:<ddt4all>/src \
 *     python3 tools/golden/generate.py tools/golden/vectors data/ecu.zip
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DataDef, DataItemDef, Endianness } from "@ddtx/core";
import { getDisplayValue, getHexValue, resolveData, setValue } from "./ecuData.js";

interface DecodeVector {
  data: DataDef;
  item: DataItemDef;
  endian: Endianness | null;
  resp: string;
  hex?: string | null;
  display?: string | null;
  /** Python raised; the port must return null instead. */
  raises?: boolean;
}

interface EncodeVector {
  data: DataDef;
  item: DataItemDef;
  endian: Endianness | null;
  value: string | string[];
  bytes: string[];
  result?: string[] | null;
  raises?: boolean;
}

interface VectorFile {
  decode: DecodeVector[];
  encode: EncodeVector[];
}

const vectorDir = join(dirname(fileURLToPath(import.meta.url)), "../../../tools/golden/vectors");

function load(name: string): VectorFile | null {
  const path = join(vectorDir, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as VectorFile;
}

/** Compact label so a failure names the exact geometry that broke. */
function describeVector(v: DecodeVector | EncodeVector): string {
  const d = v.data;
  const bits = `${d.bitscount ?? 8}b@${v.item.firstbyte ?? 0}+${v.item.bitoffset ?? 0}`;
  const flags = [
    d.scaled && "scaled",
    d.signed && "signed",
    d.bytesascii && "ascii",
    d.lists && "lists",
    v.endian ?? "noEndian",
    v.item.endian && `item:${v.item.endian}`,
  ]
    .filter(Boolean)
    .join(",");
  return `${bits} ${flags}`;
}

function runDecode(vectors: DecodeVector[]): void {
  const failures: string[] = [];

  for (const v of vectors) {
    const data = resolveData(v.data, "t");
    const endian = v.endian ?? undefined;

    let hex: string | null;
    let display: string | null;
    try {
      hex = getHexValue(data, v.item, endian, v.resp);
      display = getDisplayValue(data, v.item, endian, v.resp);
    } catch (error) {
      failures.push(`threw on ${describeVector(v)} resp=${JSON.stringify(v.resp)}: ${error}`);
      continue;
    }

    if (v.raises) {
      // Documented divergence: Python dies, we fail closed.
      if (hex !== null || display !== null) {
        failures.push(
          `${describeVector(v)}: python raised, port returned hex=${JSON.stringify(hex)} display=${JSON.stringify(display)}`,
        );
      }
      continue;
    }

    if (hex !== v.hex) {
      failures.push(
        `${describeVector(v)} resp=${JSON.stringify(v.resp)}: hex ${JSON.stringify(hex)} != ${JSON.stringify(v.hex)}`,
      );
    }
    if (display !== v.display) {
      failures.push(
        `${describeVector(v)} resp=${JSON.stringify(v.resp)}: display ${JSON.stringify(display)} != ${JSON.stringify(v.display)}`,
      );
    }
  }

  // Report a bounded sample rather than 25k lines of diff.
  expect(failures.slice(0, 20).join("\n"), `${failures.length} mismatches`).toBe("");
}

function runEncode(vectors: EncodeVector[]): void {
  const failures: string[] = [];

  for (const v of vectors) {
    const data = resolveData(v.data, "t");
    const endian = v.endian ?? undefined;
    const work = [...v.bytes];

    let result: string[] | null;
    try {
      result = setValue(data, v.item, endian, v.value, work);
    } catch (error) {
      failures.push(`threw on ${describeVector(v)} value=${JSON.stringify(v.value)}: ${error}`);
      continue;
    }

    if (v.raises) {
      if (result !== null) {
        failures.push(
          `${describeVector(v)} value=${JSON.stringify(v.value)}: python raised, port returned ${JSON.stringify(result)}`,
        );
      }
      continue;
    }

    const expected = v.result ?? null;
    const actual = result === null ? null : [...result];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${describeVector(v)} value=${JSON.stringify(v.value)} into ${JSON.stringify(v.bytes)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
    }
  }

  expect(failures.slice(0, 20).join("\n"), `${failures.length} mismatches`).toBe("");
}

describe("golden vectors — synthetic", () => {
  const vectors = load("synthetic.json");

  it("vector file is present", () => {
    expect(vectors, "run tools/golden/generate.py to produce it").not.toBeNull();
  });

  it("decodes identically to the Python original", () => {
    if (!vectors) return;
    expect(vectors.decode.length).toBeGreaterThan(1000);
    runDecode(vectors.decode);
  });

  it("encodes identically to the Python original", () => {
    if (!vectors) return;
    expect(vectors.encode.length).toBeGreaterThan(1000);
    runEncode(vectors.encode);
  });
});

describe("golden vectors — real database", () => {
  const vectors = load("db.json");

  it.skipIf(vectors === null)("decodes every sampled real field identically", () => {
    if (!vectors) return;
    runDecode(vectors.decode);
  });
});
