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

### 2.4 Flow control: the open question

Three strategies exist; two are implemented.

| Strategy | Who answers flow control       | Status                                           |
| -------- | ------------------------------ | ------------------------------------------------ |
| `manual` | The adapter (`AT CFC1`)        | **Default.** One round trip per written frame    |
| `stpx`   | The adapter, entirely (`STPX`) | Used on STN firmware ≥ 4.2.0. Fewest round trips |
| `cfc0`   | **We do** (`AT CFC0`)          | **Not implemented** — deliberately               |

`cfc0` needs millisecond turnaround: after each block the ECU waits for _our_ flow
control frame. Over Web Serial that means a full host round trip per FC frame, and
the FTDI latency timer — 16 ms by default — **cannot be changed from a web page**.
`ftdiLatencyTimer.ts` in the ediabasx packages documents this explicitly: Linux
needs a sysfs write, macOS a native `ioctl`, Windows registry plus admin; browser
is a silent no-op.

So implementing `cfc0` before measuring would be guessing, and `pnpm cli bench`
exists to take the measurement. See [`plan.md`](plan.md) §6.1 and
[`../apps/cli/README.md`](../apps/cli/README.md).

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

## 5. What cannot be reached from a browser

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
