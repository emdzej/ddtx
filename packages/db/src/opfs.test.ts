/**
 * `DirectoryDbSource` against a stub directory tree.
 *
 * The handles are duck-typed precisely so this can run in Node without a browser.
 * What is worth testing here is not "does OPFS work" — it does — but the two things
 * that are easy to get wrong and silent when wrong: caching the directory handle so
 * 1,580 ECU loads don't re-resolve it, and *not* caching a rejection, since a tree
 * can appear after the first failed lookup.
 */

import { describe, expect, it } from "vitest";
import { DirectoryDbSource, MissingTreeError, opfsTreeInstalled } from "./opfs.js";
import type { DirectoryHandleLike, FileHandleLike } from "./opfs.js";

interface Stub extends DirectoryHandleLike {
  dirLookups: number;
}

/** Build a stub handle tree from `{ "ecu/x.json": "contents" }`. */
function stubRoot(files: Record<string, string>): Stub {
  const dirLookup = { count: 0 };

  function makeDir(prefix: string): DirectoryHandleLike {
    return {
      getDirectoryHandle(name: string): Promise<DirectoryHandleLike> {
        dirLookup.count += 1;
        const next = prefix === "" ? name : `${prefix}/${name}`;
        const exists = Object.keys(files).some((p) => p.startsWith(`${next}/`));
        if (!exists) return Promise.reject(new Error("NotFoundError"));
        return Promise.resolve(makeDir(next));
      },
      getFileHandle(name: string): Promise<FileHandleLike> {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        const body = files[path];
        if (body === undefined) return Promise.reject(new Error("NotFoundError"));
        const bytes = new TextEncoder().encode(body);
        return Promise.resolve({
          getFile: () =>
            Promise.resolve({
              size: bytes.byteLength,
              arrayBuffer: () =>
                Promise.resolve(
                  bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                  ) as ArrayBuffer,
                ),
            }),
        });
      },
    };
  }

  const root = makeDir("") as Stub;
  Object.defineProperty(root, "dirLookups", { get: () => dirLookup.count });
  return root;
}

const decoder = new TextDecoder();

describe("DirectoryDbSource", () => {
  it("reads a nested path", async () => {
    const source = new DirectoryDbSource(
      stubRoot({ "ecu/SIRIUS34.json": '{"ecuname":"SIRIUS34"}' }),
    );
    expect(decoder.decode(await source.read("ecu/SIRIUS34.json"))).toBe('{"ecuname":"SIRIUS34"}');
  });

  it("reads a file at the root", async () => {
    const source = new DirectoryDbSource(stubRoot({ "index.json": '{"format":1}' }));
    expect(decoder.decode(await source.read("index.json"))).toBe('{"format":1}');
  });

  it("resolves each directory once, however many files come out of it", async () => {
    const root = stubRoot({
      "ecu/a.json": "1",
      "ecu/b.json": "2",
      "ecu/c.json": "3",
      "layout/a.json": "4",
    });
    const source = new DirectoryDbSource(root);

    await source.read("ecu/a.json");
    await source.read("ecu/b.json");
    await source.read("ecu/c.json");
    await source.read("layout/a.json");

    // Two directories, not four reads' worth. Without the cache this is the kind of
    // overhead that only shows up as "the app feels slow" with a real database.
    expect(root.dirLookups).toBe(2);
  });

  it("reports a missing file as a missing tree, not a raw DOM error", async () => {
    const source = new DirectoryDbSource(stubRoot({ "index.json": "{}" }));
    await expect(source.read("ecu/nope.json")).rejects.toBeInstanceOf(MissingTreeError);
  });

  it("does not cache a failed directory lookup", async () => {
    // A tree can appear after the app has already tried to read from it — the user
    // imports one. A cached rejection would keep failing until reload.
    const files: Record<string, string> = {};
    const source = new DirectoryDbSource(stubRoot(files));

    await expect(source.read("ecu/a.json")).rejects.toBeInstanceOf(MissingTreeError);
    files["ecu/a.json"] = "installed";
    expect(decoder.decode(await source.read("ecu/a.json"))).toBe("installed");
  });
});

describe("opfsTreeInstalled", () => {
  it("is false when the directory exists but the manifest does not", async () => {
    // What a run killed part-way through an import leaves behind.
    const root = stubRoot({ "ddtx/tree/ecu/a.json": "partial" });
    expect(await opfsTreeInstalled({ getDirectory: () => Promise.resolve(root) })).toBe(false);
  });

  it("is false with an index but no manifest — the import got that far and stopped", async () => {
    // The importer writes index.json before manifest.json, so this state is reachable
    // and must not read as installed: the index names ECU files that may be missing.
    const root = stubRoot({ "ddtx/tree/index.json": '{"format":1}' });
    expect(await opfsTreeInstalled({ getDirectory: () => Promise.resolve(root) })).toBe(false);
  });

  it("is true once the manifest is there", async () => {
    const root = stubRoot({
      "ddtx/tree/index.json": '{"format":1}',
      "ddtx/tree/manifest.json": '{"format":1}',
    });
    expect(await opfsTreeInstalled({ getDirectory: () => Promise.resolve(root) })).toBe(true);
  });
});
