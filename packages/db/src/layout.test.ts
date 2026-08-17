import { describe, expect, it } from "vitest";
import type { LayoutFileDef, RequestDef, ScreenDef } from "@ddtx/core";
import { prepareLayout, requestsForScreen } from "./layout.js";

const font = { name: "Arial", size: 9, bold: "0", italic: "0" };
const rect = { left: 0, top: 0, width: 100, height: 100 };

function display(text: string, request: string): ScreenDef["displays"][number] {
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

function screen(overrides: Partial<ScreenDef> = {}): ScreenDef {
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

function layoutOf(screens: Record<string, ScreenDef>, categories: Record<string, string[]> = {}) {
  return { screens, categories } satisfies LayoutFileDef;
}

/**
 * Displays may only read fields their request returns, so the fixture requests
 * must declare them — see the `display-not-in-response` rule.
 */
const requests = new Map<string, RequestDef>([
  [
    "Trame 10",
    {
      name: "Trame 10",
      deny_sds: [],
      sentbytes: "2110",
      receivebyte_dataitems: {
        "Régime moteur": { firstbyte: 2 },
        "Température eau": { firstbyte: 4 },
      },
    },
  ],
  ["Reset", { name: "Reset", deny_sds: [], sentbytes: "1400" }],
]);
const data = new Set(["Régime moteur", "Température eau"]);

describe("prepareLayout", () => {
  it("binds a widget whose request and data both exist", () => {
    const prepared = prepareLayout(
      layoutOf({ S: screen({ displays: [display("Régime moteur", "Trame 10")] }) }),
      requests,
      data,
    );

    const widgets = prepared.screens.get("S")?.widgets ?? [];
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.dataName).toBe("Régime moteur");
    expect(widgets[0]?.kind).toBe("display");
    expect(prepared.warnings).toEqual([]);
  });

  it("treats an empty caption as a decoration, not a broken reference", () => {
    // 1,421 widgets in the real database look like this. Dropping them would
    // blank out a large share of screens.
    const prepared = prepareLayout(
      layoutOf({ S: screen({ displays: [display("", "Trame 10")] }) }),
      requests,
      data,
    );

    const widgets = prepared.screens.get("S")?.widgets ?? [];
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.dataName).toBeNull();
    expect(prepared.warnings).toEqual([]);
  });

  it("drops a widget naming absent data, and says so", () => {
    const prepared = prepareLayout(
      layoutOf({ S: screen({ displays: [display("Nonexistent", "Trame 10")] }) }),
      requests,
      data,
    );

    expect(prepared.screens.get("S")?.widgets).toEqual([]);
    expect(prepared.warnings).toEqual([
      { kind: "widget-missing-data", screen: "S", detail: "Nonexistent" },
    ]);
  });

  it("drops a widget naming an absent request", () => {
    const prepared = prepareLayout(
      layoutOf({ S: screen({ displays: [display("Régime moteur", "Ghost")] }) }),
      requests,
      data,
    );

    expect(prepared.screens.get("S")?.widgets).toEqual([]);
    expect(prepared.warnings[0]?.kind).toBe("widget-missing-request");
  });

  it("keeps a button with no send array as a no-op", () => {
    const prepared = prepareLayout(
      layoutOf({
        S: screen({
          buttons: [{ rect, font, text: "Go", messages: [""], uniquename: "Go_0" }],
        }),
      }),
      requests,
      data,
    );

    const buttons = prepared.screens.get("S")?.buttons ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.send).toEqual([]);
    expect(prepared.warnings).toEqual([]);
  });

  it("filters unresolvable entries out of send and presend", () => {
    const prepared = prepareLayout(
      layoutOf({
        S: screen({
          buttons: [
            {
              rect,
              font,
              text: "Go",
              messages: [],
              uniquename: "Go_0",
              send: [
                { RequestName: "Reset", Delay: "0" },
                { RequestName: "Ghost", Delay: "0" },
              ],
            },
          ],
          presend: [
            { RequestName: "Trame 10", Delay: "0" },
            { RequestName: "Ghost", Delay: "0" },
          ],
        }),
      }),
      requests,
      data,
    );

    const screenOut = prepared.screens.get("S");
    expect(screenOut?.buttons[0]?.send).toEqual([{ RequestName: "Reset", Delay: "0" }]);
    expect(screenOut?.presend).toEqual([{ RequestName: "Trame 10", Delay: "0" }]);
    expect(prepared.warnings.map((w) => w.kind)).toEqual([
      "button-send-missing-request",
      "presend-missing-request",
    ]);
  });

  it("prunes missing screens from a category, and drops a category left empty", () => {
    const prepared = prepareLayout(
      layoutOf({ Real: screen() }, { Mixed: ["Real", "Ghost"], AllGone: ["Ghost"] }),
      requests,
      data,
    );

    expect(prepared.categories).toEqual([{ name: "Mixed", screens: ["Real"] }]);
    expect(prepared.warnings.filter((w) => w.kind === "category-missing-screen")).toHaveLength(2);
  });
});

describe("requestsForScreen", () => {
  it("groups widgets by request so each is fetched once", () => {
    const prepared = prepareLayout(
      layoutOf({
        S: screen({
          displays: [
            display("Régime moteur", "Trame 10"),
            display("Température eau", "Trame 10"),
            display("", "Reset"),
          ],
        }),
      }),
      requests,
      data,
    );

    const grouped = requestsForScreen(prepared.screens.get("S")!);
    expect([...grouped.keys()]).toEqual(["Trame 10"]);
    expect(grouped.get("Trame 10" as never)).toHaveLength(2);
    // The decoration contributes no request: there is nothing to read for it.
    expect(grouped.size).toBe(1);
  });
});
