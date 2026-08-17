import { describe, expect, it } from "vitest";
import { resolveDataDictionary, type BoundRequest } from "@ddtx/codec";
import type { DataDef, RequestDef } from "@ddtx/core";
import { negativeResponse } from "./link.js";
import { requiredResponseBytes, SimulatedLink } from "./simulated.js";

function bind(defs: RequestDef[], data: Record<string, DataDef>): Map<string, BoundRequest> {
  const resolved = resolveDataDictionary(data);
  return new Map(
    defs.map((def) => [def.name, { def, endianness: "Big" as const, data: resolved }]),
  );
}

const data: Record<string, DataDef> = {
  Rpm: { scaled: true, bitscount: 16, bytescount: 2, step: 0.125, unit: "rpm" },
  Flag: { bitscount: 8, bytescount: 1, lists: { "0": "OFF", "1": "ON" } },
  Wide: { bitscount: 64, bytescount: 8 },
};

describe("requiredResponseBytes", () => {
  it("reaches to the end of the furthest field", () => {
    const [request] = [
      ...bind(
        [
          {
            name: "R",
            deny_sds: [],
            sentbytes: "2110",
            receivebyte_dataitems: { Rpm: { firstbyte: 2 }, Flag: { firstbyte: 9 } },
          },
        ],
        data,
      ).values(),
    ];
    // Flag starts at byte 9 (1-based) and spans one byte.
    expect(requiredResponseBytes(request!)).toBe(9);
  });

  it("accounts for a bit offset pushing a field into the next byte", () => {
    const [request] = [
      ...bind(
        [
          {
            name: "R",
            deny_sds: [],
            receivebyte_dataitems: { Rpm: { firstbyte: 1, bitoffset: 4 } },
          },
        ],
        data,
      ).values(),
    ];
    // 16 bits at offset 4 spans 3 bytes.
    expect(requiredResponseBytes(request!)).toBe(3);
  });

  it("never returns less than minbytes", () => {
    const [request] = [...bind([{ name: "R", deny_sds: [], minbytes: 20 }], data).values()];
    expect(requiredResponseBytes(request!)).toBe(20);
  });
});

const requests = bind(
  [
    {
      name: "Full",
      deny_sds: [],
      sentbytes: "2110",
      replybytes: "6100120001",
      receivebyte_dataitems: { Rpm: { firstbyte: 2 }, Flag: { firstbyte: 5 } },
    },
    {
      name: "Short",
      deny_sds: [],
      sentbytes: "2111",
      replybytes: "61",
      receivebyte_dataitems: { Wide: { firstbyte: 2 } },
    },
    {
      name: "NoReply",
      deny_sds: [],
      sentbytes: "2112",
      receivebyte_dataitems: { Flag: { firstbyte: 2 } },
    },
    {
      name: "WithInput",
      deny_sds: [],
      sentbytes: "31A000",
      replybytes: "71A000",
      sendbyte_dataitems: { Flag: { firstbyte: 3 } },
    },
  ],
  data,
);

describe("SimulatedLink", () => {
  it("returns the canned reply verbatim in canned mode", async () => {
    const link = new SimulatedLink(requests, { fill: "canned" });
    expect(await link.request("2110")).toBe("61 00 12 00 01");
  });

  it("returns nothing when canned mode has no reply to give", async () => {
    // Faithful to `send_request`, which yields "" and leaves every field null.
    const link = new SimulatedLink(requests, { fill: "canned" });
    expect(await link.request("2112")).toBe("");
  });

  it("pads a short canned reply up to the length the fields need", async () => {
    const link = new SimulatedLink(requests, { fill: "pad" });
    const response = await link.request("2111");
    const bytes = response.replace(/ /g, "").length / 2;
    // Wide is 8 bytes starting at byte 2, so 9 are needed; canned gives 1.
    expect(bytes).toBe(9);
    expect(response.startsWith("61 ")).toBe(true);
  });

  it("leaves an already-sufficient canned reply alone in pad mode", async () => {
    const link = new SimulatedLink(requests, { fill: "pad" });
    expect(await link.request("2110")).toBe("61 00 12 00 01");
  });

  it("keeps the real response SID when generating synthetically", async () => {
    const link = new SimulatedLink(requests, { fill: "synthetic" });
    expect((await link.request("2110")).startsWith("61 ")).toBe(true);
  });

  it("derives a response SID for a request with no canned reply", async () => {
    const link = new SimulatedLink(requests, { fill: "synthetic" });
    // 21 + 0x40 = 61
    expect((await link.request("2112")).startsWith("61 ")).toBe(true);
  });

  it("is deterministic, so a screen doesn't flicker between refreshes", async () => {
    const link = new SimulatedLink(requests, { fill: "synthetic" });
    const first = await link.request("2111");
    link.clearCache();
    expect(await link.request("2111")).toBe(first);
  });

  it("gives different values for a different seed", async () => {
    const a = new SimulatedLink(requests, { fill: "synthetic", seed: 1 });
    const b = new SimulatedLink(requests, { fill: "synthetic", seed: 2 });
    expect(await a.request("2111")).not.toBe(await b.request("2111"));
  });

  it("varies between refreshes when drift is on", async () => {
    const link = new SimulatedLink(requests, { fill: "synthetic", drift: true });
    const first = await link.request("2111");
    link.clearCache();
    expect(await link.request("2111")).not.toBe(first);
  });

  it("answers an unknown frame with service-not-supported", async () => {
    const link = new SimulatedLink(requests);
    const response = await link.request("9988");
    expect(negativeResponse(response)).toEqual({ code: "11", message: "Service Not Supported" });
  });

  it("prefers the hint over frame matching", async () => {
    const link = new SimulatedLink(requests, { fill: "canned" });
    // Frame says "Full", hint says "WithInput"; the hint wins.
    expect(await link.request("2110", { requestName: "WithInput" })).toBe("71 A0 00");
  });

  it("matches a frame whose input bytes differ from the template", async () => {
    // "WithInput" is 31A000; a filled-in input makes it 31A001.
    const link = new SimulatedLink(requests, { fill: "canned" });
    expect(await link.request("31A001")).toBe("71 A0 00");
  });

  it("tolerates separators and lower case on the way in", async () => {
    const link = new SimulatedLink(requests, { fill: "canned" });
    expect(await link.request("21 10")).toBe("61 00 12 00 01");
    expect(await link.request("2110".toLowerCase())).toBe("61 00 12 00 01");
  });
});

describe("SimulatedLink response framing", () => {
  it("leads a padded reply with the positive-response SID when nothing is stored", async () => {
    // `firstbyte` is 1-based including the SID byte, and some screens read byte 1
    // directly, so a generated frame must not start with a random byte.
    const link = new SimulatedLink(requests, { fill: "pad" });
    const response = await link.request("2112");
    expect(response.startsWith("61 ")).toBe(true);
  });

  it("still honours a stored reply's own SID when padding", async () => {
    const link = new SimulatedLink(requests, { fill: "pad" });
    expect((await link.request("2111")).startsWith("61 ")).toBe(true);
  });
});
