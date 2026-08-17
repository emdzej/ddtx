# Talking to the ECUs

What goes over the wire, and why each AT command is in the sequence. Ported from
`core/elm/elm.py`; the framing lives in `packages/elm/src/isotp.ts` and the command
layer in `driver.ts`.

The database picks the protocol, not us — `obd.protocol` dispatches everything
below, and there are only four values: `CAN` (1,363 ECUs), `KWP2000` (195),
`ISO8` (21), and one blank.

---

## 1. The adapter

An ELM327 is a line-oriented device: write a command, read until the `>` prompt.
Everything rests on that, and it is why the transport here is **delimiter-driven**
rather than length-driven — an ELM legitimately pauses longer than any sensible
idle timeout while it prints `SEARCHING...` or collects a multi-frame response.

A timeout is reported by appending `"TIMEOUT"` to whatever arrived, not by
throwing. That is `Port.expect`'s behaviour and callers test for the marker by
string search; changing it would alter the retry behaviour of every command.

### Identification

```
ATZ   → reset; answers with the version
ATI   → version, if ATZ's answer was unusable
STI   → STN parts answer a version; a plain ELM327 clone answers "?"
```

`STI` is the whole discriminator. An STN part (OBDLink and friends) gains `STPX`,
which offloads ISO-TP framing to the adapter — but only from firmware **4.2.0**;
earlier parts accept the command and mis-handle it, so the version gate matters.

UART receive buffer, which bounds how much can come back at once: STN1xxx 511
bytes, STN2xxx 1023 (`0x1ff` / `0x3ff`), a plain clone assumed 256.

### Baud rate

There is no way to ask an adapter what rate it is set to, so `connect` tries them
in the original's order: **38400, 115200, 230400, 57600, 9600, 500000, 1000000,
2000000**. An adapter at the wrong rate answers noise rather than a version string,
which is the test.

Switching to a faster UART (`ATBRD` on an ELM, `ST SBR` on an STN) changes the line
rate underneath the host. `serialport` can reconfigure in place; **Web Serial
cannot**, so the browser transport closes and reopens — worth remembering if the
CLI and the app ever disagree about a baud switch.

---

## 2. CAN — and why the framing is ours

Renault diagnostics on CAN is UDS over ISO-TP. The ELM327 can frame ISO-TP itself
with `AT CAF1`, and DDT4All deliberately does **not** use it: automatic formatting
mis-handles the longer responses these ECUs return. So `AT CAF0` is set and the
protocol-control bytes are built by hand.

That is the single most consequential decision in the driver, and the reason
`isotp.ts` is pure and exhaustively tested.

### Frame layout

The first nibble is the PCI type:

```
0L dd dd dd dd dd dd dd     single frame, L = payload length (≤ 7 bytes)
1LLL dd dd dd dd dd dd      first frame, LLL = total length, 6 bytes of payload
2N dd dd dd dd dd dd dd     consecutive frame, N = sequence number mod 16
3F BS ST                    flow control
```

Requests of 7 bytes or fewer go in one frame. Longer ones split; the sequence
number is a single nibble and wraps at 16. p50 request length in the database is
**3 bytes**, so the overwhelming majority are single frames.

### Setup

```
AT WS      warm start
AT E1      echo on          ← the driver relies on the echo to cancel it
AT S0      no spaces        ← so echo cancellation matches byte for byte
AT H0      headers off
AT L0      no linefeeds
AT AL      allow long messages
AT CAF0    automatic formatting OFF   ← load-bearing; see above
AT CFC1    adapter answers flow control (or CFC0, see §2.4)
```

### Addressing one ECU

```
AT CP <hi>        29-bit only: the top byte becomes the CAN priority
AT SH <id>        transmit header (the low 6 nibbles for 29-bit)
AT FC SH <id>     flow-control header
AT FC SD 30 00 00 clear to send, no block limit, no separation time
AT FC SM 1        use our flow-control settings
AT ST FF          maximum timeout
AT AT 0           adaptive timing off across the protocol change
AT SP 6|7|8|9     11-bit/29-bit × 500/250 kbit/s
AT CAF0 / S0 / AL re-applied — several clones reset these on AT SP
AT AT 1           adaptive timing back on
AT CRA <id>       accept only this receive id
STCFCPA <tx>,<rx> STN only, when using STPX
```

Two things here are experience rather than specification. `AT AT 0` / `AT AT 1`
around the protocol change stops the adapter carrying a stale timing estimate into
the new protocol. And **`AT CAF0`, `AT S0` and `AT AL` are re-applied after
`AT SP`** because several ELM327 clones (VLinker FS among them) silently reset them
on a protocol change — and all three are required for the software framing to work.

Protocol numbers:

