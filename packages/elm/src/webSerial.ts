/**
 * `ElmTransport` over the Web Serial API.
 *
 * The port lifecycle here is adapted from `@emdzej/ediabasx-interface-serial`'s
 * `WebSerialTransport` — the open/close/read-loop unwind ordering is fiddly and
 * that implementation gets it right. What is *not* taken from it is the read
 * model: its `read(length, timeoutMs)` is length-driven, and an ELM327 is
 * delimiter-driven. See docs/plan.md §5 for why that made a dependency
 * impractical rather than merely inconvenient.
 *
 * Copied rather than imported for a second reason: that package is licensed
 * PolyForm Noncommercial and ddtx is GPL-3.0, which GPLv3 §7 does not permit
 * combining (docs/plan.md §5.1).
 *
 * **This file is the one part of the driver a mock cannot verify.** Everything
 * above it is tested against `MockElm`; the bytes actually reaching a cable are
 * what the phase-0 car session is for.
 */

import { BufferedTransport, type SerialOptions } from "./transport.js";

/* Minimal shape of the Web Serial objects this touches, declared locally so the
   package compiles without `"lib": ["DOM"]` — the Node transport and the tests
   have no business pulling in DOM typings. */

interface WebSerialOpenOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  parity?: "none" | "even" | "odd";
  stopBits?: 1 | 2;
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

interface WebReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

interface WebWriter {
  write(chunk: Uint8Array): Promise<void>;
  releaseLock(): void;
  ready: Promise<void>;
}

export interface WebSerialPortLike {
  readable: { getReader(): WebReader } | null;
  writable: { getWriter(): WebWriter } | null;
  open(options: WebSerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  forget?(): Promise<void>;
}

/** Baud rates to try, in the order `ELM.__init__` tries them. */
export const CANDIDATE_BAUD_RATES = [38400, 115200, 230400, 57600, 9600, 500000, 1000000, 2000000];

export class WebSerialTransport extends BufferedTransport {
  readonly description: string;

  private options: SerialOptions;
  private opened = false;
  private closing = false;
  private reader: WebReader | null = null;
  private writer: WebWriter | null = null;
  private readLoop: Promise<void> | null = null;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  /**
   * The port must be supplied rather than requested here: `requestPort()` has to
   * run inside a user gesture, and the caller is what has one. It also lets the
   * app re-use a port already granted via `navigator.serial.getPorts()`.
   */
  constructor(
    private readonly port: WebSerialPortLike,
    options: Partial<SerialOptions> = {},
    description = "Web Serial",
  ) {
    super();
    this.options = {
      baudRate: options.baudRate ?? 38400,
      dataBits: options.dataBits ?? 8,
      parity: options.parity ?? "none",
      stopBits: options.stopBits ?? 1,
      flowControl: options.flowControl ?? "none",
    };
    this.description = description;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.port.open({
      baudRate: this.options.baudRate,
      dataBits: this.options.dataBits,
      parity: this.options.parity,
      stopBits: this.options.stopBits,
      flowControl: this.options.flowControl,
    });
    this.opened = true;
    this.attachWriter();
    this.startReadLoop();
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.closing = true;

    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.writer = null;

    try {
      await this.reader?.cancel();
    } catch {
      /* already cancelled */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;

    // Wait for the loop to unwind, or the next open() races a live reader.
    if (this.readLoop !== null) {
      try {
        await this.readLoop;
      } catch {
        /* cancellation surfaces here */
      }
      this.readLoop = null;
    }

    try {
      await this.port.close();
    } catch {
      /* the device may already be gone */
    }
    this.opened = false;
    this.closing = false;
    this.buffer = "";
  }

  /**
   * Web Serial cannot reconfigure a live port, so this closes and reopens.
   *
   * Needed for real: switching the adapter to a faster UART with `ATBRD` or
   * `ST SBR` changes the line rate under us, and the reopen is how we follow it.
   */
  async configure(options: SerialOptions): Promise<void> {
    const unchanged =
      this.options.baudRate === options.baudRate &&
      this.options.dataBits === options.dataBits &&
      this.options.parity === options.parity &&
      this.options.stopBits === options.stopBits &&
      this.options.flowControl === options.flowControl;

    this.options = { ...options };
    if (!this.opened || unchanged) return;
    await this.close();
    await this.open();
  }

  async write(text: string): Promise<void> {
    if (!this.opened || this.writer === null) throw new Error("serial port is not open");
    await this.writer.ready;
    await this.writer.write(new TextEncoder().encode(text));
  }

  /** Some clones need DTR asserted before they answer. */
  async setSignals(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void> {
    if (!this.opened) return;
    await this.port.setSignals(signals);
  }

  /** Release the browser's permission grant for this port. */
  async forget(): Promise<void> {
    await this.port.forget?.();
  }

  private attachWriter(): void {
    if (this.port.writable === null) throw new Error("serial port has no writable stream");
    this.writer = this.port.writable.getWriter();
  }

  private startReadLoop(): void {
    if (this.port.readable === null) throw new Error("serial port has no readable stream");
    const reader = this.port.readable.getReader();
    this.reader = reader;

    this.readLoop = (async () => {
      try {
        while (this.opened) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value !== undefined && value.length > 0) {
            // `stream: true` so a multi-byte sequence split across chunks still
            // decodes — ELM replies are ASCII, but a cable glitch shouldn't
            // produce a replacement character that breaks hex parsing.
            this.push(this.decoder.decode(value, { stream: true }));
          }
        }
      } catch (error) {
        // A read error during close is expected; anything else is worth seeing.
        if (!this.closing) throw error;
      }
    })();
  }
}
