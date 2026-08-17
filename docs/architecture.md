# How ddtx works

Follow one value from the database to the screen, and one click from the screen to
the bus. That covers almost everything.

For the format itself see [`ecu-format.md`](ecu-format.md); for the wire protocols
see [`protocols.md`](protocols.md); for why the port is shaped this way see
[`plan.md`](plan.md).

---

## 1. The packages, and why the boundaries fall where they do

```
core      ── types for the database format, and the branded name types
codec     ── bit extraction and packing            (port of ecu_data.py)
db        ── index, lazy loading, layout binding   (port of ecu_database/ecu_file)
link      ── EcuLink: a byte channel + the simulated one behind demo mode
elm       ── the ELM327 driver                     (port of elm.py)
session   ── the seam between db and elm, and the write gates
screens   ── refresh planning, decode onto widgets, twips geometry
i18n      ── translation overlay, resolved at the render boundary
```

Two boundaries carry real weight:

**`elm` must not import `db`, and `db` must not import `elm`.** A driver has no
business knowing about a database, and vice versa. Everything that needs both —
"configure the adapter for _this_ ECU" — lives in `session`, which is why that
package exists at all despite being small.

**`link` sits between `screens` and `elm`.** `SimulatedLink` and `ElmLink` are
interchangeable, so the entire UI is identical with or without a vehicle. That is
what keeps demo mode a genuine development path rather than dead code that rots.

`serialport` lives in `apps/cli`, not in `elm`: it is native and Node-only, and
importing it from the driver would drag it into the browser bundle. The driver
defines `ElmTransport`; each host supplies its own implementation.

---

## 2. A value's journey

### Startup — one 118 KB fetch

`EcuDatabase.open()` reads `index.json`: 1,580 summaries plus pre-computed group,
project and protocol facets. Nothing else is loaded. The original walks the whole
archive at startup and holds every target in memory; here the index is the only
eager read.

### Choosing an ECU

The catalogue filters the index in memory. Vehicle leads, because nobody arrives
knowing an ECU's name — they know the car. Project codes are shown as model names
via `projectLabel()`, generated from DDT4All's own `resources/projects.json`; the
code remains the value, since it is what the index matches on.

### Loading it — typically 29 KB

`loadEcu(slug)` fetches `ecu/<slug>.json` and:

- applies `ecu_data.py`'s constructor defaults to every entry in `data{}`
  (`resolveDataDictionary`), so nothing downstream has to remember that absent
  `bitscount` means 8;
- builds a `BoundRequest` per request — the definition plus the ECU's data
  dictionary and endianness, which is everything the codec needs.

The cache is keyed by slug and holds the **in-flight promise**, so two concurrent
screen opens share one fetch. A rejection is _not_ cached, so a transient network
failure stays retryable.

### Preparing the screens

`loadLayout(slug)` fetches the layout and runs `prepareLayout`, which checks every
cross-reference and returns a model the renderer can draw without guarding:

- a widget whose request is missing is dropped (0 in the database);
- a widget whose caption names absent data is dropped (24);
- a display reading a field its request doesn't return is dropped (6);
- **an empty caption is a decoration, not a break** (1,421) — a framed box with no
  value;
- `button.send` is always an array, and every entry resolves;
- a category with no surviving screens is dropped as a dead menu node (55).

Everything dropped is reported in `warnings`, so gaps are visible rather than
silent. Widgets get a stable `id` (`display#3`) because the database gives them no
identity and captions repeat.

### Opening a screen

`ScreenRuntime`'s constructor works out the plan, and this is where most of the
efficiency lives:

- **Only displays are polled.** Inputs are filled in as a side effect when some
  display decodes the same data name (`param_widget.py:1204`). An input nothing
  reads stays blank — not `NO DATA`, because no read failed.