|           | 500 kbit/s | 250 kbit/s |
| --------- | ---------- | ---------- |
| 11-bit id | `AT SP 6`  | `AT SP 8`  |
| 29-bit id | `AT SP 7`  | `AT SP 9`  |

Only 250 kbit/s is distinguished from "everything else"; see the `baudrate`
warning in [`ecu-format.md`](ecu-format.md#31-obd--how-to-reach-the-ecu) — 55% of
CAN ECUs declare a physically impossible 10400 baud, and both implementations fall
through to 500 kbit/s.

### Reading a response

Each written frame produces a reply; the usable lines are extracted by dropping
the echo (space-insensitively — clones reset `AT S0`), blanks, non-hex, and
flow-control frames. Flow control is _ignored_ on receive: the driver writes every
frame of a request back to back and lets the adapter's `AT CFC1` keep the ECU in
step, so it never owes the ECU an FC frame.

Reassembly then handles four cases, and the third is the interesting one:

1. **Single frame** — length nibble, then payload, trimmed of CAN padding.
2. **First frame + consecutive frames** — sequence checked; a gap is an error
   rather than a short payload.
3. **Broadcast noise.** Some ECUs transmit continuously on their own TX id, so the
   batch contains unrelated single frames alongside the answer. The real one is
   found by its **positive-response SID** (request + 0x40) or by `7F`. There is no
   other way to tell them apart.
4. **Response pending** — a leading `7F xx 78` means "wait", and the real answer
   follows in the same batch; it is dropped and the rest used.

A first frame with nothing behind it, or a response with no PCI prefix at all,
almost always means `AT CAF0` was reset by `AT SP` or flow control never completed.
Both are reported as a frame error rather than guessed at.

### 2.4 Flow control

Three strategies, all implemented.

| Strategy | Who answers flow control       | Status                                                                         |
| -------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `manual` | The adapter (`AT CFC1`)        | **Default.** One round trip per written frame                                  |
| `stpx`   | The adapter, entirely (`STPX`) | Used on STN firmware ≥ 4.2.0. Fewest round trips                               |
| `cfc0`   | **We do** (`AT CFC0`)          | Fallback for adapters whose own flow control mishandles long Renault responses |

`cfc0` needs millisecond turnaround: after each block the ECU waits for _our_ flow
control frame. Over Web Serial that means a full host round trip per FC frame, and
the FTDI latency timer — 16 ms by default — **cannot be changed from a web page**.
`ftdiLatencyTimer.ts` in the ediabasx packages documents this explicitly: Linux
needs a sysfs write, macOS a native `ioctl`, Windows registry plus admin; browser
is a silent no-op.

That is why it was left unimplemented until measured. The measurement below settled
it: **~6.4 ms per flow-control frame, owed once per seven consecutive frames**, not
once per frame. A 100-byte response costs two FC frames, or about 13 ms on top —
real, but not disqualifying. `manual` stays the default because it is one round trip
fewer and correct on the hardware measured.

Two details of the implementation are worth knowing:

- **The frame is odd-length on purpose.** `30 0N 00` is the three bytes; the trailing
  nibble in `3007007` is the ELM327's "expect N responses" suffix, which is what stops
  the adapter returning after the first frame of a block.
- **`Fx` separation times are read as microseconds**, per ISO 15765-2 — `F1`–`F9` mean
  100–900 µs while `00`–`7F` mean 0–127 ms, two units in one byte. The original reads
  `Fx` as `x * 100` **milliseconds** and sleeps that long, a thousand times what the
  ECU asked for, which would blow the 5 s session timeout on a long request. We follow
  the spec. No vehicle to hand requests `Fx` at all, so this divergence is unverified
  on hardware.

The whole path is covered by a `MockElm` ECU that withholds its consecutive frames
until it receives flow control, which is the behaviour the default path never
exercises. What no mock can tell you is how a real ECU paces its blocks.

#### First measurement — 2026-08-17

Hardware: a generic **ELM327 v1.5 clone** on a **Prolific PL2303** bridge
(`067b:2303`), macOS, 38400 baud, **no vehicle attached**. Node's `serialport`.

The vehicle being absent is not a limitation here: `AT` is answered by the
adapter's own firmware, so it isolates exactly the host↔adapter path this question
is about.

| Measurement                 | Result                                         |
| --------------------------- | ---------------------------------------------- |
| Fixed cost per exchange     | **3.84 ms** (least-squares intercept)          |
| Cost per reply byte         | **0.284 ms** — theory at 38400 8N1 is 0.260    |
| `AT` round trip, n=400      | p50 **5.7**, p90 6.0, p99 8.1, **max 14.1 ms** |
| Exchanges over 50 ms        | **0**                                          |
| Second write in one request | 2.4× the first                                 |

Three conclusions:

**There is no 16 ms floor here.** That figure is an FTDI default, and this is a
Prolific part. The fixed cost is 3.84 ms and the distribution is tight and
unimodal — 90% of 400 exchanges fell in one 2 ms bucket, with no stall anywhere
near the ~150 ms an ISO-TP `N_Cs` deadline allows.

**Most of the cost is the baud rate, not latency.** 0.284 ms measured against
0.260 ms theoretical is within 9%, so per-byte cost is essentially pure wire time.
That makes the UART speed the largest available lever — but this adapter refuses
it: `ATBRD` returns `OK` and then never switches rate, which is common clone
behaviour. An STN part at 115200+ would be roughly 3× faster on the wire before any
other consideration.

**`cfc0` is viable on this hardware.** The deciding detail is that it caps block
size at 7 (`elm.py:1428` — `min(nFrames - cFrame, 0x7)`), so it owes **one flow
control frame per seven consecutive frames**, not one per frame. At ~6.4 ms per FC
exchange that is ~13 ms extra for a typical multi-frame response, and ~0.5 s for
the database's 4,092-byte worst case.

That does not make it the default. `manual` (`AT CFC1`) has the adapter answer flow
control with no host round trip at all, so it remains strictly better — `cfc0` is
the fallback the original reaches for when the adapter's own flow control fails,
and this measurement says that fallback is now worth implementing rather than
feared.

**What this does not measure.** Node's `serialport`, not **Web Serial** — the
browser adds Chrome's serial service and an IPC hop that the CLI does not have, and
that is the path the app actually uses. It also says nothing about real ECU
response timing, or whether the adapter's own `CFC1` works on a live bus.

#### The browser half, same day

Same adapter, same 38400 baud, measured through the app's **Measure link** button —
so over Web Serial, in Chrome, which is the transport the app actually uses.

|            | Node `serialport`, n=400 | Web Serial, n=200 |
| ---------- | ------------------------ | ----------------- |
| min        | 5.5 ms                   | 5.5 ms            |
| p50        | 5.7 ms                   | **5.8 ms**        |
| p90        | 6.0 ms                   | 6.0 ms            |
| p99        | 8.1 ms                   | **7.0 ms**        |
| max        | 14.1 ms                  | **7.4 ms**        |
| sd         | 2.0                      | **0.2**           |
| over 50 ms | 0                        | 0                 |

**Chrome adds nothing measurable.** 0.1 ms at p50 is inside the noise, and the
tail is _tighter_ than Node's — sd 0.2 against 2.0. Part of the max difference is
sample size (200 against 400), but an sd of 0.2 over 200 exchanges is a real
signal, and the Node run had a measurement script sharing its event loop where
Chrome's serial service has a process to itself.

So the concern that shaped much of this driver's design — that Web Serial's
buffering would put a floor under every exchange — **does not hold on this
hardware**. The browser is not the bottleneck; the 38400 baud UART is.

What that means in practice, using the measured single-frame cost of ~10 ms: the
richest screen in the database polls **2 requests**, so a full refresh of its 169
widgets costs ~20 ms of link time. Even a ten-request screen sits near 100 ms,
comfortably inside the 700 ms auto-refresh interval. Note this is a floor, not a
prediction — those exchanges were answered `CAN ERROR` by an adapter with no bus,
and a real ECU adds its own processing time.

Still unmeasured, and needing a vehicle: real ECU response timing, and whether the
adapter's own `CFC1` flow control holds on a live bus — which is the only thing
that would make the `cfc0` fallback matter at all.

### Keepalive

An ECU drops back to the default session on its own after a silence. If a session
command was issued (`startCanSession`), the driver re-sends it after
`keepAliveMs` — otherwise the next request is refused for no visible reason. The Qt
app additionally sends `3E` (tester present) every 1.5 s while a screen is open,
suppressed during auto-refresh because the polling keeps the session alive anyway.

---

## 3. K-line — KWP2000 and ISO8

The opposite configuration: replies are read as spaced text rather than raw frames,
and there is no ISO-TP at all — requests go out raw, with no PCI byte.

```
AT WS
AT E1
AT S1     spaces ON
AT L1     linefeeds ON
AT D1     display the CAN DLC (harmless on K-line; the CAN path sets D0)
```

### Addressing

```
AT SH 81 <addr> F1    header: format 81, target, tester F1
AT SW 96              wake-up period, ~3 s
AT WM 81 <addr> F1 3E wake-up message (tester present)
AT IB10               10400 baud
AT ST FF              maximum timeout
AT AT 0               adaptive timing off during init
  AT SP 4 ; AT SI     slow init (5-baud), when the ECU wants it
  AT SP 5 ; AT FI     fast init, otherwise or as fallback
AT AT 1
81                    StartCommunication
```

**Init mode is not a preference.** `obd.fastinit` is present on all 195 KWP2000
ECUs — `true` on 160, `false` on 35. An ECU that wants slow init and gets fast init
simply never answers, with no error to explain it, so `attachEcu` treats anything
other than `fastinit: true` as slow-init-first and falls back to fast init only
when slow init did not report `OK`.

**ISO8** always needs slow init and uses `AT SP 3` rather than 4. 21 ECUs.

Because there is no framing, a K-line reply is just lines of text: the driver drops
the echo line and joins the rest with spaces, which is what the codec expects.

---

## 4. Negative responses

`7F <sid> <nrc>` comes back as text for the caller to inspect, rather than being
thrown — the NRC is what explains the refusal, and the screen shows it per field.

The table is 52 entries transcribed from `core/elm/constants.py`. Renault ECUs use
plenty of the manufacturer-specific range, and those are precisely the ones worth
spelling out because they say what to change about the _car_ rather than about the
request:

| NRC         | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `11`        | Service not supported                            |
| `12`        | Sub-function not supported                       |
| `22`        | Conditions not correct or request sequence error |
| `31`        | Request out of range                             |
| `33`        | Security access denied                           |
| `78`        | Request correctly received — response pending    |
| `83`        | **Engine is running**                            |
| `84`        | **Engine is not running**                        |
| `8F`        | **Brake switch(es) not closed**                  |
| `90`        | **Shifter lever not in park**                    |
| `92` / `93` | Voltage too high / too low                       |

---

## 5. Fault codes

There is no standard DTC service here. Each ECU's file names its own request —
`ReadDTC`, `ReadDTCInformation.ReportDTC`, `LireDefautsMemorises` and a dozen other
spellings — and the reader matches against that list, case-insensitively, before
falling back to nothing. It never invents a frame: an ECU with no fault request is
reported as unsupported rather than probed with a guess.

**The response is one header plus N fixed-width records.** Byte 2 is the count.
Every field's `firstbyte` is written for the _first_ record, and each further record
is read by sliding the window on by `shiftbytescount` bytes:

```
57 03  DB08 7F1F  215B 7BE2  C2…
│  │   └─ record 1 ─┘ └─ record 2 …
│  └─ 3 codes stored
└─ positive response to 17
```

Measured over the whole database: 1,392 of 1,580 ECUs describe a readable fault
request, stride 4 in 1,049 of them and 3 in 333. Five define no stride at all and
carry exactly one record. 115 distinct field names appear across every record in
the corpus.

**Continuation.** Where the request declares a `MoreDTC` send byte, the same frame
is re-sent with it set until the ECU stops answering. Two things to know:

- An ELM answers `NO DATA` when there is nothing more. That is _text_, and
  `getHexValue` voids the whole response on a single non-hex character — so it must
  be rejected before it reaches the decoder, not appended as bytes. On CAN the
  driver's line filter hides this; on K-line it does not.
- **The original's continuation is broken.** `moredtcread_command` builds its frame
  with `''.join(str(bytestosend))`, which stringifies a Python _list_ — producing
  `"['1', '7', …]"` rather than a frame. Ours builds the frame properly, so it reads
  codes past the first response where the Qt app cannot.

**Clearing** widens the response timeout to 1500 ms first, because an ECU erasing
its fault memory can take a while to answer and a timeout reads as failure when the
erase actually happened. Note `AT ST` counts in 4 ms units with a one-byte argument,
so 1500 ms is not expressible — the original silently clamps to 1020 ms and so do
we, deliberately, rather than pretending otherwise. Where no request describes a
clear, the generic `14 FF 00` is used and the caller is told it was a fallback.

---

## 6. What cannot be reached from a browser

| Transport             | Why                                                      |
| --------------------- | -------------------------------------------------------- |
| **WiFi ELM**          | Raw TCP to port 35000. No browser API opens a TCP socket |
| **Bluetooth ELM**     | Classic SPP. Web Bluetooth exposes BLE only              |
| **DoIP**              | TCP 13400. Same as WiFi                                  |
| **libusb CAN device** | Needs libusb; WebUSB could reach it, unported            |

`attachEcu` refuses an unreachable protocol up front with
`UnsupportedProtocolError`, and `isReachable()` lets the UI say so before anything
is attempted.

**Web Serial itself is desktop-only** — Chrome/Edge on desktop and ChromeOS. Not
Android, not iOS, not Firefox, not Safari. Android Chrome does have WebUSB, so the
mobile path would be a WebUSB CDC-ACM/FTDI/CH340 driver behind the same
`ElmTransport` interface. Nothing above the transport would change.

The escape hatch for all of these is the same: a host-side relay exposing serial
bytes over a WebSocket. The concept transfers from `ediabasx-server`; the code does
not, since that is an ediabas-shaped RPC rather than a byte pipe.
