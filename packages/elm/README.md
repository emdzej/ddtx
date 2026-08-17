# @ddtx/elm

The ELM327 driver: AT command layer, adapter identification, protocol setup, and
ISO-TP framing done in software.

## Why software ISO-TP

The adapter can frame ISO-TP itself with `AT CAF1`, but DDT4All deliberately runs
`AT CAF0` and builds the PCI bytes by hand, because the automatic mode mis-handles
Renault's longer responses. So `isotp.ts` is not an optimisation — it is what puts
correct bytes on the wire, and it is where a mistake would be least visible.

## Built and tested without hardware

Almost all of a driver is *correctness*: does it send the right AT sequence, frame
requests properly, reassemble what comes back. All of that is verifiable against
`MockElm`, a scripted adapter that echoes commands, terminates with `\r>`, tracks
the AT settings the driver depends on, and answers OBD frames from a handler you
supply — so tests exercise the same echo-cancellation and prompt-parsing paths a
real adapter would.

58 tests cover it, including `endToEnd.test.ts`, which runs the driver's output
through the real `@ddtx/codec` and asserts on decoded values (375 rpm, 80 °C, a
17-character VIN across three frames) rather than on bytes. That pins the
convention most likely to be off by one: `firstbyte` is 1-based **including** the
response SID.

What a mock cannot verify is `webSerial.ts` — the bytes actually reaching a cable.
That is what the phase-0 car session is for (`docs/plan.md` §6.1).

## Framing strategies

| Strategy | Meaning |
| --- | --- |
| `manual` *(default)* | `AT CFC1` — the adapter handles flow control, we frame by hand |
| `stpx` | STN adapters with firmware ≥ 4.2.0; `STPX` offloads framing entirely |
| `cfc0` | `AT CFC0` — *we* answer flow-control frames, in time |

`identify()` picks `stpx` when the adapter reports an STN part new enough, else
`manual`. **`cfc0` is deliberately not implemented.** It is the path that needs
millisecond turnaround from a device read through Chrome's buffering, with the
FTDI latency timer unreachable from a page — the open question in `docs/plan.md`
§6.1. Implementing it before measuring would be guessing.

## Layout

```
transport.ts   ElmTransport: a delimiter-oriented byte pipe
webSerial.ts   the browser implementation (untested without hardware)
mock.ts        MockElm: a scripted ELM327
isotp.ts       framing and reassembly — pure, exhaustively tested
driver.ts      AT layer, identification, protocol setup, requests
link.ts        ElmLink: presents the driver as @ddtx/link's EcuLink
```

`ElmLink` and `SimulatedLink` are interchangeable, so the screen runtime and the
UI need no changes when a vehicle is attached, and demo mode stays the offline
development path rather than becoming dead code.

## Preserved behaviours

Changing any of these would change what the adapter does:

- **`"TIMEOUT"` is a marker inside the returned string**, not an exception. The
  original's `Port.expect` appends it and callers test for it by string search.
- **The L2 response cache is cleared per screen refresh**, not per request — a
  screen commonly asks for the same request twice.
- **A negative response comes back as text** (`"7F 21 11"`) for the caller to
  inspect, because the NRC is what explains the refusal.
- **`AT CAF0`, `AT S0` and `AT AL` are re-applied after `AT SP`**, because several
  clones reset them on a protocol change and all three are load-bearing.