- **One request per distinct request name**, not per widget. The richest screen in
  the database has 169 widgets — 168 displays and one input — fed by **2 polled
  requests**. A third request is referenced, by the input, and is never polled.
  Per-widget requests would multiply bus traffic by two orders of magnitude here.
- `manualsend` requests are excluded — 26% of all requests, fired only by buttons.

With a vehicle attached, `attachEcu` configures the adapter for this ECU first.
Repeating it is free: the driver short-circuits when already addressing it, so
moving between screens of one ECU costs nothing.

### Refreshing

```
runtime.refresh()
  link.clearCache()                    ← once per refresh, not per request
  for each planned request:
    link.request(frame, hint)
      ├── SimulatedLink → the request's replybytes, padded
      └── ElmLink → ElmDriver.request → ISO-TP framing → transport → adapter
    decodeStream(request, reply)        ← @ddtx/codec
    distribute fields onto widgets
    fill any inputs sharing a data name
```

`decodeStream` walks the request's receive items and, for each, extracts bits and
formats them. Three different shapes come out and a caller must not assume a
number: ASCII text (`bytesascii`), an enum label (`lists` hit), or **lowercase
hex** (non-scaled miss). Only the `scaled` path yields a decimal.

A field whose bits fall outside the response yields `null` → `NO DATA` in red. A
refused request marks every one of its fields with the NRC. A link failure marks
them as an error. These are three different facts and the UI shows them
differently.

The bus trace shows a button's own exchanges above the refresh's, tagged `sent`.
They are kept separately from the snapshot because a press is followed by a refresh
that replaces it — without that, a write would be invisible under the reads that
came after it, which is the opposite of what you need when verifying one.

### Rendering

The canvas is a fixed twip plate: `pixels = twips ÷ uiScale`, one divisor for
everything, nothing reflows. 100% is `uiscale = 8` — the Qt app's own default —
and the stage scrolls rather than shrinking below native, because fitting a
12,000-twip canvas into a 980 px column lands at `uiscale ≈ 12` and captions the
database sized to just fit start wrapping.

Translation happens **here and nowhere else**. `t(namespace, source)` is called in
components; `prepareLayout`, the codec and the link all work on raw strings, so a
translated caption can never be used as a lookup key.

---

## 3. Writing a value

Inputs are editable; displays are not. Which control a field gets is the database's
decision, not a style choice: a `lists` map means a fixed set of choices and gets a
dropdown, anything else gets a text box — exactly the distinction the Qt app makes
between `QComboBox` and `QLineEdit` (`input_widget.py:170`).

Three rules that are easy to get wrong:

**Typed values are scoped by request _and_ data name.** An input belongs to one
request and contributes only to that request; the same data name under a different
request is a different field. The original keys this
`inputdict[requestName].getDataByName(dataName)`, and `InputValues` matches it.

**A field with no supplied value keeps whatever `sentbytes` already holds.** Not
laziness — the original notes that `ReadMemoryByAddress` on the S3000 depends on the
template's own `MEMSIZE` when no input offers one (`param_widget.py:965`).

**A dropdown carries the raw label, never the translation.** The write path looks
the label up in `data.items` to recover the integer, so a translated one would
encode the wrong byte. The option's _text_ is translated; its _value_ is not.

An edited box is outlined blue, because the number on screen is then no longer the
ECU's. A refresh will not overwrite it — losing what someone is typing to an
auto-refresh tick would be its own kind of bug — and double-clicking reverts to the
last read value.

Every stream is built **before anything is sent**. A value that will not encode
aborts the whole press with the offending field named and marked, because a button
often fires several requests in order and sending the first two before discovering
the third is malformed would leave the ECU part-way through a change.

## 4. A click's journey

Reading is safe. Writing is not, and a browser tab breaks three assumptions the Qt
app relies on: it can be backgrounded (timers throttled mid-sequence), duplicated
(two tabs, one adapter), or closed mid-write. So every click that could put bytes
on a live bus goes through one place:

