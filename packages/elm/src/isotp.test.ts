import { describe, expect, it } from "vitest";
import {
  flowControlFrame,
  frameRequest,
  hexLines,
  parseFlowControl,
  reassemble,
  spaced,
  usableLines,
} from "./isotp.js";

describe("frameRequest", () => {
  it("puts a short request in one frame, prefixed with its length", () => {
    expect(frameRequest("2110")).toEqual(["022110"]);
    expect(frameRequest("21")).toEqual(["0121"]);
  });

  it("fills a single frame right up to seven bytes", () => {
    expect(frameRequest("11223344556677")).toEqual(["0711223344556677"]);
  });

  it("splits eight bytes into a first frame plus one consecutive frame", () => {
    // First frame: "1" + 3-nibble total length + 6 payload bytes.
    expect(frameRequest("1122334455667788")).toEqual(["1008112233445566", "217788"]);
  });

  it("numbers consecutive frames and wraps the sequence at 16", () => {
    // 6 bytes in the first frame, then 7 per consecutive frame: 6 + 16×7 = 118.
    const frames = frameRequest("AA".repeat(118));
    expect(frames).toHaveLength(17);
    const sequences = (frames as string[]).slice(1).map((f) => f[1]);
    // 1..F then wraps to 0.
    expect(sequences.join("")).toBe("123456789ABCDEF0");
  });

  it("normalises whitespace and case", () => {
    expect(frameRequest(" 21 10 ")).toEqual(["022110"]);
    expect(frameRequest("2110".toLowerCase())).toEqual(["022110"]);
  });

  it("returns the original's error strings rather than throwing", () => {
    expect(frameRequest("211")).toBe("ODD ERROR");
    expect(frameRequest("21ZZ")).toBe("HEX ERROR");
    expect(frameRequest("")).toEqual([]);
  });
});

describe("usableLines", () => {
  it("drops the echo, blanks, non-hex and flow control", () => {
    const reply = "022110\n0461001234\n300000\nSEARCHING...\n\n>";
    expect(usableLines(reply, "022110")).toEqual(["0461001234"]);
  });

  it("cancels the echo even when the adapter spaced it out", () => {
    // `AT S0` should prevent this, but clones reset it on `AT SP`.
    expect(usableLines("02 21 10\n0461001234\n>", "022110")).toEqual(["0461001234"]);
  });
});

describe("reassemble", () => {
  it("returns nothing when nothing came back", () => {
    expect(reassemble([], "21")).toEqual({ value: "", frames: 0 });
  });

  it("reads a single frame and trims the CAN padding", () => {
    // Declares 4 bytes; the rest is padding the ECU added to fill the frame.
    expect(reassemble(["046100123400"], "21")).toEqual({ value: "61 00 12 34", frames: 1 });
  });

  it("reassembles a multi-frame response in order", () => {
    // First frame declares 10 bytes and carries 6 of them; the consecutive frame
    // brings the remaining 4, padded out to fill the CAN frame.
    const result = reassemble(["100A610011223344", "2155667788000000"], "21");
    expect(result.value).toBe("61 00 11 22 33 44 55 66 77 88");
    expect(result.error).toBeUndefined();
  });

  it("flags a lost consecutive frame instead of returning a short payload", () => {
    // Sequence jumps 1 → 3.
    const result = reassemble(["1014610011223344", "2155667788990011", "2300112233445566"], "21");
    expect(result.error).toBe("frame");
    expect(result.value).toBe("");
  });

  it("flags a first frame with nothing behind it", () => {
    // The signature of AT CAF0 having been reset by AT SP.
    expect(reassemble(["100A610011223344"], "21").error).toBe("frame");
  });

  it("flags a response with no ISO-TP prefix at all", () => {
    // What AT CAF1 produces.
    expect(reassemble(["6100123400"], "21").error).toBe("frame");
  });

  it("skips a response-pending frame and uses what follows", () => {
    // NRC 0x78 means "wait", and the real answer arrives in the same batch.
    const result = reassemble(["037F2178", "046100123400"], "21");
    expect(result.value).toBe("61 00 12 34");
  });

  it("reports a negative response with its code", () => {
    const result = reassemble(["037F2111"], "21");
    expect(result.negative).toEqual({ code: "11" });
    expect(result.value).toBe("7F 21 11");
  });

  it("picks the diagnostic frame out of broadcast traffic", () => {
    // Some ECUs broadcast continuously on their own TX id, so the batch contains
    // unrelated single frames. 21 + 0x40 = 61 identifies ours.
    const result = reassemble(["08AABBCCDDEEFF00", "046100123400", "0812345678"], "21");
    expect(result.value).toBe("61 00 12 34");
  });

  it("finds a negative response among broadcasts too", () => {
    const result = reassemble(["08AABBCCDDEEFF00", "037F2131"], "21");
    expect(result.negative).toEqual({ code: "31" });
  });

  it("reassembles a multi-frame response that broadcasts preceded", () => {
    const result = reassemble(["08AABBCCDDEEFF00", "100A610011223344", "2155667788000000"], "21");
    expect(result.value).toBe("61 00 11 22 33 44 55 66 77 88");
  });

  it("falls back to the first frame when nothing looks diagnostic", () => {
    // Better to show the caller something than an unexplained empty string.
    const result = reassemble(["04AABBCCDD00", "04EEFF001100"], "21");
    expect(result.value).toBe("AA BB CC DD");
  });
});

describe("spaced", () => {
  it("splits hex into bytes for the codec", () => {
    expect(spaced("6100E8")).toBe("61 00 E8");
    expect(spaced("")).toBe("");
  });
});

describe("flow control", () => {
  it("reads the block size and separation time an ECU asked for", () => {
    expect(parseFlowControl("300A14")).toEqual({ blockSize: 10, separationMs: 20 });
  });

  it("is not fooled by a consecutive frame, which also carries data", () => {
    expect(parseFlowControl("2100112233445566")).toBeUndefined();
    expect(parseFlowControl("1014610011223344")).toBeUndefined();
  });

  it("reads Fx separation as microseconds, per ISO 15765", () => {
    // The original sleeps `x * 100` **milliseconds** here — a thousand times what
    // the ECU asked for, enough to blow the 5 s session timeout on a long request.
    expect(parseFlowControl("3000F9")?.separationMs).toBeCloseTo(0.9);
    expect(parseFlowControl("3000F1")?.separationMs).toBeCloseTo(0.1);
  });

  it("falls back to the original's defaults on a truncated frame", () => {
    expect(parseFlowControl("30")).toEqual({ blockSize: 3, separationMs: 239 });
  });

  it("keeps block size 0 distinct — it means send everything", () => {
    expect(parseFlowControl("300000")).toEqual({ blockSize: 0, separationMs: 0 });
  });

  it("caps a requested block at 7 and tells the adapter how many to await", () => {
    // Odd length on purpose: `30 0N 00` is the three-byte frame and the trailing
    // nibble is the ELM327's "expect N responses" suffix, not part of it. Asking for
    // more than the adapter hands back in one go loses frames, hence the cap.
    expect(flowControlFrame(20)).toBe("3007007");
    expect(flowControlFrame(3)).toBe("3003003");
    expect(flowControlFrame(0)).toBe("3001001");
  });

  it("keeps flow-control frames that usableLines drops", () => {
    const reply = "0140\n300800\n6100E8\n>";
    expect(usableLines(reply, "0140")).toEqual(["6100E8"]);
    expect(hexLines(reply, "0140")).toEqual(["300800", "6100E8"]);
  });
});
