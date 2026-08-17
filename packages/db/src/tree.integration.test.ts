/**
 * Runs the loader over the **entire** real database — all 1,580 ECUs, 1.19 GB of
 * JSON — and pins the aggregate integrity numbers.
 *
 * These counts were measured independently (once in Python against `ecu.zip`,
 * once by `tools/db-split`'s own validator, and now here through the loader), and
 * all three agree. That makes them a genuine regression fence: if a change to
 * `prepareLayout` starts dropping widgets it used to keep, or keeping ones it
 * used to drop, the totals move and this fails.
 *
 * Opt-in, because it needs a built tree and takes a while:
 *
 *   node tools/db-split/dist/index.js data/ecu.zip /tmp/ddtx-tree
 *   DDTX_DB_TREE=/tmp/ddtx-tree pnpm test
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EcuDatabase } from "./database.js";
import type { DbSource } from "./source.js";

const treeDir = process.env.DDTX_DB_TREE;
const available = treeDir !== undefined && existsSync(join(treeDir, "index.json"));

class FileDbSource implements DbSource {
  constructor(private readonly root: string) {}
  read(path: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(readFileSync(join(this.root, path))));
  }
}

describe.skipIf(!available)("the real database tree", () => {
  it("loads every ECU and screen, with integrity totals unchanged", async () => {
    const db = await EcuDatabase.open(new FileDbSource(treeDir as string));

    expect(db.size).toBe(1580);
    expect(db.groups).toHaveLength(171);
    expect(db.projects).toHaveLength(140);

    const byProtocol = new Map<string, number>();
    for (const summary of db.list()) {
      byProtocol.set(summary.protocol, (byProtocol.get(summary.protocol) ?? 0) + 1);
    }
    expect(Object.fromEntries(byProtocol)).toEqual({
      CAN: 1363,
      KWP2000: 195,
      ISO8: 21,
      "": 1,
    });

    const warnings = new Map<string, number>();
    let screens = 0;
    let widgets = 0;
    let decorations = 0;
    let buttons = 0;
    let buttonsWithoutSend = 0;
    let categories = 0;

    for (const summary of db.list()) {
      const layout = await db.loadLayout(summary.slug);

      categories += layout.categories.length;
      for (const screen of layout.screens.values()) {
        screens += 1;
        widgets += screen.widgets.length;
        for (const widget of screen.widgets) if (widget.dataName === null) decorations += 1;
        buttons += screen.buttons.length;
        for (const button of screen.buttons) if (button.send.length === 0) buttonsWithoutSend += 1;
      }
      for (const warning of layout.warnings) {
        warnings.set(warning.kind, (warnings.get(warning.kind) ?? 0) + 1);
      }

      // 1.19 GB won't fit in memory all at once.
      db.clearCache();
    }

    expect(screens).toBe(39665);
    // 10,067 categories exist; 55 list no screens at all and are dropped as
    // dead menu nodes. That is not a dangling reference — every category member
    // in the database does resolve — so it produces no warning below.
    expect(categories).toBe(10012);

    // Bindings kept: 1,021,519 widgets, less the 24 naming absent data and the
    // 6 displays reading a field their request doesn't return.
    expect(widgets).toBe(1021489);
    // Empty-caption decorations — the case that must not be treated as an error.
    expect(decorations).toBe(1421);

    expect(buttons).toBe(104276);
    // 1,367 carry no `send` key at all, and 15 more have every entry dangle.
    // (The 70 dangling send entries below are spread over more buttons than
    // that, but only these 15 lose all of theirs and go inert.)
    expect(buttonsWithoutSend).toBe(1382);

    expect(Object.fromEntries(warnings)).toEqual({
      "widget-missing-data": 24,
      "display-not-in-response": 6,
      "button-send-missing-request": 70,
      "presend-missing-request": 1,
    });
  }, 600_000);
});
