/**
 * ISO-TP framing and reassembly, done in software.
 *
 * Port of the framing and response-parsing halves of `elm.py:send_can`. The
 * ELM327 can do this itself with `AT CAF1`, but DDT4All deliberately runs
 * `AT CAF0` and builds the PCI bytes by hand, because the adapter's automatic
 * mode mis-handles Renault's longer responses. So these bytes go on the wire
 * exactly as written here.
 *
 * Kept pure and separate from the driver: it is the part most likely to be wrong,
 * and it is the part that can be exhaustively tested without an adapter.
 *
 * The frame layout, for reference — the first nibble is the PCI type:
 *
 *   0L dd dd dd dd dd dd dd    single frame, L = payload length
 *   1LLL dd dd dd dd dd dd     first frame, LLL = total payload length
 *   2N dd dd dd dd dd dd dd    consecutive frame, N = sequence number mod 16
 *   3F BS ST                   flow control (we ignore these on receive)
 */

const HEX = /^[0-9A-Fa-f]*$/;

/** A request too long for one frame is split; 7 bytes fit in a single frame. */
export const SINGLE_FRAME_MAX_BYTES = 7;

export type FramingError = "ODD ERROR" | "HEX ERROR";

/**
 * Split a request into the frames to write, PCI bytes included.
 *
 * Returns the error string the original returns, rather than throwing, because
 * callers pass it straight through to the caller as a response.
 */
export function frameRequest(request: string): string[] | FramingError {
  const command = request.trim().replace(/\s+/g, "").toUpperCase();
  if (command.length === 0) return [];
  if (command.length % 2 !== 0) return "ODD ERROR";
  if (!HEX.test(command)) return "HEX ERROR";

  const byteCount = command.length / 2;
  if (byteCount <= SINGLE_FRAME_MAX_BYTES) {
    return [byteCount.toString(16).toUpperCase().padStart(2, "0") + command];
  }

  const frames: string[] = [];
  // First frame carries a 3-nibble length and 6 payload bytes.
  frames.push(
    `1${byteCount.toString(16).toUpperCase().padStart(3, "0").slice(-3)}${command.slice(0, 12)}`,
  );

  let rest = command.slice(12);
  let sequence = 1;
  while (rest.length > 0) {
    // The sequence number wraps at 16, hence the single nibble.
    frames.push(`2${(sequence % 16).toString(16).toUpperCase()}${rest.slice(0, 14)}`);
    sequence += 1;
    rest = rest.slice(14);
  }
  return frames;
}

/**
 * Pull the usable hex lines out of an adapter's reply to one written frame.
 *
 * Drops the echo (the adapter repeats what it was sent, space-insensitively),
 * blank lines, anything non-hex, and flow-control frames — which this driver
 * ignores because it never has to honour them: it writes every frame of a
 * request back to back and lets the adapter buffer.
 */
export function usableLines(reply: string, sentFrame: string): string[] {
  const out: string[] = [];
  for (const raw of reply.split("\n")) {
    const line = raw.trim().replace(/\s+/g, "");
    if (line.length === 0) continue;
    if (line === sentFrame) continue; // echo
    if (!HEX.test(line)) continue;
    if (line.startsWith("3")) continue; // flow control
    out.push(line);
  }
  return out;
}

export interface Reassembled {
  /** Space-separated payload bytes, as the codec expects. Empty when nothing came back. */
  value: string;
  /** Frames the response occupied, for the L1 cache. */
  frames: number;
  /** Set when the response was well-formed but negative. */
  negative?: { code: string };
  /** Set when reassembly failed. `value` is then not usable. */
  error?: "frame" | "wrong-response";
}

/**
 * Rebuild a response payload out of the frames the adapter returned.
 *
 * `requestSid` is the service byte of the request, needed for the awkward case
 * in the middle: some ECUs broadcast continuously on their own TX CAN ID, so the
 * reply contains unrelated single frames alongside the real answer. The original
 * picks the frame whose payload starts with the expected positive-response SID
 * (`request + 0x40`) or with `7F`, which is the only way to tell them apart.
 */
