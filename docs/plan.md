# ddtx — feasibility analysis, architecture, and roadmap

Written 2026-08-17 from an analysis of `ext-ddt4all` @ `fc2f49f` and the ECU
database in `data/ecu.zip`. Every number below was measured, not estimated;
where something is unmeasured it says so.

---

## 1. Verdict

Feasible, and materially easier than the INPA port (`bimmerz/inpax`) was.

The reason is architectural: **DDT4All has no scripting language.** INPA needed
a bytecode parser, disassembler, and interpreter. DDT4All's ECU database *is*
the program — declarative request templates, bit-field decode rules, and
absolutely-positioned screen definitions. There is nothing to interpret.

Roughly 4k LOC of pure, side-effect-free Python carries most of the value and
is testable offline with no car attached. The PyQt5 UI is a rewrite, not a port,
but the screen model is far smaller than its LOC count suggests (§4).

---

## 2. What DDT4All actually is

| Layer | LOC | Verdict |
|---|---|---|
| `core/ecu` — DB load, request build, bit/scale codec, autoident scan | 2,041 | **Mechanical port.** Pure string/bit math, zero I/O |
| `core/elm` — ELM327 driver, serial port, ISO-TP framing | 2,747 | **Rewrite as async.** Blocking `expect()` → promise reader. The hard part |
| `core/parameters/helpers.py` — XML→JSON DB conversion | 472 | Build-time tool; port to a Node CLI or leave in Python |
| `core/doip` + `core/usbdevice` | 746 | **Cannot run in a browser** (raw TCP, libusb) |
| `options.py` module globals | 315 | Becomes settings store + injected session |
| `ui/*` PyQt5 | 7,773 | **Rewrite.** ~2.5k is the runtime screen renderer (needed), 2.0k the DB editor (defer), 2.9k window chrome |
| `plugins/*` (14 files) | 1,685 | Defer — scripted request sequences, easy later |

Data model, all of it directly representable in TypeScript:

- `EcuFile` → protocol (CAN / KWP2000 / ISO8), CAN tx+rx IDs, baud, endianness,
  requests, data, devices
- `EcuRequest` → `sentbytes` hex template + `sendbyte_dataitems` /
  `receivebyte_dataitems`, each `{firstbyte, bitoffset, ref, endian}`
- `EcuData` → `bitscount`, `signed`, `scaled` (step/offset/divideby/format/unit),
  `lists` (enum maps), `bytesascii`, `binary`
- Screens → `categories → screens → {labels, displays, inputs, buttons}`

`EcuData.setValue` / `getHexValue` (`ecu_data.py:181-437`) are the crown jewels,
including the little-endian three-step bit packing the original author admits he
reverse-engineered by guesswork. **Port these first, character by character,
with golden tests.** If they are right, everything downstream is right.

Encouraging: a headless CLI already exists (`src/ddt4all/cli/`), so core is not
hopelessly welded to Qt. The one structural problem is the `options.elm` module
global — 92 references across 20 files. In ddtx that becomes an injected
session object. Trivial change, touches everything.

---

## 3. The database, measured

`data/ecu.zip` — 104.6 MB compressed, **1.278 GB uncompressed**, 3,749 files,
~12:1 compression.

| Part | Count | Uncompressed | Avg | Max |
|---|---|---|---|---|
| `db.json` index | 1 | 1.5 MB | — | — |
| ECU definitions `.json` | 1,581 | 543 MB | 352 KB | 3.7 MB |
| Screen layouts `.layout` | 1,580 | 672 MB | 436 KB | 5.4 MB |
| Images `.gif` | 582 | 3.4 MB | — | — |

1,580 indexed ECUs — **CAN 1,363, KWP2000 195, ISO8 21**, one blank — across 171
groups and 140 vehicle projects. Per ECU: avg 393 requests / 1,186 data
definitions; worst case 4,219 / 14,318. Endianness in a 150-ECU sample was 140
Big / 10 Little, so the little-endian bit path is ~7% of the fleet — needed, not
skippable. Index timestamps are 2019: this is a frozen snapshot, not a moving
target. That matters for the i18n key design (§7).

`db.json` is a clean flat index, `filename → {protocol, autoidents[], ecuname,
address, group, projects[]}` — load eagerly, search client-side.

