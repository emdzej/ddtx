/**
 * Every plugin's ECU slug and request names, checked against the real database.
 *
 * This is the only correctness check available for a procedure that cannot be run
 * without a vehicle, and it is a real one: a plugin naming a request that does not exist
 * would otherwise fail at a car, mid-sequence, after a session had already been opened.
 * Here it fails on a laptop.
 *
 * It works by *running* each plugin against a host that answers everything with success,
 * collecting the request names it asks for, and then looking every one of them up. That
 * is better than parsing the AssemblyScript for string literals: it sees the names the
 * plugin actually emits, including ones built by concatenation — the Zoe counters are
 * `"DataRead." + LOW`, which no literal scan would catch.
 *
 * Opt-in on two counts: it needs a built tree and built plugins.
 *
 *   pnpm plugins:build
 *   DDTX_DB_TREE=data/tree pnpm test
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginExports, PluginManifest } from "@ddtx/plugin-sdk";
import { runPlugin, type PluginHost } from "./plugin.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginsDir = join(repoRoot, "packages", "plugins");
const treeDir = process.env.DDTX_DB_TREE;

interface Built {
  name: string;
  manifest: PluginManifest;
  wasm: Uint8Array;
}

function built(): Built[] {
  if (!existsSync(pluginsDir)) return [];
  const out: Built[] = [];
  for (const name of readdirSync(pluginsDir)) {
    if (name.startsWith("_") || name === "node_modules") continue;
    const manifestPath = join(pluginsDir, name, "manifest.json");
    const wasmPath = join(pluginsDir, name, "build", "plugin.wasm");
    if (!existsSync(manifestPath) || !existsSync(wasmPath)) continue;
    out.push({
      name,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest,
      wasm: new Uint8Array(readFileSync(wasmPath)),
    });
  }
  return out;
}

const plugins = built();
const treeReady =
  treeDir !== undefined && existsSync(join(treeDir, "index.json")) && plugins.length > 0;

/** Walk a plugin and collect every request name it asks for. */
async function requestsUsed(plugin: Built): Promise<{ names: Set<string>; caps: Set<string> }> {
  const module = await WebAssembly.compile(plugin.wasm.slice().buffer as ArrayBuffer);
  const exports = (await WebAssembly.instantiate(module, {})).exports as unknown as PluginExports;

  const names = new Set<string>();
  const caps = new Set<string>();
  // Answers everything, so the plugin walks its whole happy path rather than bailing at
  // the first step. `ask` returns a plausible 17-character VIN because the VIN writer
  // refuses anything else and would stop before naming its request.
  const host: PluginHost = {
    session: async () => ({ ok: true }),
    read: async () => ({ ok: true, values: {} }),
    write: async () => ({ ok: true }),
    log: () => undefined,
    ask: async () => "VF1KW09B540123456",
  };

  await runPlugin(plugin.manifest, exports, host, {
    onCommand: (command) => {
      caps.add(command.op);
      if (command.op === "session" || command.op === "read" || command.op === "write") {
        names.add(command.request);
      }
    },
  });
  return { names, caps };
}

describe.skipIf(plugins.length === 0)("plugin manifests", () => {
  it("declares a category, a label, and a warning wherever it can write", () => {
    for (const { name, manifest } of plugins) {
      expect(manifest.label, name).toBeTruthy();
      expect(manifest.category, name).toBeTruthy();
      if (manifest.capabilities.includes("write")) {
        // The confirmation shows this verbatim. A write with nothing to say about
        // itself would confirm with a generic prompt, which is how people click
        // through things they should have read.
        expect(manifest.warning, `${name} can write and must carry a warning`).toBeTruthy();
      }
    }
  });

  it("names an ECU whenever it reads or writes", () => {
    for (const { name, manifest } of plugins) {
      const touchesBus =
        manifest.capabilities.includes("read") || manifest.capabilities.includes("write");
      if (touchesBus) expect(manifest.ecu, `${name} touches the bus`).toBeTruthy();
    }
  });

  it("uses only capabilities it declares", async () => {
    for (const plugin of plugins) {
      const { caps } = await requestsUsed(plugin);
      const declared = new Set(plugin.manifest.capabilities);
      const used = [...caps].filter((op) => op !== "log" && op !== "done");
      for (const op of used) {
        // Under-declaring is caught at run time by the host refusing the command, which
        // aborts a procedure part-way. Catching it here means it never ships.
        expect(declared.has(op as never), `${plugin.name} uses ${op} without declaring it`).toBe(
          true,
        );
      }
    }
  });
});

describe.skipIf(!treeReady)("plugins against the real database", () => {
  it("names an ECU that exists, and requests that ECU actually defines", async () => {
    const index = JSON.parse(readFileSync(join(treeDir as string, "index.json"), "utf8")) as {
      ecus: Record<string, unknown>;
    };

    const problems: string[] = [];
    let checkedPlugins = 0;
    let checkedRequests = 0;

    for (const plugin of plugins) {
      const slug = plugin.manifest.ecu;
      const { names } = await requestsUsed(plugin);

      if (slug === undefined) {
        // No ECU means it must not have asked for one. `vin-crc` is the only such case.
        if (names.size > 0) {
          problems.push(`${plugin.name}: names no ECU but asks for ${[...names].join(", ")}`);
        }
        continue;
      }

      checkedPlugins += 1;
      if (index.ecus[slug] === undefined) {
        problems.push(`${plugin.name}: ECU "${slug}" is not in the database`);
        continue;
      }

      const ecu = JSON.parse(
        readFileSync(join(treeDir as string, "ecu", `${slug}.json`), "utf8"),
      ) as { requests?: Array<{ name: string }> };
      const defined = new Set((ecu.requests ?? []).map((request) => request.name));

      for (const name of names) {
        checkedRequests += 1;
        if (!defined.has(name)) {
          problems.push(`${plugin.name}: "${slug}" has no request named "${name}"`);
        }
      }
    }

    console.log(
      `checked ${checkedPlugins} plugin(s) against the database, ${checkedRequests} request name(s)`,
    );
    expect(problems).toEqual([]);
    // A guard against this passing vacuously if `requestsUsed` ever stops walking.
    expect(checkedRequests).toBeGreaterThan(30);
  }, 120_000);
});
