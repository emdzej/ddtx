# ddtx

Browser-based Renault/Dacia/Nissan ECU diagnostics — a TypeScript port of
[DDT4All](https://github.com/cedricp/ddt4all) that runs entirely client-side
against an ELM327-family adapter over Web Serial.

**Live at [ddtx.emdzej.pl](https://ddtx.emdzej.pl/)** — it ships without the database,
so bring your own `ecu.zip` and it unpacks into the browser.

## Status: it reads a real vehicle

Verified on a Renault Master II over K-line KWP2000. The sweep identified four fitted
modules, matched two of them against the catalogue exactly, and read stored faults off
both the ABS and the engine ECU — two rear-right wheel faults and a brake switch on the
first, a glow plug relay and the same brake switch on the second. Two independent
modules agreeing on the brake switch is what a working decode looks like.

**Real ECU response time is p50 299 ms on the ABS and 885 ms on the airbag module**,
against 5.7 ms for the host↔adapter round trip. The ECU is 50–150× the link, which is
the answer to the question the whole port was hedged on: browser latency is noise.

What is **not** verified: nothing has been written to a vehicle. Writes are gated behind
an explicit toggle, an adapter lock and a confirmation, and the thirteen ported hardware
procedures are marked unverified because they are — airbag resets and EEPROM erases are
not things to test speculatively.

Demo mode remains the offline path: all 1,580 ECUs and 39,665 screens, values replayed
from the database, no adapter needed.

**Driving it is [`docs/user-guide.md`](docs/user-guide.md)** — the database, the
catalogue, reading a screen, fault codes, the write gates, and what to check when a
value looks wrong. Start there if you want to use ddtx rather than change it.

The rest of the documentation is in [`docs/`](docs/README.md):

- [`architecture.md`](docs/architecture.md) — how it works, following one value to
  the screen and one click to the bus. **Start here.**
- [`ecu-format.md`](docs/ecu-format.md) — reference for the ECU database format,
  measured over all 1,580 ECUs, including its quirks and data faults. No such
  reference exists upstream.
- [`protocols.md`](docs/protocols.md) — ISO-TP framing, the AT sequences and why,
  K-line init modes, and what a browser cannot reach.
- [`plan.md`](docs/plan.md) — why the port is shaped this way: feasibility,
  the reuse audit and its licensing conclusion, ranked risks, roadmap.
- [`database-install.md`](docs/database-install.md) — how the database gets into the
  browser: three sources behind one `read(path)`, and why the importer queues writes.
- [`plugins.md`](docs/plugins.md) — the WebAssembly plugin system: why a diagnostic
  procedure cannot use an image-filter ABI, and what is verified about the ports.
- [`i18n-overlay.md`](docs/i18n-overlay.md) — the translation overlay, and why the
  database's strings being its primary keys makes it non-obvious.

## Running it

```sh
pnpm install
pnpm build
pnpm dev          # builds the plugins, splits the database if present, serves the app
```

The ECU database is **not required to start**. Put it at `data/ecu.zip` and `pnpm dev`
splits it for you; without it the app opens its picker and you can install a `ecu.zip`
straight into the browser, which is what a deployed build does. See
[`docs/database-install.md`](docs/database-install.md).

| Script                | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`            | Split the database if it isn't current, then run the browser client    |
| `pnpm db:split`       | Split `data/ecu.zip` into `data/tree`; skips if already current        |
| `pnpm db:split:force` | Re-split unconditionally                                               |
| `pnpm test`           | Unit tests                                                             |
| `pnpm test:db`        | Unit tests plus the full-database integration run (needs `data/tree`)  |
| `pnpm typecheck`      | Packages and the Svelte app                                            |
| `pnpm check`          | Build, typecheck, and the full test suite                              |
| `pnpm plugins:build`  | Compile the WASM plugins and bundle them for the app                   |
| `pnpm golden`         | Regenerate codec vectors from the Python original (see `tools/golden`) |
| `pnpm i18n:build`     | Hash the authored translations into a runtime bundle                   |

The split tree is ~1.2 GB and lives under the git-ignored `data/`.

### On a vehicle

`ddtx checkup` is the read-only battery to start with — adapter, a sweep for fitted
modules, then per module its identity, real response timing, long-reply behaviour and
stored faults, in one report. It writes nothing: no clears, no actuations, and it filters
to read services so it cannot.

```sh
pnpm cli checkup --port /dev/tty.usbserial-10 --bus kline --vehicle x70
pnpm cli dtc     --port /dev/tty.usbserial-10 --ecu <slug>     # add --clear to erase
```

`--bus` matters: Master II is 15 K-line ECUs to 2 on CAN, so a CAN-only sweep finds
nothing on one. Anything irreversible stays a separate, explicit command.

## Layout

```
data/          ecu.zip — the upstream ECU database (not committed)
               tree/   — the split static tree `db:split` writes (~1.2 GB)
docs/          design docs
packages/
  core         shared types for the database format
  codec        bit-field encode/decode — the port of ecu_data.py
  db           index, lazy loading, layout binding, autoident matching
  dbimport     ecu.zip → the static tree; the same core for the CLI and the browser
  elm          ELM327 driver — AT layer, software ISO-TP, transports, mock
  link         request/response channel; the simulated link behind demo mode
  session      attach, write gates, DTCs, the autoident scanner, the plugin loop
  screens      screen runtime and twips geometry
  i18n         the translation overlay, resolved at the render boundary
  plugin-sdk   plugin manifest, command protocol, and WebAssembly ABI
  plugins/     one folder per plugin, AssemblyScript → WASM
apps/
  web          browser client — catalogue, screens, bus trace, procedures
  cli          ports, probe, bench, read, scan, dtc, screens
tools/
  db-split     the Node CLI around @ddtx/dbimport
  golden       differential codec vectors from the Python original
  i18n         extract, build and measure the translation overlay
  bundle-plugins.mjs        compiled plugins → the app's public/
  check-plugin-imports.mjs  asserts every plugin module imports nothing
```

## CI, Pages and releases

| Workflow      | Trigger             | What it does                                                                       |
| ------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `ci.yml`      | push to `main`, PRs | Build, typecheck, compile plugins, assert they import nothing, test, build the app |
| `pages.yml`   | push to `main`      | Deploy the app to GitHub Pages                                                     |
| `release.yml` | a `v*` tag          | Publish the app and plugin bundle as tarballs with checksums                       |

Three things about them are worth knowing:

**CI runs `pnpm test`, not `pnpm test:db`.** The database is not redistributable and
`data/` is git-ignored, so the tree-backed and browser suites have nothing to run
against and skip themselves. Everything that needs neither still runs — the codec
against its golden vectors, the driver against its mock, the plugin loop, and every
compiled plugin module.

**The deployed site ships no database, deliberately.** A visitor installs their own
`ecu.zip` into their browser. The VIN CRC calculator works before they do, because it
needs neither a vehicle nor a database.

**A build cannot be relocated after the fact.** `BASE_PATH` is baked into the bundle, so
where the site will live has to be known when it is built. The Pages workflow reads
`apps/web/public/CNAME`: present means a custom domain and a root build, absent means
`<user>.github.io/<repo>/`. That is the same file GitHub reads to keep the domain
attached, so there is one fact in one place.

Getting it wrong fails in an unhelpful way — `index.html` still returns 200 and every
asset 404s — which is exactly what shipping a `/ddtx/` build to a root domain did. The
workflow now asserts the emitted asset paths match the base it chose.

Release tarballs are built for a domain root; to self-host under a prefix, rebuild with
`BASE_PATH=/prefix/`.

## Licensing

The upstream DDT4All is **GPL-3.0-or-later**, and this is a derivative work, so
ddtx is GPL-3.0-or-later too. That has a consequence worth knowing up front:
ddtx **cannot depend on the `@emdzej/bimmerz-*` or `@emdzej/ediabasx-*`
packages** while they are licensed PolyForm Noncommercial — see
[`docs/plan.md`](docs/plan.md#licensing-constraint). Code is copied and adapted
rather than imported, deliberately.

The ECU database is not ours and is not distributed here.
