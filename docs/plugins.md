# Plugins

DDT4All ships fourteen plugins: a VIN CRC calculator and thirteen procedures — UCH,
EPS and airbag resets, card programming, a Zoe water-pump counter reset. They are
Python modules loaded with `SourceFileLoader` from a folder, each exporting
`plugin_name`, `category`, `need_hw` and a `plugin_entry()` that opens a PyQt5 dialog.

Here they are **WebAssembly modules with no imports**. This document is why, and what
the contract is.

---

## 1. What a plugin actually does

Worth establishing before designing anything, because it decides the shape. The API
surface all fourteen use, counted across the original sources:

| Call                                 | Uses | ddtx equivalent            |
| ------------------------------------ | ---- | -------------------------- |
| `ecu.requests[name]`                 | 57   | `ecu.requests.get(name)`   |
| `request.send_request({...})`        | 36   | `EcuRequest` + `ElmDriver` |
| `options.simulation_mode`            | 20   | demo mode                  |
| `options.main_window.logview.append` | 20   | the bus trace              |
| `request.build_data_stream({})`      | 19   | `buildDataStream`          |
| `options.elm.start_session_can(...)` | 17   | `driver.request(...)`      |
| `EcuFile(slug, True)`                | 12   | `database.loadEcu(slug)`   |

So a plugin is: **load a named ECU, send named requests in a sequence, decide based on
what came back, show the result.** Not one of them computes anything the database
cannot already express — except `vin_crc`, which is pure arithmetic and touches no
hardware at all.

That is the important finding. A plugin is an **I/O sequence**, and it is why the
image-filter ABI in `svelte-wasm-plugins` cannot be reused as-is.

---

## 2. Why `process(ptr, len)` does not work here

The reference project's plugins export `process(ptr, len, width, height, ...)`, mutate
a pixel buffer in place, and return. That works because an image filter is **pure
compute over bytes already in memory**.

A UCH reset is not. It has to open a diagnostic session, read a value, decide, write,
and read back to confirm — and every one of those is an async round trip to a vehicle
that takes milliseconds and may fail. A synchronous export cannot express it, and
WebAssembly cannot await.

Two ways out:

| Approach                           | Cost                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Import host functions (`env.send`) | Needs JSPI or Asyncify, and **breaks the zero-import property**         |
| **Host-driven step machine**       | Plugin returns a command, host performs it, host calls back. No imports |

The step machine wins on two counts, and the second matters more than the first:

1. **The sandbox stays airtight.** Legit plugins compile with zero imports, so they
   load with an empty `importObject`. There is literally no host function to call —
   the same property the reference project's security story rests on.
2. **A plugin cannot reach the bus.** It never holds a driver. It _asks_, and the host
   decides — which means every write a plugin requests goes through the same write
   gates a button press does: writes enabled, tab visible, adapter lock held, operator
   confirmed. See [`plan.md`](plan.md) §6.3.

That second point is a real improvement on the original, where a plugin calls
`options.elm.start_session_can()` directly and nothing can stop it.

---

## 3. The ABI

Three exports, and that is the whole contract:

| Export   | Signature                     | Purpose                                                  |
| -------- | ----------------------------- | -------------------------------------------------------- |
| `memory` | `WebAssembly.Memory`          | The plugin's isolated linear memory                      |
| `alloc`  | `(size: i32) => i32`          | Bump-allocate, return a pointer                          |
| `start`  | `() => i32`                   | Begin. Returns a pointer to the first command            |
| `resume` | `(ptr: i32, len: i32) => i32` | Given the last command's result, return the next command |

Commands and results are **length-prefixed UTF-8 JSON**: an `i32` byte count followed
by that many bytes. JSON rather than a packed struct because a plugin author reading a
trace should be able to see what happened, and 2 KB of module is not worth optimising.

### Verified, not assumed

A plugin doing string building and JSON under `runtime: stub` with `use: ["abort="]`
compiles to **2,243 bytes with zero declared imports**, instantiates against an empty
`importObject`, and round-trips strings in both directions across a multi-step
sequence. That was checked before any of this was written, because the whole design
rests on it.

### Commands

```jsonc
{ "op": "session", "request": "StartDiagnosticSession.Default" }
{ "op": "read",    "request": "DataRead.($3349) Time Counter…" }
{ "op": "write",   "request": "DataWrite.($3349) Time Counter…", "values": { "…": "0" } }
{ "op": "log",     "text": "Reading low speed" }
{ "op": "ask",     "prompt": "Enter the VIN", "field": "vin" }
{ "op": "done",    "status": "ok" | "failed", "text": "Counters cleared" }
```

The host replies with `{ "ok": true, "values": { … } }` or `{ "ok": false, "error": "…" }`.
A plugin that gets `ok: false` decides what to do about it; the host does not abort on
its behalf, because "the ECU refused" is often the answer a procedure is looking for.

### Manifest

```jsonc
{
  "name": "zoe-waterpump-reset",
  "label": "Zoe water pump counter reset",
  "category": "EVC Tools",
  "ecu": "EVC_3180_RH5_510_V1.1_20210422T184714",
  "capabilities": ["session", "read", "write"],
  "description": "Clears the driving water-pump time counters.",
  "warning": "Erases the water pump counters. Irreversible.",
}
```

`capabilities` is enforced by the host: a plugin declaring only `read` that emits a
`write` command is refused at the command, not at load time — and the refusal is
reported to the plugin, so a badly-declared plugin fails loudly rather than silently
skipping a step.

`ecu` names the definitions the procedure was written against. The host checks the
attached vehicle actually has that ECU before running anything, because a UCH reset
aimed at the wrong module is exactly the kind of mistake worth making impossible.

---

## 4. What is deliberately not carried over

**The PyQt dialogs.** Every original plugin builds its own window — tables, buttons,
labels. Reproducing that would mean a UI toolkit inside the sandbox. Instead a plugin
`log`s, `ask`s for input, and `done`s with a result; the host renders those three
things consistently. A plugin that genuinely needs a table can emit rows as log lines.

**`need_hw = False` as a special case.** `vin_crc` is the only one, and rather than
model "plugins that need no ECU", it simply declares no capabilities and never emits a
`read`. The host runs it with no vehicle attached because it never asks for one.

---

## 5. Honest status of the ported procedures

`vin_crc` is pure arithmetic — CRC-16/X-25 over the VIN's ASCII bytes, returned
byte-swapped — and is verified against the algorithm's published check value
(`0x906E` over `"123456789"`). It needs no vehicle and is trustworthy.

The other thirteen are **destructive procedures that cannot be verified without a
car**: airbag module resets, EEPROM writes, card programming. Each names request
names and an ECU slug, and those _can_ be checked against the real database without
hardware — a typo in a request name is a load-time failure rather than a mystery at a
vehicle, and that check runs over the whole corpus. What cannot be checked is whether
the sequence has the intended effect on a real module.

So they are gated: write capability requires the write toggle, the confirmation names
the manifest's own `warning` verbatim, and the UI marks them unverified. That is the
same posture as the rest of the write path, for the same reason.
