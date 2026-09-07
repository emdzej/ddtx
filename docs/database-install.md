# Getting the database into the browser

The database is 1,580 ECUs and is not ours to redistribute, so the app ships without it
and the first run asks for it. This is what happens then.

Everything below is a csfs backend — [`csfs`](https://github.com/emdzej/csfs) is one read
API over a static host, a directory the user picked, the origin private file system, and
inside a zip in any of those. ddtx has three of those four in use.

## 1. The archive is not unpacked

`ecu.zip` is copied into the origin private file system once, and **read where it lies**
from then on. There is no extraction step.

This was not the original design. The app used to unpack all 3,749 entries into OPFS —
1.19 GB, about fifteen seconds, a worker, a write queue that drained between archive
slices, and a completion marker so an interrupted import could be told from a finished
one. Reading the archive in place deletes every one of those problems, and it is
*faster* afterwards:

| | in place | unpacked tree |
| --- | --- | --- |
| ECU definition, p50 | **1.3 ms** | 8.1 ms |
| Layout, p50 | **0.9 ms** | 6.9 ms |
| Open | **88 ms** | ~15 s to install |
| Storage | **104 MB** | 1.19 GB |

Not a surprise once stated: a zip entry is ~20 KB of I/O plus inflate, where the
extracted file is 406 KB. The measurement is in `packages/db/src/archive.ts`.

## 2. Two shapes, and where the mapping lives

The archive is flat. The app's paths are not.

| the app asks for | the archive holds |
| --- | --- |
| `index.json` | derived from `db.json` |
| `ecu/<slug>.json` | `<slug>.json` |
| `layout/<slug>.json` | `<slug>.json.layout` |

`db-split` performs the same mapping when it writes a tree, which is why a tree and an
archive are interchangeable behind `DbSource` — and why "emitted files are byte-identical
to their zip entries" in that tool's header is a claim about *contents*, not paths.

The mapping is ddtx's, not a csfs archive mount, because csfs's `entry` modes are
`"relative"` and `"basename"` and neither rewrites an extension. `/layout/X.json` →
`X.json.layout` is a fact about this database rather than about archives in general.

`index.json` is not in the archive at all; `buildIndex` derives it, dropping the ECUs
the upstream `db.json` lists but never shipped a file for and computing the
group/project/protocol facets the catalogue filters on. That function lives in
`@ddtx/core` so that `db-split` and the runtime share one implementation and cannot
disagree about which ECUs exist.

## 3. Three sources, one interface

```ts
interface DbSource {
  read(path: string): Promise<Uint8Array>;
}
```

| Source | Backend | Cost |
| --- | --- | --- |
| **The archive** | `csfs-opfs` + `csfs-zip` | Never prompts again. The default |
| **A folder** | `csfs-fsa` | A permission re-grant on every reload |
| **A URL** | `csfs-http` | One `Range` request per read; needs a manifest |

`DbSource` survives as the app's own one-method contract, adapted from csfs by
`csfsDbSource`. The one difference worth naming: csfs returns `null` for an absent path,
because testing existence should not need a `try`. `DbSource` rejects, because every path
its callers ask for came out of the index, so a miss is a corrupt database rather than a
normal answer.

Before csfs there were three hand-rolled implementations here. `DbSource`'s own comment
explained why: the comparable abstraction, `@emdzej/bimmerz-vfs`, is PolyForm
Noncommercial and this project is GPL-3.0-or-later. csfs is MIT, so that reason expired.

## 4. The URL source needs a manifest, and Range

HTTP cannot list a directory: a static host serves any file you name and tells you
nothing about what is there. So csfs-http reads from a manifest, and `db-split` emits
`csfs-manifest.json` beside the tree — 3,161 entries, 166 KB, 43 KB gzipped, built from
what the split just wrote rather than by walking the output.

csfs-http also **rejects a host that ignores `Range`** rather than trusting its 200,
because a whole body used as a slice returns the wrong bytes silently. The dev-server
middleware answers 206 with a `content-range` for exactly that reason; without it,
development would have been the one place that did not behave like production. GitHub
Pages honours `Range`.

## 5. Validation happens before anything is replaced

`archiveDbSource` opens the picked file *before* the stored one is overwritten, so a file
that is not a database archive fails with the working database untouched. That used to be
an ordering rule to remember — an early version cleared the installed tree first, and a
wrong file destroyed a working database — and it is now structural: the open either
succeeds or nothing is written.

`inspectTree` remains for the on-demand check in settings, which samples a dozen ECUs
across the index and reports anything missing or malformed.

## 6. What is persisted, and where

| What | Where | Why there |
| --- | --- | --- |
| `ecu.zip` | OPFS, under a `ddtx` namespace | Never prompts. Namespaced because OPFS is shared by the whole origin |
| The chosen source, and any URL | `localStorage` | Small, synchronous, and read before the first paint |
| A picked folder's handle | IndexedDB | `localStorage` cannot hold a handle |

`persist()` is requested before the copy rather than after, so the browser is asked
before 104 MB is written rather than once it is already at risk. It may refuse without
explanation; the answer is reported rather than thrown, because an evictable database
still works.

A folder handle survives a reload but its **permission does not** — `queryPermission`
reports `"prompt"` afterwards and re-granting only works inside a user gesture. So
startup distinguishes "needs a click" from "gone" (`folderStatus`) and shows a button
rather than the picker.

## 7. A repeat import is not skipped

It used to be: the archive was hashed with `crypto.subtle` and a matching snapshot was
recognised rather than unpacked again. That existed because unpacking cost fifteen
seconds. Copying one file costs about one, and nothing is derived from the archive that
a hash could be compared against, so the machinery went with the unpacking.
