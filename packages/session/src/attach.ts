/**
 * Putting the adapter into the state one particular ECU needs.
 *
 * This is the only place that reads an ECU's `obd` block and turns it into driver
 * calls, and it exists as its own package because it is the seam between two
 * layers that should not know about each other: `@ddtx/elm` has no business
 * importing the database, and `@ddtx/db` has no business importing a driver.
 * Both the CLI and the browser need it, and duplicating it would be worse.
 *
 * The protocol choice is the ECU's, not ours — `ecu_file.connect_to_hardware`
 * dispatches on exactly these four values, and getting it wrong is silent: an ECU
 * that wants slow init and gets fast init simply never answers.
 */

import type { LoadedEcu } from "@ddtx/db";
import type { ElmDriver } from "@ddtx/elm";

export interface AttachResult {
  /** What was actually used, for the UI and the log. */
  protocol: "CAN" | "KWP2000" | "ISO8" | "ISO";
  /** CAN only. */
  idTx?: string;
  idRx?: string;
  /** K-line only: the functional address. */
  address?: string;
  /** Whether K-line init reported success. CAN has no equivalent. */
  initialised?: boolean;
}

export class UnsupportedProtocolError extends Error {
  constructor(readonly protocol: string) {
    super(
      `this ECU speaks ${protocol || "an unnamed protocol"}, which no transport here reaches — ` +
        "DoIP needs raw TCP and cannot be done from a browser",
    );
    this.name = "UnsupportedProtocolError";
  }
}

/**
 * Configure the adapter for this ECU.
 *
 * Safe to call again for the same ECU: the driver short-circuits when it is
 * already addressing it, so switching between two screens of one ECU costs
 * nothing.
 */
export async function attachEcu(driver: ElmDriver, ecu: LoadedEcu): Promise<AttachResult> {
  const obd = ecu.def.obd;
  const protocol = obd.protocol.toUpperCase();

  if (protocol === "CAN") {
    await driver.initCan();
    const idTx = obd.send_id ?? "7E0";
    const idRx = obd.recv_id ?? "7E8";
    await driver.setCanAddress({
      idTx,
      idRx,
      ecuname: ecu.def.ecuname,
      ...(obd.baudrate === undefined ? {} : { baudrate: obd.baudrate }),
    });
    return { protocol: "CAN", idTx, idRx };
  }

  if (protocol === "ISO8") {
    await driver.initIso();
    await driver.setIso8Address(obd.funcaddr);
    return { protocol: "ISO8", address: obd.funcaddr };
  }

  if (protocol === "KWP2000" || protocol === "ISO") {
    await driver.initIso();
    // `fastinit: true` in the database means fast init; its absence or `false`
    // means the ECU wants the 5-baud slow init instead.
    const initialised = await driver.setIsoAddress(obd.funcaddr, {
      slowInit: obd.fastinit !== true,
    });
    return {
      protocol: protocol === "ISO" ? "ISO" : "KWP2000",
      address: obd.funcaddr,
      initialised,
    };
  }

  throw new UnsupportedProtocolError(obd.protocol);
}

/** Can this ECU be reached at all by the transports available here? */
export function isReachable(ecu: LoadedEcu): boolean {
  const protocol = ecu.def.obd.protocol.toUpperCase();
  return protocol === "CAN" || protocol === "KWP2000" || protocol === "ISO8" || protocol === "ISO";
}

/** One line describing how the ECU is addressed, for the UI. */
export function describeAttachment(result: AttachResult): string {
  if (result.protocol === "CAN") {
    return `CAN — tx ${result.idTx ?? "?"} / rx ${result.idRx ?? "?"}`;
  }
  const init = result.initialised === false ? " (init did not confirm)" : "";
  return `${result.protocol} — address ${result.address ?? "?"}${init}`;
}
