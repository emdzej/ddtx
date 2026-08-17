/**
 * The ELM327 driver.
 *
 * Port of `ddt4all/core/elm/elm.py`, which is 1,962 lines mostly because the
 * adapter's own ISO-TP handling is inadequate for Renault's longer responses — so
 * the original runs `AT CAF0` and frames by hand. That framing lives in
 * `isotp.ts`; this file is the AT command layer, adapter identification, protocol
 * setup, and the request paths built on top.
 *
 * Structural departures from the original, all deliberate:
 *
 *  - **Async throughout.** `Port.expect` blocks; here every read is awaited, so
 *    the driver runs in a browser without freezing the page.
 *  - **No module globals.** The original reaches into `options.*` from 92 places;
 *    everything here is constructor options or instance state.
 *  - **Timing left injectable.** `sleep` and `now` are parameters, so the tests
 *    don't spend real seconds on keepalive and inter-command gaps.
 *
 * Behaviours kept because changing them would change what the adapter does:
 * `"TIMEOUT"` is a marker inside the returned string rather than an exception; the
 * L2 response cache is cleared per screen refresh, not per request; and a
 * negative response comes back as text for the caller to inspect.
 */

import {
  flowControlFrame,
  frameRequest,
  hexLines,
  parseFlowControl,
  reassemble,
  spaced,
  usableLines,
  type FlowControl,
} from "./isotp.js";
import { TIMEOUT_MARKER, type ElmTransport } from "./transport.js";

/** Which framing path a request takes. */
export type CanStrategy =
  /** Software flow control: `AT CFC0`, we send the FC frames. The risky one. */
  | "cfc0"
  /** Adapter handles flow control (`AT CFC1`) and we frame by hand. The default. */
  | "manual"
  /** STN adapters: `STPX` offloads framing entirely. Fewest round-trips. */
  | "stpx";

export interface AdapterInfo {
  /** Whatever `ATI` reported. */
  version: string;
  /** `STI` output when the adapter is STN-based. */
  stnVersion?: string;
  /** STN part, so `STPX` and `ST` commands are available. */
  isStn: boolean;
  /** `STPX` present — introduced in STN firmware 4.2.0. */
  supportsStpx: boolean;
  /** UART receive buffer, which bounds how much can be read in one go. */
  uartBufferSize: number;
}

export interface ElmDriverOptions {
  /** How long to wait for the `>` prompt. The original's `portTimeout`, 5 s. */
  promptTimeoutMs?: number;
  /** Tester-present period while a screen is open. */
  keepAliveMs?: number;
  /** Force a strategy instead of choosing from the adapter's capabilities. */
  strategy?: CanStrategy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with every command and reply, for the CLI's log and the UI's trace. */
  onExchange?: (entry: ExchangeLog) => void;
}

export interface ExchangeLog {
  sent: string;
  received: string;
  elapsedMs: number;
}

export interface EcuAddressing {
  /** CAN transmit id, 3 or 8 hex chars. */
  idTx: string;
  /** CAN receive id. */
  idRx: string;
  /** For logs. */
  ecuname: string;
  /** Bus speed; 250000 selects `AT SP 8`/`9`, anything else 500 kbit/s. */
  baudrate?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** `AT`/`ST` commands never touch the bus, so they skip the inter-command gap. */
function isAdapterCommand(command: string): boolean {
  const upper = command.toUpperCase();
  return upper.startsWith("AT") || upper.startsWith("ST");
}

export class ElmDriver {
  private readonly promptTimeoutMs: number;
  private readonly keepAliveMs: number;
  private readonly forcedStrategy: CanStrategy | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onExchange: ((entry: ExchangeLog) => void) | undefined;

  private adapter: AdapterInfo | null = null;
  /**
   * Set from the constructor so a forced strategy applies immediately.
   *
   * It used to be assigned only in `identify()`, which meant `strategy: "cfc0"`
   * was silently ignored by any caller that configured CAN without identifying
   * the adapter first — and `initCan` is exactly such a caller.
   */
  private strategy: CanStrategy;