**The 588 GIFs are dead weight.** No layout in the database references any
graphics filename, so they are DDT2000 leftovers. `db-split` drops them, which
removes image handling from the renderer's scope entirely.

### 3.1 Delivery: split at build time, never ship the zip

Definitions and layouts are already separate files, which is exactly the split
we want — the codec needs only `.json`, and `.layout` is fetched only when
someone opens a screen. `tools/db-split` emits `index.json` plus
`ecu/<slug>.json` and `layout/<slug>.json`, byte-identical to their zip entries
(verified over 600 files), with optional `.gz`/`.br` siblings for static hosts.

Measured on the wire, gzip -9, sampled over 300 ECUs:

| | p50 | p90 | max | mean |
|---|---:|---:|---:|---:|
| `ecu/<slug>.json` | 17.6 KB | 116.3 KB | 447.2 KB | 40.6 KB |
| `layout/<slug>.json` | 8.9 KB | 47.6 KB | 175.2 KB | 17.9 KB |
| both, opening one ECU | **29.1 KB** | 157.8 KB | 532.7 KB | 58.4 KB |

`index.json` is 1.1 MB raw → **118 KB gzipped**. So a cold start costs 118 KB and
opening an ECU typically costs another 29 KB. Shipping the monolith would have
cost 104 MB and a 1.3 GB in-browser expansion.

Slugs are the zip entry name minus `.json`, which is URL-safe throughout the
snapshot: no characters outside `[A-Za-z0-9._-]`, no case-insensitive collisions,
max length 109.

### 3.1.1 Cross-reference integrity

Every reference in the database was checked, three times independently (Python
against the zip, `db-split`'s validator, and `@ddtx/db`'s loader — all agreeing):

| Case | Count | Of | Handling |
|---|---:|---:|---|
| widget caption is `""` | 1,421 | 1,021,519 | **valid decoration** — draw the box, no value |
| widget names absent data | 24 | 1,021,519 | drop, warn |
| widget names absent request | 0 | 1,021,519 | — |
| `button` has no `send` key | 1,367 | 104,276 | keep, renders inert |
| `button.send` names absent request | 70 | 200,604 | drop the entry (15 buttons go inert) |
| `presend` names absent request | 1 | 11,403 | drop the entry |
| dataitem names absent data | 70 | 2,200,912 | ECU-level; codec throws |
| category names absent screen | 0 | 40,179 | — |
| category lists no screens | 55 | 10,067 | drop the dead menu node |

The database is therefore ~99.99% internally consistent, but not perfectly, so
the loader must prune rather than throw. The empty-caption case is the one that
matters: it is 98% of all apparently-dangling widgets and is not an error at all.
Treating it as one would blank out a large share of screens.

Three ECUs define a data entry literally named `""`; the Qt app binds their 5
empty-caption widgets to it, so the loader resolves before falling back to
"decoration" rather than the other way round.

### 3.2 The screen schema is rigid — good news for the renderer

Sampled 200 layout files: 4,899 screens, 220,599 widgets. Every widget of a
given type had an **identical key set, every time**. Four widget types, no
variants, no optional fields:

```
displays / inputs  {rect, color, fontcolor, font, text, request, width}
labels             {bbox, color, fontcolor, font, text, alignment}
buttons            {rect, font, text, messages, uniquename, send[{RequestName, Delay}]}
presend            [{RequestName, Delay}]          // run on screen entry
```

Coordinates are VB-style twips on a fixed canvas (`16380×10020`, `9000×6000`,
`12060×9060`, …). Colours are **already** `rgb(r,g,b)` CSS strings. Fonts are
`{name, size, bold, italic}`. Label alignment is `"0" | "1" | "2" | ""`.

This maps to absolutely-positioned CSS with one scale factor and essentially no
translation layer. Only anomaly in 13,777 buttons: **122 have no `send` key** —
needs a null guard.

`displays[].request` / `inputs[].request` name a request; `.text` names a data
definition within it. Those are **string references into the ECU JSON**, which
is why translation must be an overlay (§7).

---

## 4. Architecture

