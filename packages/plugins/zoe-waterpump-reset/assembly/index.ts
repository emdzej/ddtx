/**
 * Zoe water pump counter reset.
 *
 * Port of `plugins/zoe_waterpump_counter_reset.py`. Reads all four counters, reports
 * them, then writes zero to each.
 *
 * Two details carried over deliberately:
 *
 *  - **The read uses the default session and the writes use the extended one.** The
 *    original's `get_counters_values` calls `start_diag_session` while every reset path
 *    calls `start_diag_extend_session`. Reading in the extended session may work, but
 *    the original does not do that and this is not the place to find out.
 *  - **Zero is written as the string `"0"`.** The original passes `0` for three counters
 *    and `"0"` for the timer; `buildDataStream` looks values up as text, so they are all
 *    strings here. The host coerces either way, but being consistent costs nothing.
 *
 * **Unverified on a vehicle.** The slug and request names are checked against the real
 * database; the effect is not.
 */

import { done, failed, log, read, readResult, session, sessionWith, succeeded, write } from "../../_sdk/assembly/host";

export { alloc } from "../../_sdk/assembly/host";

const LOW = "($3349) Time Counter for the driving WEP in Low Speed";
const MID = "($334A) Time Counter for the driving WEP in Middle Speed";
const HIGH = "($334B) Time Counter for the driving WEP in High Speed";
const TIMER = "($3531) V_Timer_DrivWEP_ON";

let step: i32 = -1;
let readings: string = "";

export function start(): i32 {
  step = 0;
  readings = "";
  return next("");
}

export function resume(ptr: i32, len: i32): i32 {
  step += 1;
  return next(readResult(ptr, len));
}

/** Collect a counter's value for the closing summary. */
function note(label: string, result: string): void {
  readings += (readings.length > 0 ? ", " : "") + label + " " + (succeeded(result) ? "read" : "unreadable");
}

function next(result: string): i32 {
  switch (step) {
    case 0:
      return session("StartDiagnosticSession.Default");
    case 1:
      return read("DataRead." + LOW);
    case 2:
      note("low", result);
      return read("DataRead." + MID);
    case 3:
      note("middle", result);
      return read("DataRead." + HIGH);
    case 4:
      note("high", result);
      return read("DataRead." + TIMER);
    case 5:
      note("timer", result);
      return log("Counters before the reset: " + readings);

    case 6:
      // The extended session is what the original opens before every write.
      return session("StartDiagnosticSession.ExtendedDiagnosticSession");
    case 7:
      return write("DataWrite." + LOW, '{"' + LOW + '":"0"}');
    case 8:
      if (!succeeded(result)) return failed("The low-speed counter was refused.");
      return write("DataWrite." + MID, '{"' + MID + '":"0"}');
    case 9:
      if (!succeeded(result)) return failed("The middle-speed counter was refused.");
      return write("DataWrite." + HIGH, '{"' + HIGH + '":"0"}');
    case 10:
      if (!succeeded(result)) return failed("The high-speed counter was refused.");
      return write("DataWrite." + TIMER, '{"' + TIMER + '":"0"}');
    case 11:
      return succeeded(result)
        ? done("All four counters cleared. Re-read to confirm.")
        : failed("The timer was refused.");
    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