```
pressButton(uniquename)
  demo mode?            → straight through; there is nothing to protect
  live?
    checkWriteGates     → writes enabled? tab visible? else refuse with a reason
    confirmationPrompt  → the database's own warning if it has one
    withAdapterLock     → Web Locks, ifAvailable — refuse rather than queue
    runtime.pressButton → each send entry, after its Delay
  refresh()
```

Writes are **off by default and never remembered** across a connection: the next
vehicle is a new decision. `buttonGate()` is exposed so a blocked button looks
blocked — dashed red, disabled, reason in the tooltip — rather than looking
pressable and silently doing nothing.

---

## 5. Demo mode

`SimulatedLink` replays each request's stored `replybytes`. That data is sound —
94.4% coverage, and its first byte is the positive-response SID in 74,513 of
74,528 sampled cases — but **11.7% of replies are shorter than their own
`minbytes`**, and on the richest screen that means all 169 widgets reading
`NO DATA`. Hence three fill modes, `pad` by default:

| Mode        | Behaviour                                                                  |
| ----------- | -------------------------------------------------------------------------- |
| `canned`    | `replybytes` verbatim — exactly what the Qt app's demo mode shows          |
| `pad`       | Canned, extended with generated bytes to the length the fields need        |
| `synthetic` | All generated. Useful for seeing how long values get in a French-sized box |

Generated bytes are deterministic per request name, so a screen looks the same on
every read instead of flickering; `drift` opts into variation. A generated frame
still leads with the positive-response SID, because `firstbyte` is 1-based
_including_ it.

It is not a vehicle simulator. Values are arbitrary and not self-consistent, and
the UI says so.

---

## 6. Two traps that have each bitten more than once

**Strings are keys.** `data{}` is keyed by the French label and a widget's `text`
is a lookup into it. Translate in place and every reference dangles. Worse, `lists`
labels are looked _back_ up to recover the integer on write
(`ecu_request.py:175`), so a translated label sends the wrong byte — on a real
vehicle, in a way no read-only test catches. `@ddtx/core`'s branded `DataName` and
`RequestName` exist to keep the two roles apart.

**Reactive reads must happen unconditionally.** In the Svelte app, three bugs have
had the same shape: a function reading non-reactive module state, so the compiler
registered no dependency and the UI silently stopped updating. The worst was
`isLive()` written as `driver !== null && app.linkKind === "elm"` — JavaScript
short-circuits on the null driver, the reactive read never happens, and the write
gates stopped _showing_ while still correctly _refusing_. Read the reactive value
first.

---

## 7. What is verified, and how

| Layer      | How                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `codec`    | **508,066 differential vectors** against the real Python codec — 8,066 synthetic plus 500,000 from 400 real ECUs |
| `db`       | 26 unit tests, plus a run over all 1,580 ECUs pinning the integrity totals                                       |
| `link`     | 18 tests over fill modes and frame matching                                                                      |
| `screens`  | 16 tests over planning, refresh, input filling, presend, buttons                                                 |
| `elm`      | 58 tests against `MockElm`, including driver→codec end to end on decoded values                                  |
| `session`  | 24 tests, the gates tested for what they **refuse**                                                              |
| `i18n`     | 12 tests over key stability and scope resolution                                                                 |
| `apps/cli` | 10 tests over the measurement logic                                                                              |
| `apps/web` | Driven by Playwright against a fake `navigator.serial` that speaks ELM327                                        |

The differential harness is the reason the codec is trusted: it is a literal
translation, and the only convincing proof of a literal translation is byte-for-byte
comparison with the thing it was translated from. It found five bugs that reading
the code did not — `Number("")` being `0`, `toFixed` vs round-half-even,
`TextDecoder` substituting U+FFFD where `errors="ignore"` drops, and two
`str(float)` formatting differences.

**Not verified without hardware:** `webSerial.ts` against a real cable, and real
timing. That is what `pnpm cli bench` is for.