  /** `can` or `iso`, mirroring `currentprotocol`. */
  private protocol: "none" | "can" | "iso" = "none";
  private currentAddress = "";
  /** The session command to re-send after a silence, mirroring `startSession`. */
  private startSession = "";
  private lastCommandAt = 0;
  /** Delay the previous service asked for, applied before the next request. */
  private serviceDelayMs = 0;

  /** L2 cache: request → response, cleared per screen refresh. */
  private readonly responseCache = new Map<string, string>();

  readonly errors = {
    timeout: 0,
    question: 0,
    bufferFull: 0,
    noData: 0,
    rx: 0,
    can: 0,
    frame: 0,
  };

  constructor(
    private readonly transport: ElmTransport,
    options: ElmDriverOptions = {},
  ) {
    this.promptTimeoutMs = options.promptTimeoutMs ?? 5000;
    this.keepAliveMs = options.keepAliveMs ?? 4000;
    this.forcedStrategy = options.strategy;
    this.strategy = options.strategy ?? "manual";
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.onExchange = options.onExchange;
  }

  get info(): AdapterInfo | null {
    return this.adapter;
  }

  get canStrategy(): CanStrategy {
    return this.strategy;
  }

  /* ── adapter identification ────────────────────────────────────────────── */

  /**
   * Reset the adapter and work out what it is.
   *
   * `STI` is the discriminator: STN parts answer with a version, plain ELM327
   * clones answer `?`. That decides whether `STPX` is available, which decides
   * the framing strategy — and per docs/plan.md §6.1 that is the difference
   * between offloading ISO-TP to the adapter and doing software flow control
   * across a link whose latency we cannot control.
   */
  async identify(): Promise<AdapterInfo> {
    await this.transport.purge();
    const reset = await this.sendRaw("ATZ");

    const version = extractVersion(reset) ?? extractVersion(await this.sendRaw("ATI")) ?? "unknown";

    const stiReply = await this.sendRaw("STI");
    const stnVersion = parseStn(stiReply);
    const isStn = stnVersion !== undefined;

    // STN1110 gained STPX in v4.2.0; earlier parts answer the command but
    // mis-handle it, so the version gate matters.
    const supportsStpx = isStn && stnFirmwareAtLeast(stnVersion, 4, 2, 0);

    const adapter: AdapterInfo = {
      version,
      ...(stnVersion === undefined ? {} : { stnVersion }),
      isStn,
      supportsStpx,
      uartBufferSize: uartBufferFor(stnVersion),
    };
    this.adapter = adapter;
    this.strategy = this.forcedStrategy ?? (supportsStpx ? "stpx" : "manual");

    // Capability probing provokes a "?" from any adapter that isn't an STN part —
    // that is how detection works, not a fault. Counting it would put a phantom
    // error in every report.
    for (const key of Object.keys(this.errors) as Array<keyof typeof this.errors>) {
      this.errors[key] = 0;
    }
    return adapter;
  }

  /* ── raw AT layer ──────────────────────────────────────────────────────── */

  /**
   * Write one command and read to the `>` prompt.
   *
   * The reply keeps the adapter's echo and line structure; callers strip what they
   * need. `"TIMEOUT"` inside the returned string means the prompt never came —
   * checked for by string search, as the original does, rather than thrown.
   */
  async sendRaw(command: string): Promise<string> {
    const upper = command.toUpperCase();
    const started = this.now();

    await this.transport.write(`${upper}\r`);
    const reply = await this.transport.readUntil(">", this.promptTimeoutMs);

    this.countErrors(reply);
    const elapsedMs = this.now() - started;
    this.onExchange?.({ sent: upper, received: reply, elapsedMs });
    return reply;
  }

  /**
   * A command, with the bus etiquette the original applies around it.
   *
   * Honours the delay the previous service asked for, and re-sends the diagnostic
   * session command after a silence longer than the keepalive — an ECU drops back
   * to the default session on its own otherwise, and the next request would be
   * refused for no visible reason.
   */
  async cmd(command: string, serviceDelayMs = 0): Promise<string> {
    const upper = command.toUpperCase();

    if (!isAdapterCommand(upper)) {
      const since = this.now() - this.lastCommandAt;
      if (since < this.serviceDelayMs) await this.sleep(this.serviceDelayMs - since);

      if (
        this.protocol === "can" &&
        this.startSession.length > 0 &&
        this.now() - this.lastCommandAt > this.keepAliveMs
      ) {
        await this.sendRaw(this.startSession);
        this.lastCommandAt = this.now();
      }
    }

    const reply = await this.sendCommand(upper);
    this.lastCommandAt = this.now();
    this.serviceDelayMs = serviceDelayMs;
    return reply;
  }

