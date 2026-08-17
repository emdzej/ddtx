/**
 * Believable ECU replies with no ECU.
 *
 * Demo mode is not a toy here — it is the only way to build and check a panel that
 * would otherwise need a van on a lift. The replies are derived from each request's
 * own definition, so a screen decodes them through exactly the same path a real
 * response takes, and the filler is seeded from the request name so a screen looks
 * the same on every run instead of flickering.
 */
import { requiredResponseBytes } from "@ddtx/link";
import type { BoundRequest } from "@ddtx/codec";
import type { LoadedEcu } from "@ddtx/db";
import { dtcReadRequestName, type DtcLink } from "./dtc.js";

/**
 * The payload a simulated ECU answers one request with.
 *
 * Long enough for every field the request reads, and for three fault records when it
 * is a fault request — byte 2 there is a *count*, and random filler declares
 * 200-odd records the response cannot possibly hold.
 */
export function simulatedReply(request: BoundRequest): string {
  const sent = (request.def.sentbytes ?? "").toUpperCase();
  const canned = (request.def.replybytes ?? "").toUpperCase();
  const needed = requiredResponseBytes(request);
  // Lead with the positive-response SID when nothing is stored: `firstbyte` is
  // 1-based including it, and some screens read byte 1 directly.
  const sid = ((Number.parseInt(sent.slice(0, 2), 16) + 0x40) & 0xff)
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
  let reply = canned.length > 0 ? canned : sid;

  // Seeded from the request name so a screen looks the same on every run rather
  // than flickering with fresh noise each poll.
  let seed = 0x811c9dc5;
  for (const ch of request.def.name) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x01000193);
  const nextByte = (): string => {
    seed = (Math.imul(seed, 48271) + 11) >>> 0;
    return ((seed >>> 16) & 0xff).toString(16).toUpperCase().padStart(2, "0");
  };

  const stride = request.def.shiftbytescount ?? 0;
  if (stride > 0) {
    const records = 3;
    reply = `${sid}0${records}`;
    const bodyBytes = Math.max(needed, 2 + records * stride) - 2;
    for (let i = 0; i < bodyBytes; i++) reply += nextByte();
  }

  while (reply.length / 2 < needed) reply += nextByte();
  return reply;
}

/**
 * Map each request's sent frame to the payload a simulated ECU answers with.
 *
 * Keyed by sent bytes and first-definition-wins, matching the original's
 * dict-keyed lookup.
 */
export function simulatedReplies(ecu: LoadedEcu): Record<string, string> {
  const map: Record<string, string> = {};
  for (const request of ecu.requests.values()) {
    const sent = (request.def.sentbytes ?? "").toUpperCase();
    if (sent.length === 0) continue;
    map[sent] ??= simulatedReply(request);
  }
  return map;
}

/**
 * A `DtcLink` backed by simulated replies.
 *
 * Answers the ECU's own fault requests and nothing else — an unknown frame gets the
 * empty string, which the reader treats as "no answer" rather than as data. Clearing
 * against this link reports success without any bus to write to, which is the point:
 * the confirmation flow can be exercised without risk.
 */
export function simulatedDtcLink(ecu: LoadedEcu): DtcLink {
  const replies = simulatedReplies(ecu);

  // Answer the fault frame from the *fault* request's own definition. The map above
  // is keyed by sent bytes and first-definition-wins, matching the original's dict
  // lookup — and several ECUs have another request sending the same frame, which
  // would otherwise answer here with a reply too short to hold a single record.
  const readName = dtcReadRequestName(ecu);
  const readRequest = readName === undefined ? undefined : ecu.requests.get(readName);
  const readFrame = (readRequest?.def.sentbytes ?? "").replace(/\s+/g, "").toUpperCase();
  if (readRequest !== undefined && readFrame.length > 0) {
    replies[readFrame] = simulatedReply(readRequest);
  }
  let erased = false;

  return {
    request(frame: string): Promise<string> {
      const key = frame.replace(/\s+/g, "").toUpperCase();
      const sid = key.slice(0, 2);

      // A clear takes effect, so demo mode rehearses the real sequence: codes, then
      // erase, then none. A stateless simulator that keeps returning the same three
      // faults after a successful erase teaches the opposite of what happens.
      if (sid === "14" || sid === "04") {
        erased = true;
        return Promise.resolve(sid === "14" ? "54" : "44");
      }

      if (erased && key === readFrame) {
        // Positive response, header only: the ECU has nothing stored.
        const positive = ((Number.parseInt(sid, 16) + 0x40) & 0xff)
          .toString(16)
          .toUpperCase()
          .padStart(2, "0");
        return Promise.resolve(`${positive}00`);
      }

      const payload = replies[key];
      // An unknown frame gets the empty string, which the reader treats as "no
      // answer" rather than as data.
      return Promise.resolve(payload ?? "");
    },
  };
}
