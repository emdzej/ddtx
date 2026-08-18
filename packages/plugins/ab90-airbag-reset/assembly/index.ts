/**
 * AB90 airbag reset.
 *
 * Port of `plugins/ab90_reset.py`. Reads the module's state, reports it, then performs
 * the reset — the same order the original's two buttons do it in, collapsed into one
 * sequence because a plugin here is a procedure rather than a dialog.
 *
 * The access code 22041998 is the original's, embedded in the plugin exactly as written there. It is not a secret and not derived — it is what the module expects.
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
      return session('Start Diagnostic Session');
    case 1:
      return read('Synthèse état UCE');
    case 2:
      state = field(result, 'crash détecté');
      return log('Module reports: ' + (state.length > 0 ? state : 'no value'));
    case 3:
      return write('Reset crash ou accès au mode fournisseur', '{"code d\'accès pour reset UCE": "22041998"}');
    case 4:
      return succeeded(result)
        ? done('Done. Re-read the module to confirm.')
        : failed('The module refused the last request.');
    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
