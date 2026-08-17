/**
 * The Python builder and the TypeScript runtime must agree on every key.
 *
 * `tools/i18n/extract.py` hashes the authored source strings into bundle keys, and
 * `Overlay` hashes the strings it sees at render time to look them up. If those two
 * ever disagree — a different digest, a different truncation length, NFC applied on
 * one side only — nothing throws. Every translation just silently stops resolving
 * and the UI quietly falls back to French, which is the worst possible failure
 * because it looks like missing work rather than a bug.
 *
 * So this reads the real built bundle and checks the TS side can find what the
 * Python side wrote. It skips when the bundle hasn't been built.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { digest } from "./keys.js";
import { Overlay } from "./overlay.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceDir = join(repoRoot, "i18n/source/en");
const bundlePath = join(repoRoot, "i18n/en/bundle.json");
const available = existsSync(bundlePath) && existsSync(sourceDir);

describe.skipIf(!available)("Python builder / TypeScript runtime key parity", () => {
  it("finds every authored translation through the runtime's own hashing", async () => {
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, string>;
    const overlay = Overlay.create("en", bundle);

    const namespaces = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    expect(namespaces.length).toBeGreaterThan(0);

    const missing: string[] = [];
    const wrong: string[] = [];
    let checked = 0;

    for (const namespace of namespaces) {
      const authored = JSON.parse(
        readFileSync(join(sourceDir, `${namespace}.json`), "utf8"),
      ) as Record<string, string>;

      const sources = Object.keys(authored).filter(
        // `_`-prefixed keys are notes to the next translator; the builder skips them.
        (source) => !source.startsWith("_") && authored[source]?.trim() !== "",
      );
      await overlay.prime(sources);

      for (const source of sources) {
        checked += 1;
        const expectedKey = `${namespace}:${await digest(source)}`;
        if (bundle[expectedKey] === undefined) {
          missing.push(`${namespace}: ${JSON.stringify(source)}`);
          continue;
        }
        const resolved = overlay.t(namespace as never, source);
        if (resolved !== authored[source]) {
          wrong.push(`${namespace}: ${JSON.stringify(source)} → ${JSON.stringify(resolved)}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(100);
    expect(missing.slice(0, 10).join("\n"), `${missing.length} keys absent from the bundle`).toBe(
      "",
    );
    expect(wrong.slice(0, 10).join("\n"), `${wrong.length} keys resolved to the wrong text`).toBe(
      "",
    );
  });

  it("agrees on a string containing a combining accent", async () => {
    // The database mixes composed and decomposed forms. Both sides normalise to
    // NFC, so a decomposed source must hash to the composed key.
    const composed = "Régime moteur"; // é
    const decomposed = "Régime moteur"; // e + combining acute
    expect(await digest(decomposed)).toBe(await digest(composed));
  });
});