  /** Route a command to the right framing path. */
  private async sendCommand(command: string): Promise<string> {
    if (isAdapterCommand(command) || this.protocol !== "can") {
      return this.sendRaw(command);
    }
    return this.sendCan(command);
  }

  /**
   * A diagnostic request, with the response reduced to one line of hex bytes.
   *
   * This is what `EcuRequest`/`decodeStream` consume. Cached by default: a screen
   * refresh commonly asks for the same request twice, and `clearCache` is called
   * once per refresh rather than per request.
   */
  async request(
    command: string,
    options: { cache?: boolean; serviceDelayMs?: number } = {},
  ): Promise<string> {
    const useCache = options.cache ?? true;
    const key = command.replace(/\s+/g, "").toUpperCase();

    if (useCache) {
      const hit = this.responseCache.get(key);
      if (hit !== undefined) return hit;
    }

    const reply = await this.cmd(command, options.serviceDelayMs ?? 0);
    if (reply.includes("WRONG")) return reply;

    // On CAN the framing path already returned a clean payload; on K-line the
    // reply is raw lines, so drop the echo and join what's left.
    const value =
      this.protocol === "can"
        ? reply
        : reply
            .split("\n")
            .slice(1)
            .filter((line) => !line.includes(">") && line.trim().length > 0)
            .map((line) => line.trim())
            .join(" ");

    if (useCache) this.responseCache.set(key, value);
    return value;
  }

  /** Drop the L2 cache. Call once per screen refresh, as `ELM.clear_cache` is. */
  clearCache(): void {
    this.responseCache.clear();
  }

  /* ── CAN ───────────────────────────────────────────────────────────────── */

  /**
   * Send a request over CAN, framing ISO-TP in software.
   *
   * Every frame is written back to back and the adapter's flow control (`AT CFC1`)
   * keeps the ECU in step, which is why the received flow-control frames are
   * ignored rather than answered. `sendCanCfc0` is the other half of this, for when
   * we have to answer them ourselves.
   */
  private async sendCan(command: string): Promise<string> {
    if (this.strategy === "cfc0") return this.sendCanCfc0(command);

    const compact = command.replace(/\s+/g, "").toUpperCase();
    const frames = frameRequest(compact);
    if (typeof frames === "string") return frames;
    if (frames.length === 0) return "";

    const requestSid = compact.slice(0, 2);
    const responses: string[] = [];

    for (const frame of frames) {
      const reply = await this.sendRaw(frame);
      responses.push(...usableLines(reply, frame));
    }

    const result = reassemble(responses, requestSid);
    if (result.error === "frame") this.errors.frame += 1;
    if (result.negative !== undefined) return result.value;
    if (result.error !== undefined) return "WRONG RESPONSE";
    return result.value;
  }

