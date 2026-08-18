# Getting the database into the browser

Until now the tree came from a Vite dev-server middleware pointed at `DDTX_DB_TREE`.
That is fine for development and useless for a user: there was no way to install the
database from the app itself. This is how that works.

---

## 1. Three sources, one interface

`DbSource` is deliberately one method wide — `read(path)` — because the tree is a flat
set of known paths behind an index, so listing is never needed. That makes a new
source about fifty lines.

| Source         | Where the tree lives                 | Browser support               |
| -------------- | ------------------------------------ | ----------------------------- |
| `HttpDbSource` | A static host, or the dev middleware | Any                           |
| `OpfsDbSource` | The origin private file system       | Any modern browser            |
| `FsaDbSource`  | A folder the user picked on disk     | Chromium (File System Access) |

**OPFS is the default.** The user picks `ecu.zip` once, it is split into OPFS, and it
stays there across sessions with no permission prompt ever again. The folder picker
exists for people who already keep an unpacked tree on disk — the same shape as
inpax's install picker — and it costs a permission re-grant on every reload, which is
why it is not the default.

---

## 2. Writes queue, and drain between archive slices

`@ddtx/dbimport` holds the splitting core with **no Node imports at all**, so one
implementation serves both hosts:

```
splitArchive(zipBytes, sink)
  ├── tools/db-split   → writeFileSync + node:zlib pre-compression
  └── apps/web worker  → queue on write, OPFS writes on flush
```

The constraint that shapes it: fflate's `Unzip` dispatches each entry from inside the
previous entry's `ondata`, so `sink.write` is called with no opportunity to await —
and **every OPFS write is async, including acquiring the file handle**.

So `write` is synchronous and queues; `flush` is async and drains; and the splitter
awaits `flush` between the 256 KB slices it pushes to fflate, where the stack is
empty. The queue only ever holds the entries that completed inside one slice — a few
MB, against the 543 MB that buffering the whole tree would cost. Awaiting between
slices is also what yields to the event loop, which is what makes the progress bar
move rather than freeze for the whole import.

> **A wrong turn worth recording.** The first design used
> `FileSystemSyncAccessHandle` to write _synchronously_ inside fflate's callback, on
> the theory that a Worker-only sync API would let the sync core run untouched. It does
> not work: the handle is obtained with `await fh.createSyncAccessHandle()`, so the
> await problem moves rather than disappearing. The probe that "confirmed" it had an
> `await` in an async loop and never tested the callback case at all. Sync access
> handles are not needed here — which is also why the import works on any browser with
> OPFS rather than Chromium only.

The Worker stays, for the ordinary reason: fifteen seconds of work does not belong on
the UI thread.

### Measured, on this machine

| Measurement                     | Result              |
| ------------------------------- | ------------------- |
| OPFS writes, one 64 MB file     | 91 ms (~700 MB/s)   |
| 400 individual files            | 401 ms (~1 ms each) |
| Same bytes into one packed file | 271 ms              |

**Per-file wins on simplicity, not speed.** Projected over the real 3,749 entries that
is ~3.8 s against ~2.5 s packed. Spending 1.3 s of a one-time import buys a layout
identical to the CLI's, a `read(path)` that is a direct file read, and no bespoke
container format to version. If the tree grows an order of magnitude, revisit — the
packed measurement is recorded so nobody has to re-derive it.

The inflate dominates either way: ~100 MB compressed in, 1.19 GB out.

### `manifest.json` is the completion marker

There is no staging directory, and that is not a choice: **Chromium implements
`FileSystemHandle.move` on file handles only.** A directory cannot be renamed, so
"build beside the old tree and swap" is unavailable. Trying it fails at the swap with
`FileSystemHandle.move is not a function`, after the full import has already run —
which is exactly how this was found.

So the old tree is removed, the new one is written in place, and the manifest is
written **last**. `opfsTreeInstalled` tests for the manifest rather than the index,
because the index is written before it: a run killed between the two would otherwise
look installed while naming ECU files that were never written.

The cost is that a failed re-import loses the tree that was there before. That is the
honest failure — no database, and a picker — where a half-replaced tree that still
reported itself installed would be worse.

### Measured in the browser

| Step                                   | Result                                |
| -------------------------------------- | ------------------------------------- |
| First-run import of the real `ecu.zip` | ~11 s, 3,749 entries, 1.19 GB         |
| Reload afterwards                      | Opens from OPFS, no picker, no prompt |
| Re-import of the same archive          | Recognised by hash, not unpacked      |

Faster than the CLI's 14.4 s, which is not surprising: the CLI also pre-compresses
every file with gzip, and OPFS does not need that.

## 3. Validation is a separate pass

`validate()` re-reads every file to cross-check references, which the streaming pass
cannot do because ECU and layout entries arrive in arbitrary order and holding both
for all 1,580 ECUs is the 1.19 GB problem again.

So it takes a `read(path)` callback and is **optional**. The CLI always runs it. The
browser skips it by default: the findings are diagnostic, identical for a given
archive, and already recorded in the `report.json` the CLI produces. A "verify" button
in settings runs it on demand.

---

## 4. What is persisted, and where

`FileSystemDirectoryHandle` is structured-cloneable but not JSON-serialisable, so it
cannot live in `localStorage`. Handles go in a one-record IndexedDB store; everything
else is a string in `localStorage`.

| Thing                    | Store        | Survives reload               |
| ------------------------ | ------------ | ----------------------------- |
| OPFS tree                | OPFS itself  | Yes, no prompt                |
| Install folder handle    | IndexedDB    | Handle yes, **permission no** |
| Remote tree URL          | localStorage | Yes                           |
| Which source is selected | localStorage | Yes                           |

The permission caveat is the whole reason the picker has a "Continue with last
folder" button: browsers drop file access across reloads, `queryPermission` returns
`"prompt"`, and `requestPermission` only works inside a user gesture. A button is a
user gesture; startup code is not.

---

## 5. Import is idempotent

The manifest records the archive's SHA-256, so re-importing the same zip is detected
and skipped — the same `--if-needed` check the CLI uses, for the same reason: it
rewrites 1.19 GB and takes ~15 s, so it should happen once per snapshot.

In the browser the hash comes from `crypto.subtle.digest`. Hashing 100 MB takes a
second or two, so the UI reports "checking the archive" and only then "unpacking" —
labelling the hash as unpacking is a claim the user catches out the moment the same
archive is skipped instantly. It also makes "was the split skipped?" observable, which
is what the e2e test asserts on.
