/**
 * Megane / Scenic II card programming.
 *
 * Port of the badge-learning sequence in `plugins/card_programming.py`: enter
 * after-sales mode with a code, learn a card, then validate or abandon.
 *
 * ## What is deliberately not ported
 *
 * The original also derives the after-sales code from the module's ISK, via two bespoke
 * routines (`a8`, `a8_2`) transcribed from the immobiliser's key schedule. That
 * derivation is not reproduced here. The operator supplies the code instead — which the
 * original's dialog also allows, since it has a field for it.
 *
 * Reproducing a key-derivation routine that cannot be tested against a module is the
 * one thing in this port where being wrong is worse than being absent: a wrong code
 * would be sent to a live immobiliser.
 *
 * ## Validate or abandon is a real fork
 *
 * `SORTIE DU MODE APV : VALIDATION` commits the learned set; cards that were not present
 * during the procedure stop working. `SORTIE DU MODE APV : ABANDON` leaves it as it was.
 * The original has two buttons and so this asks, rather than assuming.
 *
 * **Unverified on a vehicle.** The slug and every request name are checked against the
 * real database; the effect is not.
 */

import { ask, done, escape, failed, field, log, read, readResult, session, succeeded, write } from "../../_sdk/assembly/host";

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
      return session("Start Diagnostic Session");

    case 1:
      return read("Status général des opérations badges Bits");
    case 2:
      return log(succeeded(result) ? "Badge status read." : "Could not read the badge status.");

    case 3:
      return ask("After-sales code for this UCH", "apv");
    case 4: {
      if (!succeeded(result)) return failed("No after-sales code was given.");
      const apv = field(result, "value").trim();
      if (apv.length == 0) return failed("No after-sales code was given.");
      return write("ACCEDER AU MODE APRES-VENTE", '{"Code APV":"' + escape(apv) + '"}');
    }

    case 5:
      if (!succeeded(result)) return failed("The module refused the after-sales code.");
      return log("In after-sales mode. Present the card to be learned now.");

    case 6:
      return ask("Press the card against the reader, then type: learn", "confirm");
    case 7:
      if (!succeeded(result)) return failed("Abandoned before learning.");
      return write("APPRENDRE BADGE", "{}");

    case 8:
      if (!succeeded(result)) return failed("The module refused to learn the card.");
      return read("Status général des opérations badges Octets");
    case 9:
      return log(succeeded(result) ? "Card learned. Cards known to the module re-counted." : "Learned, but the count could not be read back.");

    case 10:
      return ask("Type 'validate' to commit, or anything else to abandon", "decision");
    case 11: {
      if (!succeeded(result)) return failed("Abandoned; nothing was committed.");
      const decision = field(result, "value").trim().toLowerCase();
      return decision == "validate"
        ? write("SORTIE DU MODE APV : VALIDATION", "{}")
        : write("SORTIE DU MODE APV : ABANDON", "{}");
    }

    case 12:
      return succeeded(result)
        ? done("After-sales mode closed.")
        : failed("The module did not acknowledge leaving after-sales mode.");

    default:
      return failed("The procedure ran off the end of its sequence.");
  }
}