  /**
   * Send a request over CAN, answering flow control ourselves (`AT CFC0`).
   *
   * Port of `elm.py:send_can_cfc0`. Two things differ from the default path, and
   * both come from the adapter having stepped out of the way:
   *
   * - **Sending.** After our first frame the ECU replies with a flow-control frame
   *   saying how many consecutive frames it will accept and how far apart. We honour
   *   it rather than writing everything back to back.
   * - **Receiving.** A multi-frame *response* stops dead after its first frame until
   *   someone sends `30 0N 00`. Under `AT CFC1` the adapter does; here we do, once
   *   per block of up to seven frames.
   *
   * Why it exists: some adapters' automatic flow control mishandles Renault's longer
   * responses, and this is the way round that. It is not the default because the
   * default is one round trip fewer and, on the hardware measured so far, correct.
   *
   * **Unverified against a vehicle.** The framing and the flow-control exchange are
   * covered by `MockElm` — including an ECU that withholds its consecutive frames
   * until asked — but no test here can tell you how a real ECU paces its blocks.
   */
  private async sendCanCfc0(command: string): Promise<string> {
    const compact = command.replace(/\s+/g, "").toUpperCase();
    const frames = frameRequest(compact);
    if (typeof frames === "string") return frames;
    if (frames.length === 0) return "";

    const requestSid = compact.slice(0, 2);
    const responses: string[] = [];
    // What the ECU has asked for, until it says otherwise. One frame at a time with
    // no gap is the conservative assumption: it costs round trips, never frames.
    let flow: FlowControl = { blockSize: 1, separationMs: 0 };

    let index = 0;
    while (index < frames.length) {
      const frame = frames[index] as string;
      const reply = await this.sendRaw(frame);
      index += 1;

      let sawFlowControl = false;
      for (const line of hexLines(reply, frame)) {
        const fc = parseFlowControl(line);
        if (fc !== undefined) {
          flow = fc;
          sawFlowControl = true;
          break;
        }
        responses.push(line);
      }

      // Block size 0 means "send the rest without stopping".
      const allowed =
        sawFlowControl && flow.blockSize === 0 ? frames.length - index : flow.blockSize - 1;
      let burst = Math.min(Math.max(allowed, 0), frames.length - index);
      while (burst > 0) {
        if (flow.separationMs > 0) await this.sleep(flow.separationMs);
        await this.sendRaw(frames[index] as string);
        index += 1;
        burst -= 1;
      }
    }

    await this.pullRemainingFrames(responses);

    const result = reassemble(responses, requestSid);
    if (result.error === "frame") this.errors.frame += 1;
    if (result.negative !== undefined) return result.value;
    if (result.error !== undefined) return "WRONG RESPONSE";
    return result.value;
  }

  /**
   * Ask the ECU for the rest of a multi-frame response, a block at a time.
   *
   * Only does anything when a first frame arrived without all its consecutive frames
   * behind it — which under `AT CFC0` is every multi-frame response, because nothing
   * has answered the ECU's flow-control request yet.
   *
   * Stops on `NO DATA`, on a frame count that says we already have everything, and
   * on a hard cap: an ECU that keeps answering flow control without advancing the
   * sequence must not spin here forever.
   */
  private async pullRemainingFrames(responses: string[]): Promise<void> {
    const firstFrameIndex = responses.findIndex((line) => line.startsWith("1"));
    if (firstFrameIndex < 0) return;

    const first = responses[firstFrameIndex] as string;
    const declaredBytes = Number.parseInt(first.slice(1, 4), 16);
    if (Number.isNaN(declaredBytes)) return;

    // The first frame carries 6 payload bytes, each consecutive frame 7.
    const total = 1 + Math.ceil(Math.max(declaredBytes - 6, 0) / 7);
    let have = 1 + responses.slice(firstFrameIndex + 1).filter((l) => l.startsWith("2")).length;

    for (let round = 0; have < total && round < total; round += 1) {
      const frame = flowControlFrame(total - have);
      const reply = await this.sendRaw(frame);
      if (reply.includes("NO DATA")) break;

      const before = have;
      for (const line of hexLines(reply, frame)) {
        responses.push(line);
        if (line.startsWith("2")) have += 1;
      }
      // Nothing new arrived: asking again will not help.
      if (have === before) break;
    }
  }

  /**
   * Put the adapter into the state `sendCan` assumes.
   *
   * `AT CAF0` is the load-bearing one: automatic formatting would strip the
   * ISO-TP prefixes this driver adds itself. `AT S0` removes the spaces that
   * would otherwise break echo cancellation, and `AT AL` allows the long messages
   * Renault ECUs return.
   */
  async initCan(): Promise<void> {
    this.protocol = "can";
    this.currentAddress = "7e0";
    this.startSession = "";
    this.lastCommandAt = 0;

    for (const command of ["AT WS", "AT E1", "AT S0", "AT H0", "AT L0", "AT AL", "AT CAF0"]) {
      await this.cmd(command);
    }
    // Flow control by the adapter unless we have been told to do it ourselves.
    await this.cmd(this.strategy === "cfc0" ? "AT CFC0" : "AT CFC1");
    this.lastCommandAt = 0;
  }

