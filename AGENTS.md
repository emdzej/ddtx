# Working on ddtx

Notes for anyone — human or agent — changing this repository. Conventions only, and
mostly ones learned by getting them wrong. For how the system works, read
[`docs/architecture.md`](docs/architecture.md); for the format, read
[`docs/ecu-format.md`](docs/ecu-format.md).

This is a browser diagnostics tool that writes to real vehicle control units. A wrong
byte on a real car is not recoverable by reverting a commit.

## Before you finish

```sh
pnpm typecheck      # NOT `npx svelte-check` — see below
pnpm test
pnpm i18n:check     # if you touched any user-facing string
```

`pnpm typecheck` is two things: `turbo run typecheck` (13 packages, via `tsc`) **and**
`apps/web` separately, because the web app type-checks through `svelte-check` against
its own tsconfig — 352 files, none of which the package-level pass sees. A missing
import once passed the package check and crashed at runtime. Do not substitute one for
the other, and do not reach for `npx svelte-check` at the root: it finds one file.

`pnpm check` is build + typecheck + `test:db`, and `test:db` needs `data/tree`.

## Tests

| | |
| --- | --- |
| **Unit** — 25 files | `pnpm test`. Node environment, no browser. These gate CI |
| **Browser e2e** — 7 files, `*.e2e.test.ts` | Playwright (`playwright-core`) driven by vitest. **Opt-in, and skipped in CI** |
| **Database integration** | `pnpm test:db`, needs `data/tree`. Skipped without it |

There is no separate Playwright runner, config, or `@playwright/test` — the e2e files
launch `chromium` from `playwright-core` themselves and locate a browser out of the
Playwright cache. Keep it that way; a second test framework is not worth it.

**`pnpm test` passing does not mean the UI works.** Every e2e file is
`describe.skipIf(!runnable)`, and `runnable` needs a dev server plus a Chromium binary,
so all 12 browser tests skip in CI and skip for you unless you do this:

```sh
pnpm dev                                       # one terminal
DDTX_E2E_URL=http://localhost:5173 pnpm test   # another
```

Five of the seven also need the ECU database, because they point the app at the dev
server's tree. See **Known gaps** below.

### Verify a test by breaking it

A test that has never failed has not been shown to work. Change the code (or the
fixture) so the bug it describes is present, watch it fail with a message that names the
problem, then restore. This session found two flaws in a checker that way — a duplicated
error and a percentage that rounded 228/229 up to "100%".

Two specific traps, both of which have bitten here:

- **Pick an oracle that can observe the thing.** Scrollbar width reserves nothing in
  headless Chromium whether the scrollbars are overlay or not, so a width assertion
  passes and fails for the wrong reasons. That check asserts the CSS cause instead.
- **Never chain a commit after a test run without gating on the result.** `pnpm test &&
  git commit` — a commit landed here with a failing test because the two were sent
  together.

## Measure, do not estimate

Sizes, widths, and timings in this repo are measured numbers, and the commit messages
quote them. Bundle cost, strip width budgets, ECU response latency, import duration —
run it and read the number. Guessing produced a "5.7 ms" claim that was counting
non-hex characters.

## Two translation systems, never mixed

| | |
| --- | --- |
| `t("data", …)` from `state.svelte.ts` | The **database**. Keyed by the source French string, resolved only at the render boundary |
| `ui("strip.readNow")` from `lib/ui.svelte.ts` | The **interface**. i18next, JSON catalogues in `apps/web/src/i18n/locales/` |

**The database's strings are its primary keys.** `data{}` is keyed by the French label
and a widget's `text` field is a lookup into it, so rewriting one dangles every
reference. Worse, enum labels are looked *back* up to recover the integer on write — a
translated label sends the wrong byte to a real vehicle, and no read-only test catches
it. Reference resolution never goes through `t()`.

Adding an interface string: put it in `en.json`, translate it in every other locale,
`pnpm i18n:check`. Errors fail CI; coverage and dead keys are warnings. Anything a user
reads goes through `ui()`, including strings built in `state.svelte.ts`.

## Things that are the way they are on purpose

- **`firstbyte` is 1-based and byte 1 is the response SID.** The easiest off-by-one in
  the project and invisible until a reading is subtly wrong.
- **The codec is a literal translation of the Python, quirks included.** Do not tidy it
  without re-running the golden vectors.
- **An empty widget caption is a decoration, not a broken reference.** 1,421 of them.
- **Write gates are tested for what they refuse.** A gate that fails open is worse than
  no gate, because the UI then claims protection that is not there.
- **Plugins compile to WebAssembly with zero imports.** `tools/check-plugin-imports.mjs`
  asserts it as its own CI step. That property is the sandbox.

## Repository facts

- **GPL-3.0-or-later**, because DDT4All is. It therefore **cannot depend on** the
  `@emdzej/bimmerz-*` or `@emdzej/ediabasx-*` packages while they are PolyForm
  Noncommercial — copy and adapt, never import. See
  [`docs/plan.md`](docs/plan.md#licensing-constraint).
- **The ECU database is not ours and is not committed.** `data/` is git-ignored. Never
  add a fixture derived from it, and never paste a VIN into a commit, test, or doc.
- **Release tags carry no `v` prefix.** `0.2.0`, not `v0.2.0` — the strip's version link
  and `release.yml` both assume that.
- Turbo `outputs` must list every build artifact. A cache hit once restored no plugin
  modules after a green build because `build/` was not declared.

## Known gaps

Honest list, so nobody reports these as discoveries:

- **The browser tests do not run in CI.** Five of seven need the 1.19 GB
  non-redistributable database. Fixing it properly means a small synthetic fixture tree
  — a handful of invented ECUs — which would let most of them gate. Not done.
- **`pnpm lint` is a no-op.** It reports "10 successful" and runs nothing — no package
  defines a `lint` script, and no eslint or prettier is configured. Green means
  untested, not clean.
- **Nothing has been written to a real vehicle.** All thirteen ported procedures are
  marked unverified because they are.
- **Database translation coverage is partial and uneven** — UCH 43%, EDC16 30% by
  occurrence.

## Commit messages

Say what changed and *why*, including the mistake that motivated it, in prose. If a
number justified the change, quote it. If the fix took two attempts because the first
was wrong, that is worth a sentence — the next person hits the same wall.
