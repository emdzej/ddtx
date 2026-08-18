/**
 * Clio IV EPS reset.
 *
 * Port of `plugins/clio4_eps_reset.py`. Reads the module's state, reports it, then performs
 * the reset — the same order the original's two buttons do it in, collapsed into one
 * sequence because a plugin here is a procedure rather than a dialog.
 *
 * The original names `X98ph2_X87ph2_EPS_HFP_v1.00_20150622T140219_20160726T172209`, which this database snapshot does not carry. Pointed at `X98_87Ph2_EPS_HFP_v3` instead, which is the same module at a later version and does define all four requests — but the substitution is unverified on a vehicle.
 *
 * **Unverified on a vehicle.** The ECU slug and every request name are checked against
 * the real database, so a typo fails before anything is sent. Whether the sequence has
 * its intended effect on a real module is not something any test here can establish.
 */

import {
  done,
  failed,
  field,
  log,
  read,
  readResult,
  session,
  sessionWith,
  succeeded,
  write,
} from "../../_sdk/assembly/host";

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
      return session('StartDiagnosticSession.extendedSession');
    case 1:
      return session('StartDiagnosticSession.supplierSession');
    case 2:
      return read('DataRead.DongleState');
    case 3:
      return log('Module state read.');
    case 4:
      return write('SRBLID.DongleBlanking.Request', '{"Dongle.Code": "1976"}');
    case 5:
      return succeeded(result)
        ? done('Done. Re-read the module to confirm.')
        : failed('The module refused the last request.');
    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
