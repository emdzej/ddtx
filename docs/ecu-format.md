# The ECU database format

Reference for the DDT4All ECU database — the JSON produced by
`parameters.helpers.convertXML()` and shipped inside `ecu.zip`. No such reference
exists upstream, so everything here was measured against the whole 2019 snapshot:
**1,580 ECUs, 541,061 requests, 2,200,912 data items, 39,665 screens**. Where a
number appears, it is a count over all of them, not a sample.

The format is worth understanding in its own right: it is a complete, declarative
description of how to talk to 1,580 control units, and it is the _only_ artefact
that knowledge exists in.

---

## 1. Shape of the archive

```
ecu.zip                          104.6 MB compressed, 1.278 GB expanded
├── db.json                      the index: 1,580 entries
├── <name>.json                  1,581 ECU definitions (avg 352 KB, max 3.7 MB)
├── <name>.json.layout           1,580 screen layouts (avg 436 KB, max 5.4 MB)
└── graphics/**                  588 GIFs — unreferenced, see §7
```

`tools/db-split` turns this into `index.json` + `ecu/<slug>.json` +
`layout/<slug>.json`, byte-identical to the entries. A slug is the entry name
minus `.json`.

Definitions and layouts are separate files, and that split is load-bearing: the
codec needs only the definition, and a layout is fetched only when a screen is
opened.

---

## 2. `db.json` — the index

`filename → summary`. 1,580 entries.

```jsonc
"SIRIUS34_EMS3134_Soft_REA830_20110927T110523.json": {
  "protocol": "KWP2000",
  "ecuname":  "SIRIUS34 - EMS3134 - Soft REA830",
  "address":  "7A",          // functional address, hex
  "group":    "Injection",   // ECU function; 171 distinct
  "projects": ["x35", "x64", "x65", "x76", "x90"],
  "autoidents": [
    { "diagnostic_version": "16", "supplier_code": "001",
      "soft_version": "00EA", "version": "8000" }
  ]
}
```

| Field        | Notes                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| `protocol`   | `CAN` 1,363 · `KWP2000` 195 · `ISO8` 21 · `""` 1                         |
| `address`    | Functional address. Not unique — many ECUs share one (`7A` is Injection) |
| `group`      | 171 distinct. Free text, and the same function is spelled several ways   |
| `projects`   | Vehicle project codes, 140 distinct. Includes the artefact `#text` (§8)  |
| `autoidents` | Identity tuples this file claims to describe. May be empty               |

**Beware the two `autoident` shapes.** `db.json` uses
`diagnostic_version`/`supplier_code`/`soft_version`/`version`; the _ECU file_ uses
`diagversion`/`supplier`/`soft`/`version` for the same four things. Both come from
`ecu_file.py`, out of `dump_idents()` and `dumpJson()` respectively. `@ddtx/core`
models them as `IndexAutoIdent` and `AutoIdent`.

---

## 3. `<ecu>.json` — the definition

Seven top-level keys, all present on all 1,580 files:

```jsonc
{
  "ecuname": "SIRIUS34 - EMS3134 - Soft REA830",
  "endian":  "Big",              // Big 1,494 · Little 86
  "obd":     { … },              // §3.1
  "autoidents": [ … ],
  "requests":   [ … ],           // §3.2
  "data":       { … },           // §3.3
  "devices":    [ … ]            // §3.4
}
```

### 3.1 `obd` — how to reach the ECU

```jsonc
// CAN
"obd": { "protocol": "CAN", "send_id": "747", "recv_id": "767",
         "baudrate": 500000, "funcaddr": "58", "funcname": "Navigation" }

// KWP2000
"obd": { "protocol": "KWP2000", "fastinit": true, "kw1": "F1", "kw2": "7A",
         "funcaddr": "7A", "funcname": "Injection" }
```

| Field                 | Present on | Notes                                                      |
| --------------------- | ---------- | ---------------------------------------------------------- |
| `protocol`            | 1,580      | Dispatches the whole addressing sequence (§`protocols.md`) |
| `funcaddr`            | 1,580      | Functional address, hex. The K-line target                 |
| `funcname`            | 1,580      | ECU group. May be `""`                                     |
| `send_id` / `recv_id` | 1,363      | CAN ids, 3 hex chars (11-bit) or 8 (29-bit)                |
| `baudrate`            | 1,363      | **See the warning below**                                  |
| `fastinit`            | 195        | KWP2000 only. `true` 160, `false` 35                       |
| `kw1` / `kw2`         | 216        | Key bytes: KWP2000 and ISO8                                |

