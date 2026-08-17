/**
 * A scripted ELM327, so the driver can be verified without an adapter.
 *
 * The whole reason `packages/elm` could be written before the phase-0 car session:
 * nearly all of the driver is *correctness* — does it send the right AT sequence,
 * does it frame ISO-TP properly, does it reassemble what comes back — and all of
 * that is testable against a fake. The car session then only has to answer the
 * question a fake cannot: real timing (docs/plan.md §6.1).
 *
 * The mock behaves like an adapter rather than a lookup table: it echoes the
 * command when `AT E1` is on, terminates with `\r>`, tracks the handful of AT
 * settings the driver depends on, and answers OBD requests from a handler you
 * supply. That means tests exercise the same echo-cancellation and prompt-parsing
 * paths a real adapter would.
 */

import { BufferedTransport, type SerialOptions } from "./transport.js";

/** What the mock answers a written OBD frame with. */
export type FrameHandler = (frame: string, mock: MockElm) => string[] | string | undefined;

export interface MockElmOptions {
  /** Reported by `ATI`. `"ELM327 v1.5"` by default. */
  version?: string;
  /**
   * Reported by `STI`. Set to something like `"STN1170 v4.3.1"` to make the
   * driver take the STN/STPX path; leave unset and `STI` answers `"?"` as a plain
   * ELM327 clone does.
   */
  stnVersion?: string;
  /** Answers OBD frames. Returning `undefined` yields `NO DATA`. */
  onFrame?: FrameHandler;
  /** Simulated per-command delay, to exercise timeouts. */
  latencyMs?: number;
}

export class MockElm extends BufferedTransport {
  readonly description = "mock ELM327";

  /** Everything written, in order, for assertions about the AT sequence. */
  readonly written: string[] = [];
  /** AT settings the driver relies on, tracked so tests can assert on them. */
  readonly settings = new Map<string, string>();

  echo = true;
  opened = false;
  closes = 0;
  configured: SerialOptions | null = null;

  private readonly version: string;
  private readonly stnVersion: string | undefined;
  private readonly onFrame: FrameHandler;
  private readonly latencyMs: number;

  constructor(options: MockElmOptions = {}) {
    super();
    this.version = options.version ?? "ELM327 v1.5";
    this.stnVersion = options.stnVersion;
    this.onFrame = options.onFrame ?? (() => undefined);
    this.latencyMs = options.latencyMs ?? 0;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
    this.closes += 1;
  }

  async configure(options: SerialOptions): Promise<void> {
    this.configured = options;
  }

  async write(text: string): Promise<void> {
    // The driver appends "\r"; strip it to get the command.
    const command = text.replace(/\r$/, "");
    this.written.push(command);

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const reply = this.respond(command);
    // Echo first when E1 is on, exactly as an adapter does — the driver has to
    // cancel it, so tests should make it do that work.
    const body = this.echo ? `${command}\r${reply}` : reply;
    this.push(`${body}\r>`);
  }

  private respond(command: string): string {
    const upper = command.toUpperCase();

    if (upper.startsWith("AT") || upper.startsWith("ST")) {
      return this.respondToSetting(upper);
    }

    // A real ELM327 ignores spaces inside a request, and both request paths in
    // the original use them inconsistently — `send_request` joins with spaces,
    // `updateDisplay` does not. Normalise so a handler only sees one form.
    const frames = this.onFrame(upper.replace(/\s+/g, ""), this);
    if (frames === undefined) return "NO DATA";
    return (typeof frames === "string" ? [frames] : frames).join("\r");
  }

  private respondToSetting(upper: string): string {
    const compact = upper.replace(/\s+/g, "");

    if (compact === "ATZ") {
      this.echo = true;
      this.settings.clear();
      return this.version;
    }
    if (compact === "ATI") return this.version;
    if (compact === "STI") {
      // A plain clone doesn't know the command, and answering "?" is how the
      // driver detects that it is not talking to an STN part.
      return this.stnVersion ?? "?";
    }
    if (compact === "ATE0") {
      this.echo = false;
      return "OK";
    }
    if (compact === "ATE1") {
      this.echo = true;
      return "OK";
    }
    if (compact.startsWith("ATWS")) {
      this.echo = true;
      return this.version;
    }

    // STN-only commands are rejected by a plain clone, which is what makes
    // capability probing work.
    if (compact.startsWith("ST") && this.stnVersion === undefined) return "?";

    // Record settings so a test can assert the driver configured the adapter,
    // e.g. that CAF is off and the headers were set.
    const match = /^(AT|ST)([A-Z]+)\s*(.*)$/.exec(upper.replace(/\s+/g, " "));
    if (match !== null) {
      this.settings.set(`${match[1]}${match[2]}`, (match[3] ?? "").trim());
    }
    return "OK";
  }

  /** Commands written since the last call, for step-by-step assertions. */
  drain(): string[] {
    return this.written.splice(0);
  }
}

/**
 * Wrap a handler so it sees a whole request, not one frame at a time.
 *
 * A real adapter answers a multi-frame request only after the final frame — the
 * earlier writes get a bare prompt. Without this the mock replies to every frame,
 * which both invents traffic that would not exist and hides whether the driver
 * writes the frames correctly.
 */
export function reassemblingHandler(inner: FrameHandler): FrameHandler {
  let pending = "";

  return (frame, mock) => {
    const pci = frame.slice(0, 1);

    if (pci === "1") {
      // First frame: 3-nibble length, then 6 payload bytes.
      pending = frame.slice(4, 16);
      return "";
    }
    if (pci === "2") {
      pending += frame.slice(2, 16);
      // The driver writes every frame back to back, so the last one is the last
      // write; answer then. Trailing padding is trimmed by the caller's lookup.
      const complete = pending;
      pending = "";
      return inner(complete, mock);
    }
    // Single frame: strip the length nibble pair and pass the request through.
    return inner(frame.slice(2), mock);
  };
}

/**
 * A handler that answers with a correctly framed single- or multi-frame response.
 *
 * Takes the payload the ECU should return and does the ISO-TP framing, so tests
 * can say "the ECU replies 61 80 1A 3C" without hand-writing PCI bytes.
 */
export function respondWithPayload(payloadByRequest: Record<string, string>): FrameHandler {
  return (frame) => {
    // Strip the request's own PCI byte to recover the service request. Also try
    // the frame verbatim, so a handler wrapped by `reassemblingHandler` — which
    // has already stripped it — still matches.
    const payload = payloadByRequest[frame.slice(2)] ?? payloadByRequest[frame];
    if (payload === undefined) return undefined;

    const hex = payload.replace(/\s+/g, "").toUpperCase();
    const bytes = hex.length / 2;
    if (bytes <= 7) {
      return [bytes.toString(16).toUpperCase().padStart(2, "0") + hex.padEnd(14, "0")];
    }

    const frames = [
      `1${bytes.toString(16).toUpperCase().padStart(3, "0").slice(-3)}${hex.slice(0, 12)}`,
    ];
    let rest = hex.slice(12);
    let sequence = 1;
    while (rest.length > 0) {
      frames.push(
        `2${(sequence % 16).toString(16).toUpperCase()}${rest.slice(0, 14).padEnd(14, "0")}`,
      );
      sequence += 1;
      rest = rest.slice(14);
    }
    return frames;
  };
}
