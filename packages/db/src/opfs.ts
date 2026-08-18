/**
 * `DbSource` over the origin private file system, plus the folder-picker variant.
 *
 * OPFS is the default place an installed tree lives, for one reason that matters more
 * than any performance argument: it needs no permission grant. A tree the user
 * imported once is readable on every later visit with no prompt, whereas a
 * `FileSystemDirectoryHandle` from a folder picker loses its permission on reload and
 * has to be re-granted inside a user gesture. See docs/database-install.md §4.
 *
 * Reads here are async and use ordinary handles. Nothing on the read path needs the
 * Worker-only synchronous access handles — and nor, in the end, does the import.
 */

import type { DbSource } from "./source.js";

/**
 * The bits of `FileSystemDirectoryHandle` used here.
 *
 * Duck-typed rather than relying on the DOM lib types, so this package builds without
 * `"dom"` in `lib` and can be exercised from Node tests with a stub.
 */
export interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number }>;
}

/** Where a tree lives inside OPFS. Kept in one place so the worker agrees. */
export const OPFS_TREE_DIR = "tree";

export class MissingTreeError extends Error {
  constructor(public readonly path: string) {
    super(`No database tree installed (looking for ${path})`);
    this.name = "MissingTreeError";
  }
}

/**
 * Reads a split tree out of a directory handle.
 *
 * Serves both OPFS and a picked folder: the two differ in how the handle is obtained
 * and in whether permission has to be re-granted, not in how a file is read.
 */
export class DirectoryDbSource implements DbSource {
  /**
   * Subdirectory handles, cached.
   *
   * Every read is `ecu/<slug>.json` or `layout/<slug>.json`, so without this the
   * app re-resolves the same two directory handles on every single ECU load.
   */
  private readonly dirs = new Map<string, Promise<DirectoryHandleLike>>();

  constructor(private readonly root: DirectoryHandleLike) {}

  async read(path: string): Promise<Uint8Array> {
    const segments = path.split("/").filter((s) => s.length > 0);
    const name = segments.pop();
    if (name === undefined) throw new Error(`DbSource: empty path`);

    let dir = this.root;
    if (segments.length > 0) {
      const key = segments.join("/");
      let pending = this.dirs.get(key);
      if (pending === undefined) {
        pending = this.resolveDir(segments);
        this.dirs.set(key, pending);
      }
      try {
        dir = await pending;
      } catch {
        // Don't cache a rejection: a later import can create the directory, and a
        // poisoned entry would keep failing long after the tree exists.
        this.dirs.delete(key);
        throw new MissingTreeError(path);
      }
    }

    let handle: FileHandleLike;
    try {
      handle = await dir.getFileHandle(name);
    } catch {
      throw new MissingTreeError(path);
    }
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  private async resolveDir(segments: readonly string[]): Promise<DirectoryHandleLike> {
    let dir = this.root;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    return dir;
  }
}

/** Navigator surface used to reach OPFS, duck-typed for the same reason as above. */
export interface StorageManagerLike {
  getDirectory(): Promise<DirectoryHandleLike>;
}

/**
 * Open the installed OPFS tree.
 *
 * `create: false` on the tree directory is deliberate — this must fail rather than
 * silently produce an empty tree, so the app can offer the import flow instead of
 * reporting a broken database.
 */
export async function openOpfsTree(storage: StorageManagerLike): Promise<DirectoryDbSource> {
  const root = await storage.getDirectory();
  const ddtx = await root.getDirectoryHandle("ddtx", { create: true });
  const tree = await ddtx.getDirectoryHandle(OPFS_TREE_DIR);
  return new DirectoryDbSource(tree);
}

/**
 * Is a usable tree installed in OPFS?
 *
 * Tests for `manifest.json` specifically, because the importer writes it **last** and
 * that makes it the completion marker. `index.json` would not do: it is written before
 * the manifest, so a run killed between the two would look installed while naming ECU
 * files that were never written. There is no staging directory to check instead —
 * Chromium cannot rename a directory, only a file.
 */
export async function opfsTreeInstalled(storage: StorageManagerLike): Promise<boolean> {
  try {
    const source = await openOpfsTree(storage);
    await source.read("manifest.json");
    return true;
  } catch {
    return false;
  }
}
