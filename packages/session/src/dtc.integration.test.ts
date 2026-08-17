/**
 * Reads faults from every ECU in the real database through the simulated link.
 *
 * The unit tests use a hand-built ECU, which proves the decoder but says nothing
 * about whether real definitions actually drive it. This runs the whole corpus and
 * pins the aggregate numbers, so a change that starts silently returning no records
 * — the failure mode this module has already had twice — moves a total and fails.
 *
 * Opt-in, because it needs a built tree:
 *
 *   pnpm db:split
 *   DDTX_DB_TREE=data/tree pnpm test
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EcuDatabase, type DbSource } from "@ddtx/db";
import { readDtcs, supportsDtcRead } from "./dtc.js";
import { simulatedDtcLink } from "./simulate.js";

const treeDir = process.env.DDTX_DB_TREE;
const available = treeDir !== undefined && existsSync(join(treeDir, "index.json"));

class FileDbSource implements DbSource {
  constructor(private readonly root: string) {}
  read(path: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(readFileSync(join(this.root, path))));
  }
}

describe.skipIf(!available)("fault reading across the real database", () => {
  it("decodes records for every ECU that describes a fault request", async () => {
    const db = await EcuDatabase.open(new FileDbSource(treeDir as string));

    let supported = 0;
    let withRecords = 0;
    let emptyDespiteSupport = 0;
    const fieldNames = new Set<string>();
    const strides = new Map<number, number>();

    for (const summary of db.list()) {
      const ecu = await db.loadEcu(summary.slug);
      if (!supportsDtcRead(ecu)) continue;
      supported += 1;

      const result = await readDtcs(simulatedDtcLink(ecu), ecu);
      if (result.records.length > 0) {
        withRecords += 1;
        for (const field of result.records[0]?.fields ?? []) fieldNames.add(field.name);
      } else {
        emptyDespiteSupport += 1;
        console.log(
          `empty: ${summary.slug} req=${result.requestName} outcome=${result.outcome} ` +
            `declared=${result.declared} raw=${result.raw}`,
        );
      }

      const request = ecu.requests.get(result.requestName ?? "");
      const stride = request?.def.shiftbytescount ?? 0;
      strides.set(stride, (strides.get(stride) ?? 0) + 1);
    }

    console.log(
      `supported ${supported} · decoded ${withRecords} · empty ${emptyDespiteSupport} · ` +
        `distinct record fields ${fieldNames.size} · strides ${JSON.stringify([...strides])}`,
    );

    // 1,392 of the 1,580 ECUs describe a readable fault request — measured, not
    // estimated. The three C1ARun2 radars that name the request with no fields are
    // excluded by `supportsDtcRead`, which is why this is 1,392 and not 1,395.
    expect(supported).toBe(1392);
    // Every record field the database uses across the whole corpus. A change that
    // starts dropping fields shows up here before anyone notices a blank row.
    expect(fieldNames.size).toBe(115);
    // Record stride, in bytes. 4 dominates; 5 ECUs define none and get one record.
    expect(Object.fromEntries(strides)).toEqual({ 0: 5, 2: 2, 3: 333, 4: 1049, 5: 2, 6: 1 });
    // The simulated reply always declares three records and carries the bytes for
    // them, so every supported ECU must decode at least one. Any that cannot is a
    // decoder gap, not a database quirk.
    expect(emptyDespiteSupport).toBe(0);
    expect(withRecords).toBe(supported);
  }, 600_000);
});
