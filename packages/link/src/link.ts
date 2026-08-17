/**
 * The request/response channel to one ECU.
 *
 * Byte-oriented on purpose: this is what an ELM327 actually offers, so the
 * screen runtime above it can't accidentally depend on knowing more than the
 * wire does. The `hint` is the one concession — a live link ignores it, while
 * the simulator uses it to find the canned reply without having to reverse a
 * frame back into the request that produced it.
 */

export interface RequestHint {
  /** Name of the request definition that produced this frame. */
  requestName: string;
}

export interface EcuLink {
  readonly kind: "simulated" | "elm";

  /**
   * Send a request frame and return the response frame.
   *
   * Both are hex text. Separators are tolerated on the way in and present on the
   * way out (`"61 0A 16 32"`), matching `ELM.request`, whose output feeds
   * straight into the codec.
   *
   * A negative response (`7F …`) is returned as-is rather than thrown: the
   * original inspects the string, and callers need the NRC to explain itself.
   */
  request(frame: string, hint?: RequestHint): Promise<string>;

  /** Drop any response cache, as `ELM.clear_cache` does before a screen update. */
  clearCache(): void;
}

/**
 * The negative-response code table, transcribed from `core/elm/constants.py`
 * `negrsp` (52 entries). Renault ECUs use plenty of the manufacturer-specific
 * range — "Engine Is Running", "Brake Switch(es) Not Closed" — and those are
 * exactly the ones a user needs spelled out, because they say what to change
 * about the car rather than about the request.
 */
export const NEGATIVE_RESPONSE_CODES: Readonly<Record<string, string>> = {
  "10": "General Reject",
  "11": "Service Not Supported",
  "12": "SubFunction Not Supported",
  "13": "Incorrect Message Length Or Invalid Format",
  "21": "Busy Repeat Request",
  "22": "Conditions Not Correct Or Request Sequence Error",
  "23": "Routine Not Complete",
  "24": "Request Sequence Error",
  "31": "Request Out Of Range",
  "33": "Security Access Denied- Security Access Requested",
  "35": "Invalid Key",
  "36": "Exceed Number Of Attempts",
  "37": "Required Time Delay Not Expired",
  "40": "Download not accepted",
  "41": "Improper download type",
  "42": "Can not download to specified address",
  "43": "Can not download number of bytes requested",
  "50": "Upload not accepted",
  "51": "Improper upload type",
  "52": "Can not upload from specified address",
  "53": "Can not upload number of bytes requested",
  "70": "Upload Download NotAccepted",
  "71": "Transfer Data Suspended",
  "72": "General Programming Failure",
  "73": "Wrong Block Sequence Counter",
  "74": "Illegal Address In Block Transfer",
  "75": "Illegal Byte Count In Block Transfer",
  "76": "Illegal Block Transfer Type",
  "77": "Block Transfer Data Checksum Error",
  "78": "Request Correctly Received-Response Pending",
  "79": "Incorrect ByteCount During Block Transfer",
  "7E": "SubFunction Not Supported In Active Session",
  "7F": "Service Not Supported In Active Session",
  "80": "Service Not Supported In Active Diagnostic Mode",
  "81": "Rpm Too High",
  "82": "Rpm Too Low",
  "83": "Engine Is Running",
  "84": "Engine Is Not Running",
  "85": "Engine RunTime TooLow",
  "86": "Temperature Too High",
  "87": "Temperature Too Low",
  "88": "Vehicle Speed Too High",
  "89": "Vehicle Speed Too Low",
  "8A": "Throttle/Pedal Too High",
  "8B": "Throttle/Pedal Too Low",
  "8C": "Transmission Range In Neutral",
  "8D": "Transmission Range In Gear",
  "8F": "Brake Switch(es)NotClosed (brake pedal not pressed or not applied)",
  "90": "Shifter Lever Not In Park",
  "91": "Torque Converter Clutch Locked",
  "92": "Voltage Too High",
  "93": "Voltage Too Low",
};

/** Is this response a negative one, and if so why? `null` when it isn't. */
export function negativeResponse(frame: string): { code: string; message: string } | null {
  const compact = frame.replace(/\s+/g, "").toUpperCase();
  if (!compact.startsWith("7F") || compact.length < 6) return null;
  const code = compact.slice(4, 6);
  return { code, message: NEGATIVE_RESPONSE_CODES[code] ?? "Unknown" };
}
