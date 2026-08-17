# ddtx documentation

Five documents, in the order they are useful.

|                                        |                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [**architecture.md**](architecture.md) | How it works. Follows one value from the database to the screen and one click from the screen to the bus, which covers most of the system. Start here              |
| [**ecu-format.md**](ecu-format.md)     | Reference for the ECU database format — every field, measured over all 1,580 ECUs, with the quirks and the outright data faults. No such reference exists upstream |
| [**protocols.md**](protocols.md)       | What goes on the wire: ISO-TP framing, the AT sequences and why each command is there, K-line init modes, fault reads, and what a browser cannot reach             |
| [**plan.md**](plan.md)                 | Why the port is shaped this way. Feasibility analysis, measured database survey, the reuse audit and its licensing conclusion, ranked risks, roadmap               |
| [**i18n-overlay.md**](i18n-overlay.md) | The translation overlay. The database's strings double as its primary keys, which is what makes this non-obvious                                                   |

Package-level notes live next to the code:
[`packages/elm`](../packages/elm/README.md) ·
[`apps/cli`](../apps/cli/README.md) ·
[`apps/web`](../apps/web/README.md) ·
[`tools/db-split`](../tools/db-split/README.md) ·
[`tools/golden`](../tools/golden/README.md) ·
[`i18n`](../i18n/README.md)

---

## The five things worth knowing before changing anything

**1. The database's strings are its primary keys.** `data{}` is keyed by the French
label, and a layout widget's `text` field is a lookup into it. Rewriting one
dangles every reference. Worse, enum labels are looked _back_ up to recover the
integer on write, so a translated label sends the wrong byte to a real vehicle —
which no read-only test catches. Hence the overlay, and hence the branded name
types in `@ddtx/core`.

**2. `firstbyte` is 1-based and byte 1 is the response SID.** The easiest thing in
the whole port to get wrong by one, and it is invisible until a reading is subtly
wrong. `packages/elm/src/endToEnd.test.ts` pins it.

**3. The codec is a literal translation, quirks included.** Non-scaled values
render as lowercase hex; `signed` is honoured only for 1- and 2-byte values; write
overflow is not validated. Do not tidy any of it without re-running the golden
vectors — 508,066 of them, diffed against the real Python.

**4. An empty widget caption is a decoration, not a broken reference.** 1,421 of
them, 98% of everything that looks dangling. Treating them as errors blanks out a
large share of screens.

**5. Writes are gated, and the gates are the point.** A browser tab can be
backgrounded, duplicated, or closed mid-write — none of which the Qt app has to
survive. `packages/session/src/guard.ts` is tested for what it _refuses_, because a
gate that fails open is worse than no gate: the UI would report protection that is
not there.

---

## Current state

Everything that does not need a vehicle is done: the codec (verified against the
Python), the database layer, demo mode, the browser client, the ELM327 driver
(verified against a scripted adapter), the write gates, and the CLI.

The one item on the critical path needs hardware:

```sh
pnpm cli probe --port /dev/tty.usbserial-XXXX
pnpm cli bench --port /dev/tty.usbserial-XXXX
```

`bench` answers whether software flow control (`cfc0`) is viable over a link whose
latency cannot be controlled from a web page.

**Answered on 2026-08-17** for one adapter: 5.8 ms per exchange over Web Serial
with an sd of 0.2 and no stalls, so no latency floor and no Chrome penalty. `cfc0`
is viable; `manual` remains the default because the adapter answers flow control
without a host round trip at all. Numbers and caveats in
[`protocols.md`](protocols.md#24-flow-control-the-open-question).

What still needs a vehicle: real ECU response timing, and whether the adapter's own
`CFC1` holds on a live bus — the only thing that would make the `cfc0` fallback
matter.