> **`baudrate` is largely nonsense.** Across the 1,363 CAN ECUs:
> `10400` 753 · `500000` 547 · `125000` 28 · `250000` 23 · `50000` 7 ·
> `2000000` 2 · `20800` 2 · `800000` 1.
>
> 10400 baud is the **K-line** rate and is physically impossible on CAN, yet 55%
> of CAN ECUs declare it. The original only ever distinguishes 250 kbit/s and
> treats everything else as 500 kbit/s (`set_can_250` / `set_can_500`), so the
> junk values are harmless — and `@ddtx/elm` does the same, deliberately.
>
> The cost is that genuine 125 kbit/s multiplex buses are not selectable, in
> either implementation. If that matters, it is a known gap rather than an
> oversight.

### 3.2 `requests[]` — what to send

```jsonc
{
  "name": "Trame 10 - parametres 2",
  "sentbytes": "2110", // hex template, no separators
  "minbytes": 4, // shortest acceptable response
  "replybytes": "610BB87801", // canned reply, simulation only
  "manualsend": true, // fired by a button, never polled
  "deny_sds": ["nosds", "plant"],
  "shiftbytescount": 4, // DTC record stride
  "receivebyte_dataitems": { "Régime moteur": { "firstbyte": 2 } },
  "sendbyte_dataitems": { "Fonction à surveiller": { "firstbyte": 2 } },
}
```

| Field                   |   Count | Notes                                                                  |
| ----------------------- | ------: | ---------------------------------------------------------------------- |
| `name`                  | 541,061 | **This is the primary key.** Layouts reference requests by it          |
| `deny_sds`              | 541,061 | Always present, usually `[]` (483,731). Session gates; largely ignored |
| `sentbytes`             | 541,060 | One request has none. p50 length **3 bytes**                           |
| `minbytes`              | 540,873 | Used by the DTC reader and the editor, not by decoding                 |
| `replybytes`            | 510,615 | 94.4%. Simulation data — see `demo mode` in `plan.md` §8               |
| `receivebyte_dataitems` | 400,767 | Fields decoded out of the response                                     |
| `sendbyte_dataitems`    | 145,491 | Fields the caller fills in before sending                              |
| `manualsend`            | 138,181 | 26% of requests. **Never polled** by a screen refresh                  |
| `shiftbytescount`       |   2,265 | Stride between DTC records; 4 in 1,545 cases                           |

Most common service ids in `sentbytes`: `22` ReadDataByIdentifier (317,695),
`2E` WriteDataByIdentifier (103,828), `21` ReadDataByLocalId (24,552),
`3B` WriteDataByLocalId (17,829), `31` RoutineControl (14,085),
`2F` InputOutputControl (13,366), `19` ReadDTCInformation (10,262).

### 3.3 `data{}` — how to read a value

Keyed by name; the value describes bit extraction and presentation.

```jsonc
"Régime moteur": {
  "bitscount": 16, "bytescount": 2,
  "scaled": true, "step": 0.125, "offset": 0, "divideby": 1,
  "format": "#0.0", "unit": "tr/min",
  "comment": "régime moteur mesuré"
}
"Etat relais": { "bitscount": 8, "lists": { "0": "OFF", "1": "ON" } }
```

| Field        |     Count | Default | Notes                                                 |
| ------------ | --------: | ------- | ----------------------------------------------------- |
| `bitscount`  | 1,005,851 | 8       | **264 distinct values**, max 32,736 (4,092 bytes)     |
| `bytescount` |   513,494 | 1       | max 4,092                                             |
| `scaled`     |   959,121 | false   | Apply the linear transform and render as decimal      |
| `comment`    |   733,720 | `""`    | Help text. Sometimes contains HTML                    |
| `unit`       |   526,577 | `""`    | 834 distinct spellings for far fewer quantities       |
| `lists`      |   433,277 | —       | Enum map. **Keys are strings holding integers**       |
| `step`       |   251,186 | 1       |                                                       |
| `byte`       |   165,211 | false   | Defined by `<Bytes>` rather than `<Bits>` in the XML  |
| `offset`     |   109,109 | 0       |                                                       |
| `divideby`   |   105,433 | 1       | **Can be 0** — the original prints "division by zero" |
| `signed`     |    94,425 | false   | Honoured for `bytescount` 1 and 2 only                |
| `format`     |    48,830 | `""`    | `#0.0` (14,168), `bin` (10,556), `#0.00` (8,678), …   |
| `bytesascii` |    27,570 | false   | Decode the bytes as text                              |

The transform, when `scaled`:

