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
address, group, projects[]}`. 1.5 MB, ~150 KB gzipped — load eagerly, search
client-side.

### 3.1 Delivery: split at build time, never ship the zip

Definitions and layouts are already separate files, which is exactly the split
we want — the codec needs only `.json`, and `.layout` is fetched only when
someone opens a screen. Serve per-ECU files with brotli/gzip precompression
behind the `db.json` index; cache in OPFS.

- Typical ECU ~800 KB raw → **~65 KB over the wire**
- Worst case ~9 MB raw → ~750 KB

Shipping the monolith would mean a 104 MB download and a 1.3 GB in-browser
expansion. Don't. `tools/db-split` is a phase-1 deliverable.

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

## 8. Roadmap

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
- [ ] `tools/db-split` — the static tree from §3.1
- [ ] `packages/db` — index + ECU/layout loading over a VFS

Everything in the codec uses `BigInt`, not `number`, for the bit math: values
run up to 357 bytes wide, so `int(x, 2)` in Python routinely exceeds float64's
exact range and `number` would silently corrupt VINs and DTC records.

**Phase 2 — ELM driver (2–3 weeks incl. car time).** CAN first (STPX path, then
`CFC0` fallback), KWP2000 fastinit second, ISO8 last.

**Phase 3 — read-only screens (1–2 weeks).** The four widget types, `presend`,
refresh scheduling. The "it actually works" milestone.

**Phase 4 —** inputs and buttons (writes, gated per §6.3), DTC read/clear,
autoident scanner.

**Deferred:** DB editor, sniffer, plugins, DoIP, host relay, WebUSB/mobile.
The DB editor is incidentally where a web version could beat the Qt app
outright — collaborative ECU definition editing suits a browser far better than
PyQt5.