export function reassemble(responses: readonly string[], requestSid: string): Reassembled {
  if (responses.length === 0) return { value: "", frames: 0 };

  let frames = [...responses];

  // "Response pending" (NRC 0x78): the ECU is telling us to wait, and the real
  // answer follows in the same batch.
  if (
    frames.length > 1 &&
    frames[0]?.startsWith("037F") === true &&
    frames[0]?.slice(6, 8) === "78"
  ) {
    frames = frames.slice(1);
  }

  const expectedPositive = positiveSid(requestSid);
  let result = "";
  let declaredBytes = 0;
  let frameCount = 0;
  let ok = true;

  const first = frames[0] as string;

  if (frames.length === 1) {
    if (first.startsWith("0")) {
      declaredBytes = Number.parseInt(first.slice(1, 2), 16);
      frameCount = 1;
      result = first.slice(2, 2 + declaredBytes * 2);
    } else if (first.startsWith("1")) {
      // A first frame with no consecutive frames behind it. Usually means
      // `AT CAF0` was reset by `AT SP`, or flow control never completed.
      ok = false;
    } else {
      // No ISO-TP length prefix at all — `AT CAF1` is probably still active.
      ok = false;
    }
  } else if (first.startsWith("0")) {
    const picked = pickDiagnosticFrame(frames, expectedPositive);
    if (picked !== undefined) {
      declaredBytes = Number.parseInt(picked.slice(1, 2), 16);
      frameCount = 1;
      result = picked.slice(2, 2 + declaredBytes * 2);
    } else {
      // Broadcast noise may still precede a genuine multi-frame response.
      const firstFrameIndex = frames.findIndex((f) => f.startsWith("1"));
      if (firstFrameIndex >= 0) {
        const multi = collectMultiFrame(frames.slice(firstFrameIndex));
        declaredBytes = multi.declaredBytes;
        frameCount = multi.frameCount;
        result = multi.result;
        ok = multi.ok;
      } else {
        // Nothing diagnostic in here; keep the first frame so the caller sees
        // *something* rather than an unexplained empty string.
        declaredBytes = Number.parseInt(first.slice(1, 2), 16);
        frameCount = 1;
        result = first.slice(2, 2 + declaredBytes * 2);
      }
    }
  } else if (first.startsWith("1")) {
    const multi = collectMultiFrame(frames);
    declaredBytes = multi.declaredBytes;
    frameCount = multi.frameCount;
    result = multi.result;
    ok = multi.ok;
  } else {
    ok = false;
  }

  const isNegative = result.startsWith("7F");
  if (isNegative) ok = false;

  if (result.length / 2 >= declaredBytes && ok) {
    // Trim the CAN padding the ECU added to fill its last frame.
    const trimmed = result.slice(0, declaredBytes * 2);
    return { value: spaced(trimmed), frames: frameCount };
  }

  if (isNegative) {
    return { value: spaced(result), frames: frameCount, negative: { code: result.slice(4, 6) } };
  }
  return { value: "", frames: frameCount, error: ok ? "wrong-response" : "frame" };
}

/** `SID + 0x40`, or `""` when the request byte isn't hex. */
function positiveSid(requestSid: string): string {
  const sid = Number.parseInt(requestSid, 16);
  if (Number.isNaN(sid)) return "";
  return ((sid + 0x40) & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Among a batch of single frames, find the one that is actually a response to us
 * rather than periodic broadcast traffic.
 */
function pickDiagnosticFrame(
  frames: readonly string[],
  expectedPositive: string,
): string | undefined {
  for (const frame of frames) {
    if (!frame.startsWith("0")) continue;
    const length = frame.length > 1 ? Number.parseInt(frame.slice(1, 2), 16) : 0;
    const payload = frame.slice(2, 2 + length * 2).toUpperCase();
    if (
      (expectedPositive !== "" && payload.startsWith(expectedPositive)) ||
      payload.startsWith("7F")
    ) {
      return frame;
    }
  }
  return undefined;
}

interface MultiFrame {
  declaredBytes: number;
  frameCount: number;
  result: string;
  ok: boolean;
}

/** Reassemble a first frame plus its consecutive frames, checking the sequence. */
function collectMultiFrame(frames: readonly string[]): MultiFrame {
  const first = frames[0] as string;
  const declaredBytes = Number.parseInt(first.slice(1, 4), 16);
  let result = first.slice(4, 16);
  let expected = 1;
  let ok = true;

  for (const frame of frames.slice(1)) {
    if (!frame.startsWith("2")) {
      ok = false;
      continue;
    }
    const sequence = Number.parseInt(frame.slice(1, 2), 16);
    if (sequence !== expected % 16) {
      // A frame was lost. Keep going so the caller can see how far it got.
      ok = false;
      continue;
    }
    expected += 1;
    result += frame.slice(2, 16);
  }

  return {
    declaredBytes,
    // Frames the payload occupies: the first carries 6 bytes, the rest 7 each.
    frameCount: Math.floor(declaredBytes / 7) + 1,
    result,
    ok,
  };
}

/** `"6100E8"` → `"61 00 E8"`, the shape the codec decodes. */
export function spaced(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(" ");
}
