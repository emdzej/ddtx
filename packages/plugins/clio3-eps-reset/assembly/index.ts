/**
 * Modus / Clio III EPS — erase the dongle ID code.
 *
 * Port of the `reset_ecu` half of `plugins/clio3_eps_reset.py`. The original's dialog
 * also writes a VIN; that is a separate procedure and lives in `clio3-eps-write-vin`,
 * because it needs an operator-supplied value and has a different failure mode.
 *
 * Note the session: `SDS - Start Diagnostic $FB`, not the plain one. The original calls
 * `start_diag_session_fb()` here and `start_diag_session()` for the VIN write, and the
 * two are not interchangeable.
 *
 * **Unverified on a vehicle.** The slug and request names are checked against the real
 * database; the effect is not.
 */

import { done, failed, log, read, readResult, session, succeeded, write } from "../../_sdk/assembly/host";

export { alloc } from "../../_sdk/assembly/host";

let step: i32 = -1;

export function start(): i32 {
  step = 0;
  return next("");
}

export function resume(ptr: i32, len: i32): i32 {
  step += 1;
  return next(readResult(ptr, len));
}

function next(result: string): i32 {
  switch (step) {
    case 0:
      return read("RDBLI - System Frame");
    case 1:
      return log(succeeded(result) ? "Module state read." : "Could not read the module state.");
    case 2:
      return session("SDS - Start Diagnostic $FB");
    case 3:
      return write("WDBLI - Erase of Dongle_ID code", "{}");
    case 4:
      return succeeded(result)
        ? done("Dongle ID erased. Re-read the module to confirm.")
        : failed("The module refused the erase.");
    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
