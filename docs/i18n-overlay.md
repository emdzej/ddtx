# Translation overlay

The ECU database ships mostly-French display text, but its strings are _also_
its primary keys, so translation has to be an overlay that never touches the
original files. This document fixes the key scheme, the resolution order, the
delivery format, and the traps.

All numbers are from a full pass over all 1,580 ECU definitions and their
layouts in the 2019 snapshot. `tools/i18n/extract.py` reproduces them:

```sh
python3 tools/i18n/extract.py extract  data/tree /tmp/out.json x70 x70Ph3
python3 tools/i18n/extract.py build    data/tree en i18n/source/en i18n/en
python3 tools/i18n/extract.py coverage data/tree i18n/source/en x70 x70Ph3
```

---

## 1. Why an overlay, not a translated fork

`data` is keyed by the French label. A layout widget references its value by
that label:

```jsonc
// <ecu>.json
"data":     { "Régime moteur": { "scaled": true, "unit": "rpm", … } }
"requests": [ { "name": "Trame 10 - parametres 2", … } ]

// <ecu>.json.layout
"displays": [ { "text": "Régime moteur", "request": "Trame 10 - parametres 2", … } ]
```

Rewrite `"Régime moteur"` in place and every reference to it dangles. The same
holds for request names (referenced by `displays[].request`,
`inputs[].request`, `buttons[].send[].RequestName`, `presend[]`), screen names
(referenced by `categories`), and — see §6.1 — enum labels.

So: originals stay byte-identical, translations live beside them, and lookup
uses the original string always.

---

## 2. The database is not as French as it looks

Distinct strings classified by language (509,076 distinct, 10,229,810
occurrences):

| Surface                  |    Distinct |    French |   English |   Neutral | Unclassified |
| ------------------------ | ----------: | --------: | --------: | --------: | -----------: |
| `data.name`              |     248,320 |      9.9% |     29.5% |     30.5% |        30.2% |
| `widget.text` (→ `data`) |     113,998 |     14.2% |     23.5% |     32.0% |        30.4% |
| `data.list.item`         |     101,299 |     12.7% |     38.2% |     10.8% |        38.3% |
| `request.name`           |      69,718 |      4.7% |     31.1% |     47.5% |        16.7% |
| `label.text`             |      59,232 |      9.2% |     27.4% |     18.5% |        44.9% |
| `data.comment`           |      46,803 |     27.1% |     31.1% |     12.0% |        29.8% |
| `device.data`            |      33,915 |     21.4% |     31.4% |     13.8% |        33.4% |
| `device.name`            |      23,266 |     11.9% |     38.6% |      8.6% |        40.9% |
| `button.text`            |       8,726 |     16.7% |     56.8% |      6.3% |        20.2% |
| `screen.name`            |       6,885 |     16.2% |     25.9% |     10.0% |        47.9% |
| `category.name`          |       1,202 |      8.7% |     15.0% |     18.5% |        57.8% |
| `data.unit`              |         834 |      1.6% |      5.5% |     31.5% |        61.4% |
| `button.message`         |         329 |     50.2% |     26.1% |      1.8% |        21.6% |
| **All**                  | **509,076** | **11.6%** | **32.1%** | **25.2%** |    **31.1%** |

Only ~12% of distinct strings are confidently French. A third are already
English — much of it UDS-standard (`DTCStatus.testFailedSinceLastClear`,
`DTCStatusAvailabilityMask`) — and a quarter are language-neutral (`%`, `°C`,
`N.m`, hex codes).

**Caveat on the 31% unclassified:** the classifier is a heuristic (diacritics +
function-word lists), and this bucket is dominated by short abbreviations —
`wu`, `km/h`, `mg/strk`, `sec`, `UNKWN`, `Send`. Most are effectively neutral or
English; some are clipped French. Treat the bucket as "needs a human decision",
not "needs translation". The honest budget is therefore **~59k confidently
French plus a ~158k pile to triage**, not 509k.

**Do not translate blind.** Running MT over the whole DB would mangle 57% of it
(the English and neutral strings) for no benefit. Language classification is a
required first stage of extraction, not a nicety.

---

## 3. Key scheme: content-hashed and namespaced

```
key = <namespace> ":" sha256(NFC(source)) as hex, first 16 chars
```

16 hex characters is 64 bits — ample for ~509k distinct strings, and compact
enough that a bundle stays small. Implemented in `packages/i18n/src/keys.ts`. The
Python builder in `tools/i18n/extract.py` must produce byte-identical keys, and
`parity.test.ts` pins that against the real built bundle — a divergence there
throws nothing, it just makes every translation silently stop resolving.

