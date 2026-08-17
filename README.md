# ddtx

Browser-based Renault/Dacia/Nissan ECU diagnostics — a TypeScript port of
[DDT4All](https://github.com/cedricp/ddt4all) that runs entirely client-side
against an ELM327-family adapter over Web Serial.

Status: **demo mode works.** Browse all 1,580 ECUs and render any of their 39,665
screens, with values replayed from the database. Nothing talks to a vehicle yet —
that waits on the ELM327 driver.

- [`docs/plan.md`](docs/plan.md) — feasibility analysis, architecture, roadmap.
  Read this first; it records why each decision was made and what was measured.
- [`docs/i18n-overlay.md`](docs/i18n-overlay.md) — translation overlay design
  (the ECU database is in French and its strings double as primary keys).

## Running it

Put the ECU database at `data/ecu.zip`, then:

```sh
pnpm install
pnpm build
pnpm dev          # splits the database if needed, then serves the app
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Split the database if it isn't current, then run the browser client |
| `pnpm db:split` | Split `data/ecu.zip` into `data/tree`; skips if already current |
| `pnpm db:split:force` | Re-split unconditionally |
| `pnpm test` | Unit tests |
| `pnpm test:db` | Unit tests plus the full-database integration run (needs `data/tree`) |
| `pnpm typecheck` | Packages and the Svelte app |
| `pnpm check` | Build, typecheck, and the full test suite |
| `pnpm golden` | Regenerate codec vectors from the Python original (see `tools/golden`) |

The split tree is ~1.2 GB and lives under the git-ignored `data/`.

## Layout

```
data/          ecu.zip — the upstream ECU database (not committed)
               tree/   — the split static tree `db:split` writes (~1.2 GB)
docs/          design docs
packages/
  core         shared types for the database format
  codec        bit-field encode/decode — the port of ecu_data.py
  db           index, lazy loading, layout binding, autoident matching
  link         request/response channel; the simulated link behind demo mode
  screens      screen runtime and twips geometry
apps/
  web          browser client — catalogue, screens, bus trace
tools/
  db-split     ecu.zip → the static tree
  golden       differential codec vectors from the Python original
```

Still to come: `elm` (the ELM327 driver), `i18n` (the translation overlay), and a
Node CLI for bench-testing the driver without a browser.

## Licensing

The upstream DDT4All is **GPL-3.0-or-later**, and this is a derivative work, so
ddtx is GPL-3.0-or-later too. That has a consequence worth knowing up front:
ddtx **cannot depend on the `@emdzej/bimmerz-*` or `@emdzej/ediabasx-*`
packages** while they are licensed PolyForm Noncommercial — see
[`docs/plan.md`](docs/plan.md#licensing-constraint). Code is copied and adapted
rather than imported, deliberately.

The ECU database is not ours and is not distributed here.