```
packages/
  core        shared types (DB schema, branded name types)
  codec       EcuData/DataItem encode+decode — pure, exhaustively tested
  db          index + ECU/layout loading over a VFS, caching
  elm         ELM327 driver: transport, AT layer, protocol init, ISO-TP
  session     connect-to-ECU, request/response, L2 cache, keepalive
  scanner     autoident sweep
  screens     screen model, request scheduling, value binding
  i18n        translation overlay resolution (§7)
  web-ui      Svelte components — the four widget types + chrome
tools/
  db-split    ecu.zip → per-ECU static tree + index
  golden      generate codec test vectors from the Python original
apps/
  web         the SPA
  cli         Node serial — drive the ELM driver from a terminal
```

`apps/cli` matters more than it looks: it lets us iterate on the ELM driver
against a real car with logging, before any UI exists.

### 4.1 Identity vs display — a hard rule

DB strings are simultaneously identifiers and display text. The port must
separate the two roles at the type level:

- Reference resolution uses **raw DB strings**, always.
- Translation happens **only at the render boundary**.

Enforce with branded types in `core` (`RequestName`, `DataName`) that have no
`toString` path into a component, and a `t()` that only accepts them alongside a
resolved locale bundle. Getting this wrong silently breaks lookups on any locale
but French, and it will not be caught by a French-locale test run.

---

## 5. Reuse audit

Checked against `bimmerz/ediabasx`, `bimmerz/inpax`, `bimmerz/bimmerz-core`.
Conclusion: **copy first, extract shared packages later.**

| Asset | Verdict |
|---|---|
| `ediabasx-interface-serial` → `WebSerialTransport` | **Copy ~150 of 330 lines, don't depend.** See below |
| `ediabasx-interface-serial` → `ftdiLatencyTimer.ts` | Not reusable; documents a real dead end (§6.1) |
| `bimmerz-vfs` (`CachedHttpDirectory`, `openCacheBackend`) | Best genuine fit — but licence-blocked (§5.1) |
| `bimmerz-ui` / `theme` / `logger`, `apps/web` shell | Reuse the *patterns*; copy components as needed |
| `GatewayClient` / `ediabasx-server` | Concept transfers, code doesn't — it's ediabas-shaped RPC (jobs/SGBDs). ddtx wants a dumb serial-bytes-over-WebSocket relay |
| `protocol-kwp` / `-uds` / `-doip` | **Not applicable.** They implement protocols natively; DDT4All delegates all of it to the ELM327's AT layer |

**Why `WebSerialTransport` can't be a dependency.** Its
`read(length, timeoutMs)` (`webSerialTransport.ts:219`) is length-driven; ELM327
is delimiter-driven — read until the `>` prompt. Emulating that means either
`read(1, t)` in a loop (a promise plus two timers per byte) or a big length
relying on the 20 ms telegram-idle cutoff — which truncates valid ELM replies,
since the ELM legitimately pauses longer than that during `SEARCHING...` and
multi-frame collection. `bufferedData` is private with no `onData`, `peek`, or
`readUntil`, so a delimiter reader cannot be layered on top — only added
*inside*. That is base-package churn on the very first roadblock.

Worth lifting is the *lifecycle*, not the read model: open/close/read-loop
unwind ordering so the next `open()` doesn't race a cancelled reader;
`configure()`'s close-and-reopen (exactly what `ATBRD` / `ST SBR` baud switching
needs); `setDtr`/`setRts`/`setBreak`; and the `WebSerialPortLike` local-typing
trick that avoids needing DOM Serial lib types. Lands as a self-contained
~250-line `ElmSerialPort` with `readUntil(delimiter, timeout)`.

### 5.1 Licensing constraint

`ediabasx`, `inpax`, and `bimmerz-core` are all **PolyForm Noncommercial 1.0.0**,
and neither `bimmerz-vfs` nor `ediabasx-interface-serial` declares its own
`license` field, so both inherit it. DDT4All is **GPL-3.0-or-later**.

PolyForm's noncommercial field-of-use restriction is an "additional restriction"
that GPLv3 §7 forbids, so a GPLv3 ddtx **cannot depend on those packages as
licensed** — including `bimmerz-vfs`. We hold the copyright, so the fix is ours
to make: dual-license (MIT/Apache-2.0) anything ddtx should consume. Copying
code into ddtx sidesteps this entirely for now.

Separately worth reconciling: several `inpax` packages declare
`"license": "MIT"` in `package.json` while the repo `LICENSE` says PolyForm.
Those two statements contradict each other for anyone consuming from npm.

