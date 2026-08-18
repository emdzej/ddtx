#!/usr/bin/env node
/**
 * Collect every plugin's compiled module and manifest into the web app's `public/`,
 * and write the index the host reads at runtime.
 *
 * The host discovers plugins from `plugins/index.json`, so adding a plugin never means
 * editing host code — drop a folder under `packages/plugins/` and rebuild.
 *
 * Two checks happen here rather than at runtime, because both are mistakes a plugin
 * author makes once and should hear about immediately:
 *
 *  - **A module that declares imports is rejected.** Legit plugins compile with zero
 *    imports and instantiate against an empty `importObject`. A stray import means
 *    `asconfig.json` lost `runtime: "stub"` or `use: ["abort="]`, and the failure would
 *    otherwise be a `LinkError` in the browser, far from the cause.
 *  - **A manifest declaring a capability its code never uses** is only a warning, since
 *    over-declaring is untidy rather than unsafe — but under-declaring is caught at
 *    run time by the host, so it is worth saying which way round it is.
 */

import { mkdir, readdir, readFile, writeFile, copyFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pluginsDir = join(root, "packages", "plugins");
const outDir = join(root, "apps", "web", "public", "plugins");

/** Folders under `packages/plugins/` that are not plugins. */
const NOT_PLUGINS = new Set(["_sdk", "node_modules"]);

async function main() {
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && !NOT_PLUGINS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  // Cleared, so a removed plugin actually disappears instead of lingering in the
  // index from a previous build.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const index = [];
  let problems = 0;

  for (const name of names) {
    const dir = join(pluginsDir, name);
    const manifestPath = join(dir, "manifest.json");
    const wasmPath = join(dir, "build", "plugin.wasm");

    if (!existsSync(manifestPath)) {
      console.warn(`[plugins] ${name}: no manifest.json — skipped`);
      problems += 1;
      continue;
    }
    if (!existsSync(wasmPath)) {
      console.warn(`[plugins] ${name}: no build/plugin.wasm — did the build run?`);
      problems += 1;
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== name) {
      console.error(
        `[plugins] ${name}: manifest name is "${manifest.name}" — must match the folder`,
      );
      problems += 1;
      continue;
    }

    const bytes = await readFile(wasmPath);
    const declared = await declaredImports(bytes);
    if (declared.length > 0) {
      console.error(
        `[plugins] ${name}: module declares imports (${declared.join(", ")}). ` +
          `Legit plugins have none — check asconfig.json keeps runtime "stub" and use ["abort="].`,
      );
      problems += 1;
      continue;
    }

    const exported = await exportedNames(bytes);
    const missing = ["memory", "alloc", "start", "resume"].filter((n) => !exported.includes(n));
    if (missing.length > 0) {
      console.error(`[plugins] ${name}: module does not export ${missing.join(", ")}`);
      problems += 1;
      continue;
    }

    const dest = join(outDir, name);
    await mkdir(dest, { recursive: true });
    await copyFile(wasmPath, join(dest, "plugin.wasm"));
    await writeFile(
      join(dest, "manifest.json"),
      JSON.stringify({ ...manifest, wasm: `${name}/plugin.wasm` }, null, 2),
    );

    const size = (await stat(wasmPath)).size;
    const caps = (manifest.capabilities ?? []).join(",") || "none";
    console.log(`[plugins] ${name.padEnd(26)} ${(size / 1024).toFixed(1).padStart(6)} KB  ${caps}`);
    index.push({ name, manifest: `${name}/manifest.json` });
  }

  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2));
  console.log(`[plugins] wrote index.json with ${index.length} plugin(s)`);

  if (problems > 0) {
    console.error(`[plugins] ${problems} plugin(s) were not bundled`);
    process.exit(1);
  }
}

async function declaredImports(bytes) {
  const module = await WebAssembly.compile(bytes);
  return WebAssembly.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
}

async function exportedNames(bytes) {
  const module = await WebAssembly.compile(bytes);
  return WebAssembly.Module.exports(module).map((entry) => entry.name);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
