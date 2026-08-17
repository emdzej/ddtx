/**
 * The byte pipe under the ELM327 driver.
 *
 * Delimiter-oriented, not length-oriented, because that is what an ELM327 is: you
 * write a line and read until the `>` prompt. This is exactly why the transport in
 * `@emdzej/ediabasx-interface-serial` couldn't be reused — its `read(length,
 * timeoutMs)` models fixed-size KWP telegrams, and emulating a delimiter read on
 * top of it either costs a promise per byte or truncates a reply that pauses
 * longer than the idle timeout, which an ELM legitimately does while it prints
 * `SEARCHING...` or collects a multi-frame response. See docs/plan.md §5.
 *
 * Kept an interface so the driver can run against Web Serial, Node serial, or the
 * mock in `mock.ts` without knowing which.
 */

export interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  parity?: "none" | "even" | "odd";
  stopBits?: 1 | 2;
  /** ELM327 clones vary; some need hardware flow control, most don't. */
  flowControl?: "none" | "hardware";
}

export interface ElmTransport {
  /** Human-readable, for logs and the UI. */
  readonly description: string;

  open(): Promise<void>;
  close(): Promise<void>;

  /**
   * Change line settings mid-session.
   *
   * Needed because switching the adapter to a faster UART (`ATBRD` / `ST SBR`)
   * changes the baud rate underneath us. Web Serial can't reconfigure an open
   * port, so implementations close and reopen.
   */
  configure(options: SerialOptions): Promise<void>;

  write(text: string): Promise<void>;

  /**
   * Read until `delimiter` appears, or `timeoutMs` elapses.
   *
   * On timeout it returns what it has **with `"TIMEOUT"` appended**, rather than
   * throwing — the original's `Port.expect` does this and callers up the stack
   * test for the marker in the string. Preserved deliberately: changing it to an
   * exception would silently alter the retry behaviour of every AT command.
   */
  readUntil(delimiter: string, timeoutMs: number): Promise<string>;

  /** Drop anything buffered but unread. */
  purge(): Promise<void>;
}

/** Appended to a partial read on timeout, and tested for by the driver. */
export const TIMEOUT_MARKER = "TIMEOUT";

/**
 * Shared buffer logic for a real transport.
 *
 * Subclasses feed bytes in with {@link push} and implement the I/O; this handles
 * accumulating, the `\r` → `\n` translation the original does, and waking a
 * pending `readUntil`.
 */
export abstract class BufferedTransport implements ElmTransport {
  abstract readonly description: string;

  protected buffer = "";
  private waiter: (() => void) | null = null;

  abstract open(): Promise<void>;
  abstract close(): Promise<void>;
  abstract configure(options: SerialOptions): Promise<void>;
  abstract write(text: string): Promise<void>;

  /**
   * Feed received bytes in.
   *
   * `\r` becomes `\n` here, matching `Port.expect`. The ELM terminates lines with
   * CR alone, and the rest of the driver splits on `\n`.
   */
  protected push(text: string): void {
    this.buffer += text.replace(/\r/g, "\n");
    this.waiter?.();
  }

  async readUntil(delimiter: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const at = this.buffer.indexOf(delimiter);
      if (at >= 0) {
        const taken = this.buffer.slice(0, at + delimiter.length);
        this.buffer = this.buffer.slice(at + delimiter.length);
        return taken;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const taken = this.buffer;
        this.buffer = "";
        return taken + TIMEOUT_MARKER;
      }

      await this.waitForData(remaining);
    }
  }

  async purge(): Promise<void> {
    this.buffer = "";
  }

  /** Resolve as soon as bytes arrive, or after `ms`, whichever is first. */
  private waitForData(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.waiter = null;
        clearTimeout(timer);
        resolve();
      };
      // Poll interval is a ceiling, not the mechanism: `push` wakes us early.
      const timer = setTimeout(finish, Math.min(ms, 20));
      this.waiter = finish;
    });
  }
}