### 5.2 When to extract a shared package

Only when all three hold: a second consumer actually exists; the interface has
stopped moving; and it is relicensed permissively so both a GPL app and a
PolyForm app can consume it. On current evidence the only plausible candidates
are the VFS layer and the bare serial-port lifecycle. **The ELM driver should
stay in ddtx** — nothing else we own speaks ELM.

---

## 6. Risks, ranked

### 6.1 ISO-TP flow-control timing — the go/no-go

`elm.py` is 1,962 lines mostly because the ELM327's automatic flow control is
inadequate, so DDT4All does software flow control: `send_can_cfc0` sets
`AT CFC0` and hand-sends flow-control frames between blocks. That needs tight
turnaround from a device read through Chrome's buffering.

**The FTDI latency timer cannot be fixed from a web page.** `ftdiLatencyTimer.ts`
documents this explicitly: Linux needs a sysfs write, macOS a native `ioctl`,
Windows registry + admin; browser is a silent no-op. The 16 ms default penalty
therefore stands.

Mitigations, all outside the page: prefer the **STPX path** (`send_can_cfc`, on
OBDLink/STN adapters) which offloads framing to the adapter and cuts round-trips;
have the user set the latency timer manually; pick a non-FTDI adapter; or run a
host-side relay. Treat `CFC0` as a measured, degraded fallback.

**Use an OBDLink SX as the reference adapter**; treat cheap ELM clones as
best-effort. Validate in phase 0 — this decides the shape of everything above it.

### 6.2 Web Serial is desktop-only

Chrome/Edge desktop and ChromeOS. **Not Android, not iOS, not Firefox, not
Safari.** This rules out phones and tablets, which is where a lot of real
diagnostic work happens. Android Chrome does have WebUSB, so the mobile path is
a WebUSB CDC-ACM/FTDI/CH340 driver. Decide early if mobile matters — it changes
the transport abstraction, so `packages/elm` must take a transport *interface*,
not a Web Serial port.

Bluetooth adapters are out entirely: Web Bluetooth is BLE-only, classic SPP is
not exposed. WiFi ELM (TCP), DoIP (TCP 13400), and the libusb CAN device also
can't be reached from a page — all four need the host-side relay.

### 6.3 Writes on a live car

VIN writing, card programming, EEPROM plugins. A backgrounded or throttled tab
mid-write is a failure mode the Qt app never had. Needs Page Visibility guards,
`navigator.locks`, and explicit confirmation gates before any write reaches the
bus. Do not ship write support without these.

### 6.4 Database provenance

The DB is Renault-derived and not ours to redistribute. Keep ddtx
**data-agnostic**: the user points it at their own database, exactly like the
inpax install picker. Ship no ECU data.

---

## 7. Translation overlay

The ECU database is French, and its strings are also its primary keys. See
[`i18n-overlay.md`](i18n-overlay.md) for the full design. Summary: a tiered,
content-keyed overlay resolved at the render boundary only; original files are
never modified.

---

## 8. Demo mode

`options.simulation_mode` in the original makes `send_request` return the
request's `replybytes` instead of calling the ELM. That canned data is better
than it sounds and worse than it needs to be:

- 510,615 of 541,061 requests carry one (94.4%), all valid hex;
- the first byte is the positive-response SID in 74,513 of 74,528 sampled cases,
  so it has exactly a live response's frame layout — substituting it is sound;
- but **11.7% are shorter than their own `minbytes`**, and on a real screen that
  is severe: the richest screen in the database (169 widgets over 3 requests)
  renders 169 × NO DATA on stored replies alone.

So `SimulatedLink` offers three fill modes — `canned` (faithful), `pad`
(default: canned, extended to the length the fields need), and `synthetic`. A
generated frame still leads with the positive-response SID, because `firstbyte`
is 1-based *including* it and some screens read byte 1 directly.

Generated bytes are deterministic per request name, so screens don't flicker
between refreshes; `drift` opts into variation.

### 8.1 What running it caught

Three defects that reading the Python did not surface:

1. **Inputs are not polled.** Refresh iterates displays only; an input is filled
   in as a side effect when some display decodes the same data name
   (`param_widget.py:1204`). An input no display feeds stays blank — showing it
   as NO DATA claims a read failed when none was attempted.