  /**
   * Point the adapter at one ECU.
   *
   * 29-bit ids are split: the top byte becomes the CAN priority (`AT CP`) and the
   * rest the header. `AT AT 0` disables adaptive timing across the protocol
   * change and `AT AT 1` re-enables it afterwards, because the adapter otherwise
   * carries a stale timing estimate into the new protocol.
   */
  async setCanAddress(ecu: EcuAddressing): Promise<void> {
    if (this.protocol === "can" && this.currentAddress === ecu.idTx) return;

    this.protocol = "can";
    this.currentAddress = ecu.idTx;
    this.startSession = "";
    this.lastCommandAt = 0;

    const { idTx, idRx } = ecu;

    if (idRx.length === 8) {
      await this.cmd(`AT CP ${idTx.slice(0, 2)}`);
      await this.cmd(`AT SH ${idTx.slice(2)}`);
    } else {
      await this.cmd(`AT SH ${idTx}`);
    }

    await this.cmd(`AT FC SH ${idTx}`);
    await this.cmd("AT FC SD 30 00 00"); // clear-to-send, no block limit, no separation
    await this.cmd("AT FC SM 1");
    await this.cmd("AT ST FF");
    await this.cmd("AT AT 0");

    await this.setCanSpeed(idTx, ecu.baudrate ?? 500000);

    // Re-applied because `AT SP` resets these on several clones, and `sendCan`
    // depends on all three.
    for (const command of ["AT CAF0", "AT S0", "AT AL"]) await this.cmd(command);

    await this.cmd("AT AT 1");
    await this.cmd(`AT CRA ${idRx}`);

    if (this.strategy === "stpx") {
      await this.cmd(`STCFCPA ${idTx}, ${idRx}`);
    }
  }

  /** 11-bit ids use protocols 6/8, 29-bit ids 7/9. */
  private async setCanSpeed(idTx: string, baudrate: number): Promise<void> {
    const elevenBit = idTx.length === 3;
    if (baudrate === 250000) {
      await this.cmd(elevenBit ? "AT SP 8" : "AT SP 9");
    } else {
      await this.cmd(elevenBit ? "AT SP 6" : "AT SP 7");
    }
  }

  /** Open a diagnostic session and remember it for the keepalive. */
  async startCanSession(command: string): Promise<boolean> {
    this.startSession = command;
    const reply = await this.cmd(command);
    return reply.trim().startsWith("50");
  }

  /* ── K-line ────────────────────────────────────────────────────────────── */

  /** `AT S1`/`L1`/`D1`: K-line replies are read as spaced text, not raw frames. */
  async initIso(): Promise<void> {
    this.protocol = "iso";
    this.currentAddress = "";
    this.startSession = "";
    this.lastCommandAt = 0;

    for (const command of ["AT WS", "AT E1", "AT S1", "AT L1", "AT D1"]) {
      await this.cmd(command);
    }
  }

  /**
   * Address a KWP2000 ECU, trying slow init before fast init.
   *
   * The order matters and is the original's: slow init (`AT SI`, protocol 4) is
   * attempted when the ECU is marked for it, and fast init (`AT FI`, protocol 5)
   * is the fallback whenever slow init didn't report `OK`. An ECU that wants slow
   * init and gets fast init simply never answers.
   */
  async setIsoAddress(address: string, options: { slowInit?: boolean } = {}): Promise<boolean> {
    if (this.protocol === "iso" && this.currentAddress === address) return true;

    this.protocol = "iso";
    this.currentAddress = address;
    this.startSession = "";
    this.lastCommandAt = 0;

    await this.cmd(`AT SH 81 ${address} F1`);
    await this.cmd("AT SW 96"); // wake-up every ~3 s
    await this.cmd(`AT WM 81 ${address} F1 3E`); // the wake-up message itself
    await this.cmd("AT IB10"); // 10400 baud
    await this.cmd("AT ST FF");
    await this.cmd("AT AT 0");

    let initReply = "";
    if (options.slowInit === true) {
      await this.cmd("AT SP 4");
      initReply = await this.cmd("AT SI");
    }

    if (!initReply.includes("OK")) {
      await this.cmd("AT SP 5");
      initReply = await this.cmd("AT FI");
    }

    await this.cmd("AT AT 1");
    await this.cmd("81"); // StartCommunication
    return initReply.includes("OK");
  }