**Content-hashed, not path-based.** Reuse across the DB averages **20.1×** — a
path key like `ecu/CGW_DDT_6_2/screens/Infos Moteur/displays[3]/text` would need
10.2M entries to cover what 509k content keys cover. Paths are also index-based
and so break on any re-export, whereas the strings _are_ stable identifiers by
construction (they're dict keys). And since the DB is a frozen 2019 snapshot,
path stability buys nothing that content hashing doesn't.

**Namespace follows the reference target, not the syntactic location.** This is
what makes coverage compound:

| Namespace                                       | Covers                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `data`                                          | `data{}` keys, `*_dataitems` keys, `displays[].text`, `inputs[].text`      |
| `request`                                       | `requests[].name`, `displays[].request`, `send[].RequestName`, `presend[]` |
| `screen`                                        | `screens{}` keys and `categories[]` members                                |
| `category`                                      | `categories{}` keys                                                        |
| `device` / `deviceData`                         | DTC device names / failure-flag names                                      |
| `list`                                          | `data.lists` values                                                        |
| `unit`, `comment`, `label`, `button`, `message` | display-only surfaces                                                      |

Translating one `data` entry therefore fixes the `data{}` key, every dataitem
reference, and all 113,998 widget captions at once. Namespacing also stops
cross-surface collisions — `"Etat"` as a unit and `"Etat"` as a data name are
independently translatable.

Hashing rather than embedding the source keeps bundles compact and keeps
non-ASCII out of JSON keys. Store the source text in the extraction manifest,
not in the runtime bundle.

---

## 4. Resolution order

Same string, different meaning by context — so keys may be scoped, most
specific winning:

```
1.  ecu:<slug>/<ns>:<hash>      per-ECU override
2.  group:<group>/<ns>:<hash>   per ECU group ("Injection", "ABS", …)
3.  <ns>:<hash>                 global, namespaced   ← the common case
4.  the source string           untranslated passthrough
```

An earlier draft also had a namespace-agnostic `*:<hash>` step. It is not
implemented: namespaces exist precisely so `"Etat"` as a unit and `"Etat"` as a
data name can differ, and a wildcard tier would quietly undo that.

Scopes 1 and 2 are expected to stay near-empty; they exist so a bad
disambiguation can be fixed without forking the global entry. `group` comes
from `db.json`, so it's known before the ECU file is fetched.

A dev-mode flag marks every string that fell through to the last step —
**Mark gaps** in the toolbar — because otherwise missing coverage is invisible.

---

## 5. Tiers, by return on effort

Weighted by occurrence, the top 1,000 distinct strings cover 21.4% of all
10.2M occurrences; top 10k cover 39.1%; top 50k cover 64.6%. Combining that with
§2's language split gives three tiers:

**Tier A — chrome (~4,600 strings needing work).** Units, categories, screen
names, button labels, confirmation messages. 17,976 distinct in total, of which
only the French + unclassified share needs attention. This is small enough to
hand-curate and review, and it alone yields a fully navigable English UI:
every menu, screen title, and button.

**Tier B — high-frequency content (~15,000).** The top 10k enum labels (80.6% of
all `list` occurrences) and top 10k comments (77.1%). Best value-per-entry in
the whole DB thanks to 25× and 15.7× reuse respectively.

**Tier C — long tail (~200,000).** `data.name`, `request.name`, `label.text`.
Machine-translated, shipped as per-ECU bundles, flagged as MT in the UI.

Build a **glossary first** and feed it to MT as forced terminology. Automotive
French is terse and domain-specific — `Calculateur` → ECU (not "computer"),
`Apprentissage` → adaptation, `Défaut` → fault, `Panne` → failure, `Régime` →
speed, `Papillon` → throttle, `Vanne` → valve, `Débit` → flow, `Consigne` →
setpoint, `Relevé` → reading, `Essai` → test. Raw MT on the p50 34-character
label without a glossary is noticeably worse.

---

## 6. Traps

### 6.1 Enum labels are write-path identifiers

`EcuRequest.build_data_stream` reverse-looks-up the _label_ to recover the
integer to send (`ecu_request.py:175-176`):

```python
if v in data.items:              # data.items maps label → int
    v = hex(data.items[v])[2:].upper()
```

If the UI hands back a translated label, the write silently encodes the wrong
value or throws. **The UI must carry the integer key**, with the label as
presentation only. This is the single most dangerous consequence of translating
this database, because it fails at write time, on a real car, in a way no
read-only test will catch.

### 6.2 Units need canonicalisation, not translation

834 distinct units, and they're inconsistent: `V` and `Volt`, `s` and `sec`,
plus noise (`wu`, `-`, `UNKWN`). Map them to canonical unit IDs rather than
translating the strings. That also unlocks conversion (°C → °F, km/h → mph)
later, which a translation table cannot express.

### 6.3 Translations overflow the layout

Screens are fixed-size twip canvases with per-widget `rect`s sized for French.
English is usually shorter, but German, Polish, and Czech are not. Renderer
needs: ellipsis with a `title` tooltip, optional auto-shrink to fit, and never
reflow — the absolute positions are the design.

### 6.4 Provenance must be preserved

Bundle values carry an origin flag so a re-run of MT never overwrites reviewed
human text:

```jsonc
{
  "data:MFRGGZDF": "Engine speed", // string  = human/reviewed
  "data:MZXW6YTB": ["Canister purge valve", 1], // [text, 1] = machine-translated
}
```

---

## 7. Delivery

Mirrors the database split (`plan.md` §3.1) so the overlay is fetched on the
same schedule as the data it annotates:

```
i18n/<locale>/chrome.json          eager  — tiers A+B, ~20k entries, ~200 KB gz
i18n/<locale>/ecu/<ecuFile>.json   lazy   — tier C for that ECU only, ~15 KB gz
i18n/source/manifest.json          build  — hash → {ns, source, lang, count}
```

Per-ECU tier-C bundles rather than one global file: an ECU uses ~1,600 distinct
strings on average, so its overlay is ~100 KB raw / ~15 KB gzipped, fetched in
parallel with the 352 KB definition file it belongs to. A single global tier-C
bundle would be tens of megabytes.

`manifest.json` is the canonical extraction output — the input to translators
and MT, and the thing that lets a future DB snapshot be diffed against this one.

---

## 8. Package shape

`packages/i18n` exposes exactly one resolution primitive, and it only accepts
branded name types from `@ddtx/core` — a bare `string` will not compile:

```ts
translate(ns, name: DataName | RequestName | …, scope): string
```

Reference resolution against the DB never goes through it. That asymmetry is the
whole safety mechanism; see `core/src/db.ts`.
