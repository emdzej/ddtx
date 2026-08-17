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
# What still needs translating, for one or more vehicle codes.
# --source skips what is already authored: without it the offer includes strings
# you have already translated, and the ranking sends you back over them.
python3 tools/i18n/extract.py extract data/tree /tmp/out.json x70 x70Ph3 --source i18n/source/en

# Hash the authored files into a runtime bundle
python3 tools/i18n/extract.py build data/tree en i18n/source/en i18n/en

# How much of a vehicle's visible text is covered
python3 tools/i18n/extract.py coverage data/tree i18n/source/en x70 x70Ph3
```

## Namespaces

Named after the **reference target**, not the syntactic location, which is what
makes coverage compound: one `data` entry translates the dictionary key, every
dataitem that names it, and every display caption that shows it.

| Namespace               | Covers                                                    |
| ----------------------- | --------------------------------------------------------- |
| `data`                  | `data{}` keys, dataitem names, display and input captions |
| `request`               | request names, and every reference to one                 |
| `screen`                | screen names and category members                         |
| `category`              | category names                                            |
| `device` / `deviceData` | DTC device names / failure-flag names                     |
| `list`                  | enum labels — the text in a value cell                    |
| `unit`                  | units. **Canonicalised**, not translated                  |
| `comment`               | the help text behind a value                              |
| `label`                 | static captions and group-box titles                      |
| `button`                | button captions (`uniquename` stays the identity)         |
| `message`               | button confirmation prompts                               |

## What is not translated, deliberately

Only ~12% of the database is confidently French. A third is already English —
much of it UDS-standard (`DTCStatus.testFailedSinceLastClear`) — and a quarter is
language-neutral (`%`, `°C`, `N·m`, hex codes). `extract` classifies before
offering, because running machine translation over the whole thing would mangle
more than it fixed. A string that needs no translation counts as covered.

The classifier has three tiers, in order. An accent settles it. Then two
hand-written word lists. Then, where those tie, **a lexicon learned from the
authored files themselves** — every entry is a French→English pair, so its key is
French evidence and its value English evidence, which turns work already done into
a classifier for what is left. Held out over the authored pairs (train on half,
test on the other half): 2.2% of French keys called English, 0.2% of English values
called French — and inspecting the 2.2% shows most really are English strings in the
database, authored as near-identity translations.

The risk worth naming: a string wrongly called `en` is counted as covered and never
offered again. That is why the learned lexicon only breaks ties and never overrides
an accent.

### Master II coverage (x70 + x70Ph3), 27 ECUs

| Namespace                                     | Distinct covered | Occurrences covered |
| --------------------------------------------- | ---------------- | ------------------- |
| `screen` `category` `unit` `button` `message` | 100%             | 100%                |
| `label`                                       | 52%              | 76%                 |
| `list`                                        | 42%              | 65%                 |
| `data`                                        | 37%              | 37%                 |
| `request`                                     | 42%              | 32%                 |
| `comment`                                     | 36%              | 29%                 |
| `device` / `deviceData`                       | 23% / 18%        | 18% / 16%           |
| **Total**                                     | **41%**          | **56%**             |

`data` is the flat one: 5,053 distinct names over 8,447 occurrences, so the top 500
strings are only ~27% of what is seen. There is no shortcut through it — unlike
`list`, where 131 entries already cover 65% of occurrences.

## Traps

**Enum labels are write-path identifiers.** `buildDataStream` looks the _label_
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