```
value = (raw × step + offset) ÷ divideby
```

and on the way in, `raw = (value × divideby − offset) ÷ step`, truncated.

**`lists` values are identifiers, not just labels.** Writing a value looks the
label back up to recover the integer (`ecu_request.py:175`), so translating one
into the write path sends the wrong byte. See `i18n-overlay.md` §6.1.

### 3.4 `dataitem` — where a field sits in a frame

```jsonc
{ "firstbyte": 2, "bitoffset": 4, "endian": "Little", "ref": true }
```

| Field       |     Count | Notes                                                |
| ----------- | --------: | ---------------------------------------------------- |
| `firstbyte` | 2,200,912 | **1-based, and byte 1 is the response SID**          |
| `ref`       | 1,169,379 | True on 53%. Carried through and **used by nothing** |
| `bitoffset` |   535,533 | Bits from the MSB of `firstbyte`                     |
| `endian`    |    71,170 | Overrides the ECU's: `Big` 47,160, `Little` 24,010   |

`firstbyte` being 1-based _including_ the SID is the single easiest thing to get
wrong by one, and it is invisible until a value is subtly incorrect —
`packages/elm/src/endToEnd.test.ts` pins it deliberately.

`ref` most likely marked a reference to a shared definition in the DDT2000
original. Neither the Python nor this port does anything with it.

### 3.5 `devices[]` — DTCs

```jsonc
{
  "name": "Capteur de pression",
  "dtc": 273,
  "dtctype": 0,
  "devicedata": { "Circuit ouvert": "1", "Court circuit": "0" },
}
```

139,199 devices. `dtctype` is `0` (99,587), `4` (23,264), `2` (8,705), `3` (7,643).
`devicedata` maps a failure-flag name to `"0"` or `"1"` — the flag's expected
value, not a reading.

---

## 4. `<ecu>.json.layout` — the screens

```jsonc
{
  "categories": { "Ecrans APV": ["Identification", "Défauts"] },
  "screens": {
    "Identification": {
      "width": 12000, "height": 8580,      // twips
      "color": "rgb(128,128,128)",
      "displays": [ … ], "inputs": [ … ],
      "labels":   [ … ], "buttons": [ … ],
      "presend":  [ { "RequestName": "StartDiag", "Delay": "0" } ]
    }
  }
}
```

**The widget vocabulary is closed and rigid.** Across 39,665 screens, every widget
of a given type carries an identical key set every time — no variants, no optional
fields:

```
displays / inputs  { rect, color, fontcolor, font, text, request, width }
labels             { bbox, color, fontcolor, font, text, alignment }
buttons            { rect, font, text, messages, uniquename, send[] }
presend            [ { RequestName, Delay } ]
```

| Widget     | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `displays` | Read-only value. `request` names a request, `text` names a data item     |
| `inputs`   | Writable field. Same shape; `text` need only exist in `data` (§6)        |
| `labels`   | Static caption or group box. Uses `bbox`, not `rect`                     |
| `buttons`  | Fires `send[]` in order. `uniquename` is the identity, `text` is display |
| `presend`  | Requests fired once on screen entry                                      |

### 4.1 Geometry

Coordinates are **VB twips** on a fixed canvas. 4,205 distinct canvas sizes; the
common ones are `9000×6000` (1,865), `14000×600` (1,539), `12060×9060` (1,124),
`16380×10020` (990). The many `14000×NNN` are thin horizontal strips.

Pixels are `twips ÷ uiscale`, where `uiscale` starts at 8 and clamps at 4
(`param_widget.py:48`). Nothing reflows — the absolute positions _are_ the design.

- `rect` / `bbox`: `{ left, top, width, height }`, all twips.
- `width` on a display/input is the **caption** width, not the value width. The
  value takes `rect.width − width` and sits to its right
  (`display_widget.py:127`). Misreading this is easy; `@ddtx/db` names it
  `captionWidth`.
- Colours are **already** CSS `rgb(r,g,b)` strings. The XML→JSON converter also
  swapped BGR to RGB on the way (`utils.py:colorConvert`), so no further
  conversion applies.
- Fonts: `{ name, size, bold, italic }` where bold/italic are the **strings**
  `"0"`/`"1"`. Pixel size is `int(size ÷ uiscale × 14)` (`utils.py:jsonFont`) —
  the factor of 14 is unexplained and presumably an empirical fit to the VB
  original.
  Most common families: `Ms Sans Serif` (654,466), `Arial` (647,051),
  `MS Sans Serif` (215,517 — note the casing differs), `Small Fonts` (15,540).
  Most common sizes: 8.0, 10.0, 8.25, 7.0.
