/**
 * The real compiled modules, driven through the real runner.
 *
 * `plugin.test.ts` scripts a plugin in TypeScript, which tests the loop. This tests the
 * whole chain: AssemblyScript source → `asc` → WebAssembly → the length-prefixed wire
 * format → `runPlugin`. A mismatch between the plugin side of the protocol (`_sdk`'s
 * `emit`) and the host side (`readPrefixed`) shows up here and nowhere else, and it
 * would not throw — it would read garbage.
 *
 * Also asserts the property the sandbox rests on: **no module declares an import.**
 * That is checked at bundle time too, but a build-time check can be bypassed by running
 * the app from a stale `public/`, so it is worth asserting where it cannot be skipped.
 *
 * Needs `pnpm plugins:build`; skips without it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginExports, PluginManifest } from "@ddtx/plugin-sdk";
import { runPlugin, type PluginHost } from "./plugin.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginsDir = join(repoRoot, "packages", "plugins");

/** Every plugin folder that has been built. */
function built(): Array<{ name: string; manifest: PluginManifest; wasm: Uint8Array }> {
  if (!existsSync(pluginsDir)) return [];
  const out: Array<{ name: string; manifest: PluginManifest; wasm: Uint8Array }> = [];
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

async function instantiate(wasm: Uint8Array): Promise<PluginExports> {
  const module = await compile(wasm);
  // Empty importObject. A module declaring anything throws LinkError right here, which
  // is the sandbox catching it without any host-level check at all.
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as PluginExports;
}

/**
 * `WebAssembly.compile` wants a buffer whose backing store cannot be shared, and
 * `readFileSync`'s Buffer is typed loosely enough to fail that. Copying is cheap here —
 * the modules are a few KB.
 */
function compile(wasm: Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(wasm.slice().buffer as ArrayBuffer);
}

function silentHost(overrides: Partial<PluginHost> = {}): PluginHost {
  return {
    session: async () => ({ ok: true }),
    read: async () => ({ ok: true, values: {} }),
    write: async () => ({ ok: true }),
    log: () => undefined,
    ask: async () => "",
    ...overrides,
  };
}

describe.skipIf(plugins.length === 0)("compiled plugins", () => {
  it("declares no WebAssembly imports", async () => {
    for (const plugin of plugins) {
      const module = await compile(plugin.wasm);
      const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
      expect(imports, `${plugin.name} must import nothing`).toEqual([]);
    }
  });

  it("exports the whole ABI and nothing is missing", async () => {
    for (const plugin of plugins) {
      const exports = await instantiate(plugin.wasm);
      expect(typeof exports.alloc, plugin.name).toBe("function");
      expect(typeof exports.start, plugin.name).toBe("function");
      expect(typeof exports.resume, plugin.name).toBe("function");
      expect(exports.memory, plugin.name).toBeInstanceOf(WebAssembly.Memory);
    }
  });

  it("emits a readable first command", async () => {
    // The narrowest test of the wire format: if `emit` and `readPrefixed` disagree on
    // the prefix, this is where it surfaces.
    for (const plugin of plugins) {
      const exports = await instantiate(plugin.wasm);
      const seen: string[] = [];
      await runPlugin(plugin.manifest, exports, silentHost(), {
        maxSteps: 1,
        onCommand: (command) => seen.push(command.op),
      });
      expect(seen.length, `${plugin.name} emitted no command`).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!plugins.some((p) => p.name === "vin-crc"))("vin-crc", () => {
  const plugin = plugins.find((p) => p.name === "vin-crc") as (typeof plugins)[number];

  async function crcFor(vin: string): Promise<string> {
    const exports = await instantiate(plugin.wasm);
    const outcome = await runPlugin(plugin.manifest, exports, silentHost({ ask: async () => vin }));
    return outcome.text;
  }

  it("matches the published CRC-16/X-25 check value", async () => {
    // 0x906E over "123456789" is the algorithm's own check constant, so this pins the
    // implementation against the specification rather than against itself.
    expect(await crcFor("123456789")).toContain("raw 906E");
  });

  it("reports the CRC byte-swapped, as the original does", async () => {
    // `vin_crc.py` returns `crcle[2:4] + crcle[0:2]` with the comment "Seems that
    // computed CRC is returned in little endian way". The swap is part of the answer:
    // the bytes go into a VIN-write request in that order.
    const text = await crcFor("123456789");
    expect(text).toContain("CRC 6E90");
  });

  it("agrees with an independent implementation on a real VIN", async () => {
    expect(await crcFor("VF1KW09B540123456")).toContain("raw 8B10");
  });

  it("needs no vehicle: it declares neither read nor write", () => {
    expect(plugin.manifest.capabilities).not.toContain("read");
    expect(plugin.manifest.capabilities).not.toContain("write");
    expect(plugin.manifest.ecu).toBeUndefined();
  });

  it("fails cleanly when the operator declines", async () => {
    const exports = await instantiate(plugin.wasm);
    const outcome = await runPlugin(
      plugin.manifest,
      exports,
      silentHost({ ask: async () => null }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.text).toMatch(/No VIN/);
  });
});
