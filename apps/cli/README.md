# @ddtx/cli

Drive the ELM327 driver from a terminal.

Exists mainly so the **phase-0 car session produces numbers instead of
impressions**. Everything above the transport is the same code the browser runs,
so a measurement here transfers; `--mock` runs every command against the scripted
adapter, so the command structure and output are exercised without hardware.

```sh
pnpm build
pnpm cli ports
pnpm cli probe --port /dev/tty.usbserial-XXXX
pnpm cli bench --port /dev/tty.usbserial-XXXX
```

## Commands

| Command | What it does |
| --- | --- |
| `ports` | List serial ports, marking likely USB-serial bridges |
| `probe` | Reset the adapter, identify it, report capabilities and chosen strategy |
| `bench` | Measure round-trip latency at four distances from the host |
| `read` | Connect to an ECU and read one screen, with the bus trace |
| `screens` | List an ECU's screens and value counts — no adapter needed |

Flags: `--port`, `--baud` (default 38400), `--strategy manual|stpx|cfc0`,
`--tree` (default `data/tree`), `--verbose`, `--mock`, `--mock-latency <ms>`,
`--mock-stn <version>`.

## What `bench` is for

`docs/plan.md` §6.1 asks whether software ISO-TP flow control (`AT CFC0`) can work
over a link whose latency we cannot control. The FTDI latency timer defaults to
16 ms and **cannot be changed from a web page**, so the question is not "is it fast
enough on average" but "is there a fixed per-round-trip floor, and how big".

Four rows, at increasing distance from the host:

| Row | What it isolates |
| --- | --- |
| `AT (adapter only)` | Pure host↔adapter round trip: UART, USB, driver latency timer. No bus |
| `single-frame request` | One frame out, one back |
| `long response (1 write)` | Multi-frame *reply* — the adapter buffers it, so still one round trip. Isolates read volume |
| `multi-frame request (2 writes)` | Two writes, each awaiting a prompt. **The proxy for what `cfc0` costs** |

Reported as a distribution, never a mean — a mean hides exactly the periodic
stalls this is looking for.

**Reading it.** If `AT` clusters tightly just above a multiple of 16 ms, the
latency timer is pacing every exchange and `cfc0` is not viable: it would pay that
floor for every flow-control frame owed to the ECU. Prefer STPX hardware, or the
`manual` strategy where the adapter handles flow control. If `AT` is a millisecond
or two with real spread, the floor is small and `cfc0` becomes worth implementing.

The `multi-frame request / single-frame request` ratio is the second signal: near
2× means each write pays a full round trip; near 1× means writes pipeline.

`bench` prints a hint alongside the numbers, but the numbers are the evidence —
`latencyFloorHint` is a reading aid, and it is tested to stay silent on jitter.

## `--mock` and `read`

`read --mock` builds its replies from the **ECU's own `replybytes`**, extended to
the length its fields need — the same rule demo mode applies. So it exercises the
whole stack (driver, codec, screen runtime) against real definitions and is a fair
rehearsal for the real thing. The values are deterministic filler, not physically
plausible: it is not a vehicle simulator.

## Why `serialport` lives here and not in `@ddtx/elm`

`serialport` is a native, Node-only module. Importing it from the driver package
would drag it into the browser bundle, so the driver defines the transport
interface and each host supplies its own — Web Serial in the app, `NodeSerialTransport`
here. That split is also what makes this a fair instrument: everything above the
transport is byte-identical to what the browser runs, so a timing difference
between the two *is* a transport difference.

pnpm needs the native binding's build script approved, which
`pnpm-workspace.yaml` does via `onlyBuiltDependencies`. Without it
`require('serialport')` fails at run time with a missing-binding error.
