# db-split

Turns `ecu.zip` into the static tree the web app fetches.

```sh
node tools/db-split/dist/index.js data/ecu.zip /tmp/ddtx-tree
node tools/db-split/dist/index.js data/ecu.zip ./dist-db --compress=gzip,br
```

~15 s for the plain run. `--compress=br` at quality 11 over 543 MB of JSON takes
minutes, so it's opt-in; `gzip` alone adds a few seconds.

## Output

```
index.json          1.1 MB → 118 KB gzipped; every ECU summary plus facets
ecu/<slug>.json     definitions, byte-identical to the zip entry
layout/<slug>.json  screens, byte-identical to the zip entry
manifest.json       source hash, counts, byte totals
report.json         cross-reference findings, with a bounded sample
```

`<slug>` is the zip entry name minus `.json`.

## Why the output is byte-identical

Nothing is normalised, reformatted, or repaired:

- the i18n overlay keys are content hashes over the original strings, so any
  rewrite would invalidate every translation (`docs/i18n-overlay.md` §3);
- a future database snapshot can be diffed against this one;
- integrity problems belong in `report.json`, not in edits to the data.

Dangling references are reported here and pruned at load time by `@ddtx/db`,
which is where the renderer's expectations live. Verified with 600 sampled files
hashed against their zip entries.

## What it drops

The 588 GIFs under `graphics/`. No layout in the database references any graphics
filename — they're DDT2000 leftovers.

## Expected findings

On the 2019 snapshot, and unchanged since:

```
button send names missing request        70
dataitem names missing data              70
displays names missing data              15
inputs names missing data                 9
presend names missing request             1
```

Anything else appearing here means the input archive differs from the one this
was built against. `docs/plan.md` §3.1.1 has the full table with denominators.