  /** ISO8 always needs slow init, and sets protocol 3 rather than 4. */
  async setIso8Address(address: string): Promise<void> {
    if (this.protocol === "iso" && this.currentAddress === address) return;

    this.protocol = "iso";
    this.currentAddress = address;
    this.startSession = "";
    this.lastCommandAt = 0;

    await this.cmd(`AT SH 81 ${address} F1`);
    await this.cmd("AT SW 96");
    await this.cmd(`AT WM 81 ${address} F1 3E`);
    await this.cmd("AT IB10");
    await this.cmd("AT ST FF");
    await this.cmd("AT SP 3");
    await this.cmd("AT AT 0");
    await this.cmd("AT SI");
    await this.cmd("AT AT 1");
  }

  /**
   * Set the CAN response timeout, in milliseconds.
   *
   * `AT ST` takes units of **4 ms** in a single byte, so the range is 4–1020 ms and
   * anything larger saturates. Port of `set_can_timeout`, which does the same
   * division and clamp — worth knowing when asking for 1500 ms, as the DTC erase
   * does: you get 1020.
   */
  async setCanTimeout(milliseconds: number): Promise<void> {
    const units = Math.min(255, Math.max(1, Math.floor(milliseconds / 4)));
    await this.cmd(`AT ST ${units.toString(16).toUpperCase().padStart(2, "0")}`);
  }

  /** Back to the maximum, which is what `initCan` and `setCanAddress` leave set. */
  async resetCanTimeout(): Promise<void> {
    await this.cmd("AT ST FF");
  }

  /** `ATPC`: tell the adapter to drop the protocol. */
  async closeProtocol(): Promise<void> {
    await this.cmd("ATPC");
    this.protocol = "none";
    this.currentAddress = "";
  }

  /* ── diagnostics ───────────────────────────────────────────────────────── */

  private countErrors(reply: string): void {
    if (reply.includes(TIMEOUT_MARKER)) this.errors.timeout += 1;
    if (reply.includes("?")) this.errors.question += 1;
    if (reply.includes("BUFFER FULL")) this.errors.bufferFull += 1;
    if (reply.includes("NO DATA")) this.errors.noData += 1;
    if (reply.includes("RX ERROR")) this.errors.rx += 1;
    if (reply.includes("CAN ERROR")) this.errors.can += 1;
  }
}

/* ── identification helpers ──────────────────────────────────────────────── */

/** Pull a version line out of an `ATZ`/`ATI` reply, ignoring echo and prompt. */
export function extractVersion(reply: string): string | undefined {
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line === ">" || line.startsWith("AT")) continue;
    if (/ELM327|OBD|STN/i.test(line)) return line.replace(/>$/, "").trim();
  }
  return undefined;
}

/** `STI` reports e.g. `"STN1170 v4.3.1"`; a plain clone answers `"?"`. */
export function parseStn(reply: string): string | undefined {
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (line.includes("?")) continue;
    if (/STN/i.test(line)) return line.replace(/>$/, "").trim();
  }
  return undefined;
}

/** Is the STN firmware at least the given version? `STPX` needs 4.2.0. */
export function stnFirmwareAtLeast(
  stnVersion: string | undefined,
  major: number,
  minor: number,
  patch: number,
): boolean {
  if (stnVersion === undefined) return false;
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(stnVersion);
  if (match === null) return false;
  const found = [Number(match[1]), Number(match[2]), Number(match[3])];
  const wanted = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if ((found[i] as number) > (wanted[i] as number)) return true;
    if ((found[i] as number) < (wanted[i] as number)) return false;
  }
  return true;
}

/**
 * UART receive buffer, which caps how much the adapter can return at once.
 *
 * STN1xxx parts report 511 bytes and STN2xxx 1023 (`0x1ff` / `0x3ff`, as
 * `elm.py:496`); a plain ELM327 is far smaller, and 256 is the safe assumption.
 */
export function uartBufferFor(stnVersion: string | undefined): number {
  if (stnVersion === undefined) return 0x100;
  if (/STN1/i.test(stnVersion)) return 0x1ff;
  if (/STN2/i.test(stnVersion)) return 0x3ff;
  return 0x100;
}

export { spaced };
