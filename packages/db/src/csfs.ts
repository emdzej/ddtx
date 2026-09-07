/**
 * A `DbSource` over any csfs file system.
 *
 * The three tree-shaped backends — a folder the user picked, the origin private file
 * system, a static host — are now csfs's problem rather than ours. What was three
 * hand-rolled implementations (a `fetch` wrapper, an OPFS directory walk, and an FSA
 * walk with its own permission handling) is this adapter plus a constructor call each.
 *
 * The hand-rolled versions existed for a licensing reason that has expired: the
 * comparable abstraction in `@emdzej/bimmerz-vfs` is PolyForm Noncommercial and this
 * project is GPL-3.0-or-later, so it could not be a dependency. csfs is MIT.
 */

import type { CsFileSystem } from "@emdzej/csfs-core";
import type { DbSource } from "./source.js";

/**
 * Adapt a csfs file system to the database's read contract.
 *
 * The one difference worth naming: csfs returns `null` for an absent path, because
 * testing existence should not need a `try`. `DbSource` rejects instead, since every
 * path its callers ask for came out of the index and a miss is a corrupt tree rather
 * than a normal answer.
 */
export function csfsDbSource(fs: CsFileSystem): DbSource {
  return {
    async read(path: string): Promise<Uint8Array> {
      const bytes = await fs.read(path.replace(/^\/+/, ""));
      if (bytes === null) throw new Error(`DbSource: no such path ${path} (${fs.kind})`);
      return bytes;
    },
  };
}
