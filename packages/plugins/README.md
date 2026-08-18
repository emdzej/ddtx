# Plugins

One folder per plugin, compiled from AssemblyScript to WebAssembly. See
[`../../docs/plugins.md`](../../docs/plugins.md) for the ABI and why it is shaped this
way.

```
_sdk/assembly/host.ts    the plugin side of the command protocol, shared
<name>/manifest.json     name, label, category, ecu, capabilities, warning
<name>/asconfig.json     runtime "stub" + use ["abort="] — this is what keeps imports empty
<name>/assembly/index.ts alloc re-exported, plus start() and resume()
```

## Adding one

1. Copy `vin-crc/`. The `name` in `manifest.json` must match the folder — the bundler
   refuses a mismatch, because the index is keyed by folder and the host trusts the
   manifest.
2. Declare `capabilities` honestly. Under-declaring is caught at run time when the host
   refuses the command; over-declaring is merely untidy.
3. `pnpm plugins:build`. The host picks it up from `plugins/index.json` at runtime —
   there is no host code to edit.

## Zero imports is load-bearing

Every plugin compiles with no WebAssembly imports and instantiates against an empty
`importObject`. There is no host function for it to call, so it cannot reach the bus,
the DOM, or the network — by construction rather than by convention. Do not add
anything to `_sdk` that needs an import.

`tools/bundle-plugins.mjs` enforces this and fails the build on a module that declares
one. Verified against a module that deliberately imports `env.exfiltrate`, kept at
`tools/fixtures/declares-an-import.wasm`:

```
$ node -e 'const b=require("fs").readFileSync("tools/fixtures/declares-an-import.wasm");
  WebAssembly.compile(b).then(m=>console.log(WebAssembly.Module.imports(m)))'
[ { module: "env", name: "exfiltrate", kind: "function" } ]
```

Dropping that module into a plugin folder and running `pnpm plugins:build` produces:

```
[plugins] _probe: module declares imports (env.exfiltrate). Legit plugins have none…
[plugins] 1 plugin(s) were not bundled
```

and exits non-zero.

## Status of the ported procedures

`vin-crc` is pure arithmetic and verified: its raw CRC over `"123456789"` is `0x906E`,
the published check value for CRC-16/X-25.

The rest are procedures against real modules — airbag resets, EEPROM writes, card
programming — and **cannot be verified without a vehicle**. Their ECU slugs and request
names _are_ checked against the real database, so a typo fails at load rather than at a
car, but whether a sequence has its intended effect is unknown until someone runs it on
one. They are gated behind the write toggle and marked accordingly in the UI.