2. **A display may only read a field its request returns.** `prepareLayout` now
   drops the 6 database-wide displays that name a field absent from
   `receivebyte_dataitems`, as the Qt app does by never creating the widget.
3. **`HttpDbSource` held a detached `fetch`**, which browsers reject with
   "Illegal invocation". Every Node test used `MemoryDbSource`, so nothing caught
   it until the app ran.

## 9. Roadmap

**Phase 0 — spike (1–2 days).** Web Serial → `ATZ`/`ATI` → `ATSP6` → read one
`22xx` from a real ECU, with timing instrumented. Answers §6.1 before anything
is built on top of it.

**Phase 1 — codec + db (~1 week). ← current.** No car needed.
- [x] `packages/core` — types from the measured schema, with branded name types
      enforcing the identity/display split (§4.1)
- [x] `packages/codec` — `EcuData.setValue/getHexValue/getDisplayValue/getIntValue`,
      `EcuRequest` build/decode, plus `python.ts` (a CPython compatibility layer:
      `float()`, `"%.Nf"`, `str()`/`repr()`, `errors="ignore"` UTF-8)
- [x] `tools/golden` — differential harness against the Python original.
      **508,066 vectors passing** (8,066 synthetic + 500,000 from 400 real ECUs;
      214,649 decodes yielding 73,299 distinct display strings, 118,929 encodes
      mutating bytes, 22,775 exercising the fail-closed divergences). Five real
      bugs found, all invisible to code review — see `tools/golden/README.md`
- [x] `tools/db-split` — the static tree from §3.1, plus a validation report.
      15 s over the whole archive; output verified byte-identical to the zip
- [x] `packages/db` — `DbSource` (http / memory / cached), `EcuDatabase` with a
      lazy per-ECU cache, `prepareLayout` binding and pruning per §3.1.1, and
      `matchAutoIdent` (port of `EcuIdent.checkWith` / `checkApproximate`).
      26 unit tests, plus an opt-in run over all 1,580 ECUs that pins the
      integrity totals — 39,665 screens and 1,021,495 bound widgets in 10 s

Everything in the codec uses `BigInt`, not `number`, for the bit math: values
run up to 357 bytes wide, so `int(x, 2)` in Python routinely exceeds float64's
exact range and `number` would silently corrupt VINs and DTC records.

**Phase 1.5 — demo mode (done, out of order).** Built before the driver because
it needs no hardware and it de-risks everything above the link:
- [x] `packages/link` — `EcuLink` (a byte-oriented request/response channel) and
      `SimulatedLink`, which replays the database's own `replybytes`. Three fill
      modes, because a faithful replay leaves most fields blank (§8.1)
- [x] `packages/screens` — `ScreenRuntime` (request planning, refresh, decode onto
      widgets, presend, buttons) and `geometry` (twips → CSS, the Qt font and
      caption/value split model)
- [x] `apps/web` — the browser client: catalogue, screen index, canvas renderer,
      bus trace, inspect overlay

**Phase 2 — ELM driver.** Built without hardware, against a scripted adapter:
- [x] `packages/elm` — AT layer, adapter identification, protocol setup for CAN /
      KWP2000 / ISO8, software ISO-TP, `MockElm`, and the Web Serial transport.
      `cfc0` deliberately unimplemented until measured (§6.1)
- [x] `packages/session` — `attachEcu` (the seam between database and driver) and
      the write gates (§6.3)
- [x] `apps/cli` — `ports`, `probe`, `bench`, `read`, `screens`. `bench` is the
      phase-0 instrument
- [x] Browser connect flow, with the mode strip driven by the link rather than a
      hardcoded string
- [ ] **Phase 0 measurement, on a vehicle.** Everything above is verified against
      a mock; what remains is real timing

**Phase 3 — read-only screens (1–2 weeks).** Mostly done by phase 1.5; what
remains is driving it from a real link.

**Phase 4 —** inputs and buttons (writes, gated per §6.3), DTC read/clear,
autoident scanner.

**Deferred:** DB editor, sniffer, plugins, DoIP, host relay, WebUSB/mobile.
The DB editor is incidentally where a web version could beat the Qt app
outright — collaborative ECU definition editing suits a browser far better than
PyQt5.
