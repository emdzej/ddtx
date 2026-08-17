/**
 * `ElmTransport` over Node's `serialport`.
 *
 * Lives here rather than in `@ddtx/elm` on purpose: `serialport` is a native
 * Node-only module, and importing it from the driver package would drag it into
 * the browser bundle. The driver defines the interface; each host supplies its
 * own implementation — Web Serial in the app, this one in the CLI.
 *
 * That split is also what makes the CLI a fair instrument for the phase-0
 * measurement: everything above the transport is byte-identical to what the
 * browser runs, so a timing difference between the two is a transport difference
 * and nothing else.
 */

import { SerialPort } from "serialport";
import { BufferedTransport, type SerialOptions } from "@ddtx/elm";

export interface PortDescription {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
}

/** Everything the OS knows about the attached serial devices. */
export async function listPorts(): Promise<PortDescription[]> {
  const ports = await SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
    ...(port.vendorId === undefined ? {} : { vendorId: port.vendorId }),
    ...(port.productId === undefined ? {} : { productId: port.productId }),
    ...(port.serialNumber === undefined ? {} : { serialNumber: port.serialNumber }),
  }));
}

/**
 * Is this port likely to be an OBD adapter?
 *
 * Only used to make `ports` output readable — the USB-serial bridges these
 * adapters use are all generic parts, so this is a hint, never a filter.
 */
export function looksLikeAdapter(port: PortDescription): boolean {
  const vendor = (port.vendorId ?? "").toLowerCase();
  // FTDI, Prolific, Silicon Labs CP210x, WCH CH340, Microchip/MCP.
  const knownBridges = ["0403", "067b", "10c4", "1a86", "04d8"];
  if (knownBridges.includes(vendor)) return true;
  return /usbserial|usbmodem|ftdi|ch340|cp210|obd|stn/i.test(
    `${port.path} ${port.manufacturer ?? ""}`,
  );
}

export class NodeSerialTransport extends BufferedTransport {
  readonly description: string;

  private port: SerialPort | null = null;
  private options: SerialOptions;

  constructor(
    private readonly path: string,
    options: Partial<SerialOptions> = {},
  ) {
    super();
    this.options = {
      baudRate: options.baudRate ?? 38400,
      dataBits: options.dataBits ?? 8,
      parity: options.parity ?? "none",
      stopBits: options.stopBits ?? 1,
      flowControl: options.flowControl ?? "none",
    };
    this.description = `${path} @ ${this.options.baudRate}`;
  }

  async open(): Promise<void> {
    if (this.port !== null) return;

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.path,
          baudRate: this.options.baudRate,
          dataBits: this.options.dataBits ?? 8,
          parity: this.options.parity ?? "none",
          stopBits: this.options.stopBits ?? 1,
          rtscts: this.options.flowControl === "hardware",
          autoOpen: false,
        },
        // The constructor's callback fires for open errors when autoOpen is off.
      );

      port.on("data", (chunk: Buffer) => this.push(chunk.toString("latin1")));
      port.on("error", (error: Error) => {
        // Surface it rather than letting an unhandled 'error' kill the process.
        process.stderr.write(`serial error on ${this.path}: ${error.message}\n`);
      });

      port.open((error) => {
        if (error) {
          reject(new Error(`cannot open ${this.path}: ${error.message}`));
          return;
        }
        this.port = port;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const port = this.port;
    if (port === null) return;
    this.port = null;
    await new Promise<void>((resolve) => {
      port.close(() => resolve());
    });
    this.buffer = "";
  }

  /**
   * Change line settings on the open port.
   *
   * Unlike Web Serial, `serialport` can do this in place — which is worth noting
   * for the phase-0 comparison: if a baud switch behaves differently between the
   * CLI and the browser, the close-and-reopen the browser has to do is why.
   */
  async configure(options: SerialOptions): Promise<void> {
    this.options = { ...options };
    const port = this.port;
    if (port === null) return;
    await new Promise<void>((resolve, reject) => {
      port.update({ baudRate: options.baudRate }, (error) => {
        if (error) reject(new Error(`cannot set baud rate: ${error.message}`));
        else resolve();
      });
    });
  }

  async write(text: string): Promise<void> {
    const port = this.port;
    if (port === null) throw new Error(`${this.path} is not open`);
    await new Promise<void>((resolve, reject) => {
      port.write(text, "latin1", (error) => {
        if (error) reject(new Error(`write failed: ${error.message}`));
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      // Drain before returning, so a timing measurement covers the whole
      // write→reply round trip rather than just the enqueue.
      port.drain((error) => {
        if (error) reject(new Error(`drain failed: ${error.message}`));
        else resolve();
      });
    });
  }
}
