# ddtx

Browser-based Renault/Dacia/Nissan ECU diagnostics — a TypeScript port of
[DDT4All](https://github.com/cedricp/ddt4all) that runs entirely client-side
against an ELM327-family adapter over Web Serial.

Status: **planning / phase 1 (codec port)**. Nothing works yet.

- [`docs/plan.md`](docs/plan.md) — feasibility analysis, architecture, roadmap.
  Read this first; it records why each decision was made and what was measured.
- [`docs/i18n-overlay.md`](docs/i18n-overlay.md) — translation overlay design
  (the ECU database is in French and its strings double as primary keys).

## Layout

```
data/            ecu.zip — the upstream ECU database (not committed; 100 MB)
docs/            design docs
packages/        (phase 1+) core, codec, db, elm, session, screens, web-ui
apps/            (phase 3+) web SPA, node CLI for bench testing
tools/           (phase 1) db-split, golden-vector generation
```

## Licensing

The upstream DDT4All is **GPL-3.0-or-later**, and this is a derivative work, so
ddtx is GPL-3.0-or-later too. That has a consequence worth knowing up front:
ddtx **cannot depend on the `@emdzej/bimmerz-*` or `@emdzej/ediabasx-*`
packages** while they are licensed PolyForm Noncommercial — see
[`docs/plan.md`](docs/plan.md#licensing-constraint). Code is copied and adapted
rather than imported, deliberately.

The ECU database is not ours and is not distributed here.
