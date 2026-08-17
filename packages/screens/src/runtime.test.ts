import { describe, expect, it } from "vitest";
import { resolveDataDictionary, type BoundRequest } from "@ddtx/codec";
import type { DataDef, LayoutFileDef, RequestDef, ScreenDef } from "@ddtx/core";
import { prepareLayout, type LoadedEcu } from "@ddtx/db";
import type { EcuLink, RequestHint } from "@ddtx/link";
import { NO_DATA, ScreenRuntime, testerPresentFrame } from "./runtime.js";

const font = { name: "Arial", size: 9, bold: "0", italic: "0" };
const rect = { left: 0, top: 0, width: 100, height: 100 };

const data: Record<string, DataDef> = {
  Rpm: { scaled: true, bitscount: 16, bytescount: 2, step: 1 },
  Flag: { bitscount: 8, bytescount: 1, lists: { "0": "OFF", "1": "ON" } },
  Setting: { bitscount: 8, bytescount: 1 },
};

const requestDefs: RequestDef[] = [
  {
    name: "Poll",
    deny_sds: [],
    sentbytes: "2110",
    receivebyte_dataitems: { Rpm: { firstbyte: 2 }, Flag: { firstbyte: 4 } },
  },
  {
    name: "Manual",
    deny_sds: [],
    sentbytes: "2199",
    manualsend: true,
    receivebyte_dataitems: { Flag: { firstbyte: 2 } },
  },
  {
    name: "Write",
    deny_sds: [],
    sentbytes: "2E0100",
    sendbyte_dataitems: { Setting: { firstbyte: 3 } },
  },
  { name: "Wake", deny_sds: [], sentbytes: "1003" },
];

function makeEcu(protocol = "CAN"): LoadedEcu {
  const resolved = resolveDataDictionary(data);
  const requests = new Map<string, BoundRequest>(
    requestDefs.map((def) => [def.name, { def, endianness: "Big" as const, data: resolved }]),
  );
  return {
    slug: "test",
    def: {
      ecuname: "Test",
      obd: { protocol: protocol as "CAN", funcaddr: "26", funcname: "Test" },
      autoidents: [],
      requests: requestDefs,
      data,
      devices: [],
    },
    endianness: "Big",
    data: resolved,
    requests,
  };
}

function widget(kind: "displays" | "inputs", text: string, request: string) {
  return {
    rect,
    color: "rgb(255,255,255)",
    fontcolor: "rgb(0,0,0)",
    font,
    text,
    request,
    width: 50,
  };
}

function screenOf(overrides: Partial<ScreenDef>): ScreenDef {
  return {
    width: 12000,
    height: 8580,
    color: "rgb(128,128,128)",
    displays: [],
    inputs: [],
    labels: [],
    buttons: [],
    presend: [],
    ...overrides,
  };
}

function prepare(screen: ScreenDef) {
  const layout: LayoutFileDef = { screens: { S: screen }, categories: {} };
  const defs = new Map(requestDefs.map((d) => [d.name, d]));
  const prepared = prepareLayout(layout, defs, new Set(Object.keys(data)));
  return prepared.screens.get("S")!;
}

/** Scriptable link: name → response, plus a log of what was asked. */
class ScriptedLink implements EcuLink {
  readonly kind = "simulated" as const;
  readonly sent: string[] = [];
  cacheClears = 0;

  constructor(private readonly responses: Record<string, string | Error> = {}) {}

  request(frame: string, hint?: RequestHint): Promise<string> {
    this.sent.push(hint?.requestName ?? frame);
    const reply = this.responses[hint?.requestName ?? frame];
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply ?? "");
  }

  clearCache(): void {
    this.cacheClears += 1;
  }
}

const noSleep = () => Promise.resolve();

describe("ScreenRuntime planning", () => {
  it("polls each request once however many displays it feeds", () => {
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Rpm", "Poll"), widget("displays", "Flag", "Poll")],
      }),
    );
    const runtime = new ScreenRuntime(makeEcu(), screen, new ScriptedLink(), { sleep: noSleep });

    expect(runtime.plan).toHaveLength(1);
    expect(runtime.plan[0]?.widgets).toHaveLength(2);
  });

  it("never polls a manualsend request", () => {
    const screen = prepare(screenOf({ displays: [widget("displays", "Flag", "Manual")] }));
    const runtime = new ScreenRuntime(makeEcu(), screen, new ScriptedLink(), { sleep: noSleep });

    expect(runtime.plan).toHaveLength(0);
    expect(runtime.manualOnly).toHaveLength(1);
  });

  it("never polls an input on its own account", () => {
    const screen = prepare(screenOf({ inputs: [widget("inputs", "Setting", "Write")] }));
    const runtime = new ScreenRuntime(makeEcu(), screen, new ScriptedLink(), { sleep: noSleep });

    expect(runtime.plan).toHaveLength(0);
  });
});