- `labels[].alignment`: `"0"` left (405,153), `"2"` centre (135,404), `"1"` right
  (19,843), `""` unset (7,990). All four occur, so unset needs a defined result.

---

## 5. What references what

The database is a graph held together by **strings**, which is why nothing may be
translated in place:

```
categories{}  ──name──▶  screens{}
screens{}     ──displays[].request──▶  requests[].name
              ──displays[].text   ──▶  data{}  and  requests[].receivebyte_dataitems
              ──inputs[].text     ──▶  data{}
              ──buttons[].send[].RequestName ──▶ requests[].name
              ──presend[].RequestName        ──▶ requests[].name
requests[]    ──*_dataitems keys──▶  data{}
```

Reuse across the whole database averages **20:1** — 10,229,810 string occurrences
over 509,084 distinct strings.

---

## 6. Integrity, measured

Checked three independent ways (Python against the zip, `db-split`'s validator,
`@ddtx/db`'s loader — all agreeing):

| Case                                             | Count |        Of | Handling                                      |
| ------------------------------------------------ | ----: | --------: | --------------------------------------------- |
| widget caption is `""`                           | 1,421 | 1,021,519 | **valid decoration** — a framed box, no value |
| widget names absent data                         |    24 | 1,021,519 | drop, warn                                    |
| widget names absent request                      |     0 | 1,021,519 | —                                             |
| display reads a field its request doesn't return |     6 |   831,703 | drop — the Qt app never creates the widget    |
| `button` has no `send` key                       | 1,367 |   104,276 | keep; renders inert                           |
| `button.send` names absent request               |    70 |   200,604 | drop the entry (15 buttons go inert)          |
| `presend` names absent request                   |     1 |    11,403 | drop the entry                                |
| dataitem names absent data                       |    70 | 2,200,912 | ECU-level                                     |
| category names absent screen                     |     0 |    40,179 | —                                             |
| category lists no screens                        |    55 |    10,067 | drop the dead menu node                       |

So ~99.99% internally consistent, but not perfectly — a loader must prune rather
than throw. **The empty-caption case is the one that matters**: it is 98% of all
apparently-broken widget bindings and is not an error at all.

An **asymmetry worth knowing**: a _display_ may only read a field its request
returns (`display_widget.py:104`), while an _input_ only needs the data definition
to exist (`input_widget.py:165`). Inputs are never polled; they are filled in as a
side effect when some display decodes the same data name
(`param_widget.py:1204`).

---

## 7. What is not used

- **`graphics/**` — 588 GIFs, referenced by no layout in the database.** DDT2000
  leftovers. `db-split` drops them, which removes image handling from a renderer's
  scope entirely.
- **`ref` on dataitems** — set on 53% of them, read by nothing.
- **`deny_sds`** — parsed, and 483,731 of 541,061 requests carry `[]` anyway.
- **`replybytes`** outside simulation, and **`minbytes`** outside the DTC reader
  and the editor.

---

## 8. Known data faults

Real defects in the snapshot, not in any reader:

- **`#text` as a vehicle.** The XML converter appended text-node names to
  `projects` (`projects.append(project.nodeName)` never skipped text nodes), so
  `#text` appears as though it were a project code. `db-split` keeps it out of the
  index facet.
- **Five pseudo-ECUs with no content**: `125_kbps_CAN`, `CAN_250_kbds`,
  `250_kbps_CAN2`, `500_kbps_CAN2`, `CAN_500_kbds` — 245-byte files describing bus
  speeds rather than control units.
- **Three ECUs define a data entry named `""`**, and the Qt app binds their five
  empty-caption widgets to it. A loader must resolve before falling back to
  "decoration", or those five silently change behaviour.
- **`divideby: 0`** occurs; decoding must return no value rather than divide.
- **Typos in authored text**: `Adomètre` for `Odomètre`, `Ecirure`/`Ecritute` for
  `Ecriture`. Translations follow intent.
- **Duplicate spellings** that are the same thing: `Ms Sans Serif` vs
  `MS Sans Serif`; `Tr/min`, `tr/min`, `trs/min`, `tr/mn`, `erpm` all meaning rpm.

---

## 9. Provenance

The database is Renault-derived and is not ours to redistribute. ddtx ships no ECU
data: it is pointed at a database the operator already has. The timestamps in
`db.json` are 2019, so this is a frozen snapshot rather than a moving target —
which is why the i18n overlay can safely key on content hashes
(`i18n-overlay.md` §3).
