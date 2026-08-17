# Translations

The ECU database is authored mostly in French, and its strings double as its
primary keys — `data` is keyed by the French label and a layout widget's `text`
field is a lookup into it. So nothing here rewrites the database. Translation is
an overlay resolved at the render boundary and nowhere else; reference resolution
always uses the original string. See [`../docs/i18n-overlay.md`](../docs/i18n-overlay.md).

## Layout

```
source/<locale>/<namespace>.json   authored: { "source": "translation" }
<locale>/bundle.json               built: { "<namespace>:<hash>": "translation" }
<locale>/manifest.json             per-namespace counts
```

Authoring against the source text rather than the hash is what keeps these files
reviewable and diffable. `_`-prefixed keys are notes to the next translator and
are skipped by the build.

## Commands

```sh
# What still needs translating, for one or more vehicle codes
python3 tools/i18n/extract.py extract data/tree /tmp/out.json x70 x70Ph3

# Hash the authored files into a runtime bundle
python3 tools/i18n/extract.py build data/tree en i18n/source/en i18n/en

# How much of a vehicle's visible text is covered
python3 tools/i18n/extract.py coverage data/tree i18n/source/en x70 x70Ph3
```

## Namespaces

Named after the **reference target**, not the syntactic location, which is what
makes coverage compound: one `data` entry translates the dictionary key, every
dataitem that names it, and every display caption that shows it.

| Namespace | Covers |
| --- | --- |
| `data` | `data{}` keys, dataitem names, display and input captions |
| `request` | request names, and every reference to one |
| `screen` | screen names and category members |
| `category` | category names |
| `device` / `deviceData` | DTC device names / failure-flag names |
| `list` | enum labels — the text in a value cell |
| `unit` | units. **Canonicalised**, not translated |
| `comment` | the help text behind a value |
| `label` | static captions and group-box titles |
| `button` | button captions (`uniquename` stays the identity) |
| `message` | button confirmation prompts |

## What is not translated, deliberately

Only ~12% of the database is confidently French. A third is already English —
much of it UDS-standard (`DTCStatus.testFailedSinceLastClear`) — and a quarter is
language-neutral (`%`, `°C`, `N·m`, hex codes). `extract` classifies before
offering, because running machine translation over the whole thing would mangle
more than it fixed. A string that needs no translation counts as covered.

## Traps

**Enum labels are write-path identifiers.** `buildDataStream` looks the *label*
back up to recover the integer to send, so the codec must keep returning the raw
label and the UI must carry the integer. Translating a label into the write path
would silently send the wrong value. This is why `Overlay` is read-only and why
`t()` is called in components, never in `@ddtx/codec` or `@ddtx/db`.

**Units need canonicalising, not translating.** The same unit is spelled a dozen
ways (`Tr/min`, `tr/min`, `trs/min`, `tr/mn`, `erpm` all mean rpm). Mapping them
to one canonical form is what makes a column comparable, and it is the
precondition for offering conversion later.

**Translations overflow the layout.** Screens are fixed twip canvases sized for
French. Value cells ellipsize and captions wrap; nothing reflows.