describe("ScreenRuntime refresh", () => {
  it("decodes each field onto its widget", async () => {
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Rpm", "Poll"), widget("displays", "Flag", "Poll")],
      }),
    );
    const link = new ScriptedLink({ Poll: "61 03 E8 01" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    const snapshot = await runtime.refresh();
    expect(snapshot.values.get("display#0")).toEqual({ value: "1000", status: "ok" });
    // Byte 4 is 0x01, which the enum maps to ON.
    expect(snapshot.values.get("display#1")).toEqual({ value: "ON", status: "ok" });
  });

  it("clears the link cache first, so it doesn't replay the last refresh", async () => {
    const screen = prepare(screenOf({ displays: [widget("displays", "Rpm", "Poll")] }));
    const link = new ScriptedLink({ Poll: "61 03 E8" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    await runtime.refresh();
    await runtime.refresh();
    expect(link.cacheClears).toBe(2);
  });

  it("shows NO DATA for a display whose field falls outside the response", async () => {
    const screen = prepare(screenOf({ displays: [widget("displays", "Flag", "Poll")] }));
    // Only two bytes: Flag lives at byte 4.
    const link = new ScriptedLink({ Poll: "61 03" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    expect((await runtime.refresh()).values.get("display#0")).toEqual({
      value: NO_DATA,
      status: "no-data",
    });
  });

  it("marks every field of a rejected request, with the NRC spelled out", async () => {
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Rpm", "Poll"), widget("displays", "Flag", "Poll")],
      }),
    );
    const link = new ScriptedLink({ Poll: "7F 21 83" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    const snapshot = await runtime.refresh();
    expect(snapshot.values.get("display#0")).toEqual({
      value: null,
      status: "rejected",
      detail: "83 Engine Is Running",
    });
    expect(snapshot.values.get("display#1")?.status).toBe("rejected");
    expect(snapshot.exchanges[0]?.rejected?.code).toBe("83");
  });

  it("surfaces a link failure without throwing", async () => {
    const screen = prepare(screenOf({ displays: [widget("displays", "Rpm", "Poll")] }));
    const link = new ScriptedLink({ Poll: new Error("port closed") });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    const snapshot = await runtime.refresh();
    expect(snapshot.values.get("display#0")).toEqual({
      value: null,
      status: "error",
      detail: "port closed",
    });
  });

  it("fills an input from a display that decoded the same data name", async () => {
    // The input names a different request; matching is purely by data name.
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Flag", "Poll")],
        inputs: [widget("inputs", "Flag", "Write")],
      }),
    );
    const link = new ScriptedLink({ Poll: "61 00 00 01" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    const snapshot = await runtime.refresh();
    expect(snapshot.values.get("input#0")).toEqual({ value: "ON", status: "ok" });
    expect(link.sent).toEqual(["Poll"]);
  });

  it("leaves an unfed input blank rather than NO DATA", async () => {
    // Nothing on this screen reads Setting, so it has no value — but no failure
    // happened either, and showing NO DATA would claim one did.
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Rpm", "Poll")],
        inputs: [widget("inputs", "Setting", "Write")],
      }),
    );
    const link = new ScriptedLink({ Poll: "61 03 E8" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    expect((await runtime.refresh()).values.get("input#0")).toEqual({ value: null, status: "ok" });
  });

  it("sends the session command before anything else when given one", async () => {
    const screen = prepare(screenOf({ displays: [widget("displays", "Rpm", "Poll")] }));
    const link = new ScriptedLink({ Poll: "61 03 E8" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, {
      sleep: noSleep,
      sessionCommand: "10C0",
    });

    await runtime.refresh();
    expect(link.sent).toEqual(["«session»", "Poll"]);
  });
});

describe("ScreenRuntime presend and buttons", () => {
  it("runs presend entries in order, waiting each delay", async () => {
    const screen = prepare(
      screenOf({
        displays: [widget("displays", "Rpm", "Poll")],
        presend: [
          { RequestName: "Wake", Delay: "50" },
          { RequestName: "Poll", Delay: "0" },
        ],
      }),
    );
    const slept: number[] = [];
    const link = new ScriptedLink({ Wake: "50 03", Poll: "61 03 E8" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await runtime.runPresend();
    expect(link.sent).toEqual(["Wake", "Poll"]);
    expect(slept).toEqual([50, 0]);
  });

  it("fires a button's requests in order", async () => {
    const screen = prepare(
      screenOf({
        buttons: [
          {
            rect,
            font,
            text: "Go",
            messages: [""],
            uniquename: "Go_0",
            send: [
              { RequestName: "Wake", Delay: "0" },
              { RequestName: "Manual", Delay: "10" },
            ],
          },
        ],
      }),
    );
    const link = new ScriptedLink({ Wake: "50 03", Manual: "61 01" });
    const runtime = new ScreenRuntime(makeEcu(), screen, link, { sleep: noSleep });

    const exchanges = await runtime.pressButton(screen.buttons[0]!);
    expect(exchanges.map((e) => e.requestName)).toEqual(["Wake", "Manual"]);
    // The frame is the request template, spaced out as the ELM expects.
    expect(exchanges[0]?.sent).toBe("10 03");
  });
});

describe("testerPresentFrame", () => {
  it("is 3E for a CAN ECU with no request of its own", () => {
    expect(testerPresentFrame(makeEcu("CAN"))).toBe("3E");
  });

  it("is null for K-line, which the original never keeps alive this way", () => {
    expect(testerPresentFrame(makeEcu("KWP2000"))).toBeNull();
  });

  it("prefers a request the database names for the purpose", () => {
    const ecu = makeEcu("CAN");
    const resolved = ecu.data;
    (ecu.requests as Map<string, BoundRequest>).set("TesterPresent.Something", {
      def: { name: "TesterPresent.Something", deny_sds: [], sentbytes: "3E00" },
      endianness: "Big",
      data: resolved,
    });
    expect(testerPresentFrame(ecu)).toBe("3E00");
  });
});
