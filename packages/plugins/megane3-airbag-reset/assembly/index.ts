/**
 * Megane III airbag reset.
 *
 * Port of `plugins/megane3_ab_reset.py`. Reads the module's state, reports it, then performs
 * the reset — the same order the original's two buttons do it in, collapsed into one
 * sequence because a plugin here is a procedure rather than a dialog.
 *
 * Two sessions in sequence, supplier-specific then extended, which is what the original does before the reset.
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

let state: string = "";

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
      return sessionWith('Start Diagnostic Session', '{"Session Name": "systemSupplierSpecific"}');
    case 1:
      return sessionWith('Start Diagnostic Session', '{"Session Name": "extendedDiagnosticSession"}');
    case 2:
      return read('Synthèse état UCE avant crash');
    case 3:
      state = field(result, 'crash détecté');
      return log('Module reports: ' + (state.length > 0 ? state : 'no value'));
    case 4:
      return write('Reset crash ou accès au mode fournisseur', '{"code d\'accès pour reset UCE": "27081977"}');
    case 5:
      return succeeded(result)
        ? done('Done. Re-read the module to confirm.')
        : failed('The module refused the last request.');
    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
