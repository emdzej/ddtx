#!/usr/bin/env node
/**
 * Assert that every compiled plugin module declares no WebAssembly imports.
 *
 * This is the one property the plugin sandbox rests on: a module with no imports
 * instantiates against an empty `importObject`, so there is no host function for it to
 * call — it cannot reach the bus, the DOM, or the network, by construction rather than by
 * convention. See docs/plugins.md §2.
 *
 * `tools/bundle-plugins.mjs` already refuses such a module, and the test suite asserts it
 * too. This exists as a standalone check so it can be a named step in CI and a one-liner
 * locally, rather than something you only find out about via a bundler warning:
 *
 *   node tools/check-plugin-imports.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "packages", "plugins");

let checked = 0;
const offenders = [];

for (const name of readdirSync(pluginsDir)) {
  // `_sdk` is shared source, not a plugin.
  if (name.startsWith("_") || name === "node_modules") continue;
  const wasm = join(pluginsDir, name, "build", "plugin.wasm");
  if (!existsSync(wasm)) continue;

  checked += 1;
  const module = await WebAssembly.compile(readFileSync(wasm));
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
  if (imports.length > 0) offenders.push(`${name}: ${imports.join(", ")}`);
}

if (checked === 0) {
  console.error("check-plugin-imports: no compiled modules found — run `pnpm plugins:build`");
  process.exit(1);
}

for (const offender of offenders) {
  console.error(`check-plugin-imports: ${offender}`);
}

console.log(`check-plugin-imports: ${checked} module(s), ${offenders.length} with imports`);
if (offenders.length > 0) {
  console.error(
    "Legit plugins declare nothing. Check asconfig.json still has runtime \"stub\" and use [\"abort=\"].",
  );
  process.exit(1);
}
