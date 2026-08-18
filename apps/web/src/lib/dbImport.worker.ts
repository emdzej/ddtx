/**
 * Unpacks `ecu.zip` into OPFS, off the main thread.
 *
 * A Worker for the ordinary reason: the import writes 1.19 GB across 3,749 files and
 * takes upwards of fifteen seconds, and none of that should freeze the UI.
 *
 * The interesting constraint is elsewhere. `@ddtx/dbimport`'s splitter hands each
 * entry to `sink.write` from inside fflate's callback, where nothing can be awaited —
 * and every OPFS write is async, including acquiring the file handle. So `write`
 * queues and `flush` drains, and the splitter awaits `flush` between archive slices,
 * where the stack is empty. The queue only ever holds the entries that finished inside
 * one 256 KB slice. See docs/database-install.md §2.
 *
 * (An earlier attempt used `createSyncAccessHandle` to write synchronously inside the
 * callback. That does not work: the handle is obtained asynchronously, so the await
 * problem simply moves. Sync access handles are not needed here at all, which is also
 * why this runs on any browser with OPFS rather than Chromium only.)
 */

import { splitArchive, type SplitSink } from "@ddtx/dbimport";
import { OPFS_TREE_DIR } from "@ddtx/db";

export interface ImportRequest {
  /** The archive. Transferred, not copied — it is ~100 MB. */
  zip: ArrayBuffer;
  name: string;
  /** SHA-256 of the archive, computed on the main thread where the File already is. */
  sha256: string;
}

export type ImportMessage =
  | { kind: "progress"; done: number; total: number; bytesOut: number }
  | { kind: "log"; message: string }
  | { kind: "done"; manifest: TreeManifest; elapsedMs: number }
  | { kind: "error"; message: string };

export interface TreeManifest {
  format: 1;
  source: { name: string; bytes: number; sha256: string };
  counts: { ecus: number; layouts: number; indexed: number; graphicsSkipped: number };
  bytes: Record<string, number>;
  /** Nothing is pre-compressed in OPFS — reads are local, so it would only cost time. */
  encodings: string[];
}

/**
 * Entries in the shipped archive, used only to make the progress bar honest.
 *
 * A zip's entry count lives in its central directory at the *end*, and the splitter
 * streams from the front. Rather than pre-scan 100 MB to learn a number only a
 * progress bar wants, this is the known count and the bar clamps if a future snapshot
 * differs.
 */
const EXPECTED_ENTRIES = 3749;

/**
 * `manifest.json` is the completion marker.
 *
 * There is no staging directory, because Chromium implements `FileSystemHandle.move`
 * on *file* handles only — a directory cannot be renamed, so "build beside it and swap"
 * is not available. Instead the old tree is removed, the new one is written in place,
 * and the manifest is written **last**. A failed import therefore leaves a tree with no
 * manifest, which `opfsTreeInstalled` reports as "not installed" — so the app offers
 * the picker rather than loading an index whose ECU files were never written.
 *
 * The cost of not staging is that a failed re-import loses the tree that was there
 * before. That is the honest failure: no database, and a picker. A half-replaced tree
 * that still looked installed would be worse.
 */
const MANIFEST = "manifest.json";

self.onmessage = (event: MessageEvent<ImportRequest>) => {
  void run(event.data);
};

async function run(request: ImportRequest): Promise<void> {
  const post = (message: ImportMessage): void => self.postMessage(message);
  try {
    const started = performance.now();
    const bytes = new Uint8Array(request.zip);

    const root = await navigator.storage.getDirectory();
    const ddtx = await root.getDirectoryHandle("ddtx", { create: true });

    // Clear first, so a failure cannot leave an old tree mixed with a new one.
    await removeIfPresent(ddtx, OPFS_TREE_DIR);
    const tree = await ddtx.getDirectoryHandle(OPFS_TREE_DIR, { create: true });

    const sink = createOpfsSink(tree, (done, bytesOut) =>
      post({ kind: "progress", done, total: EXPECTED_ENTRIES, bytesOut }),
    );

    const result = await splitArchive(bytes, sink);

    const manifest: TreeManifest = {
      format: 1,
      source: { name: request.name, bytes: bytes.byteLength, sha256: request.sha256 },
      counts: {
        ecus: result.counts.ecus,
        layouts: result.counts.layouts,
        indexed: result.counts.indexed,
        graphicsSkipped: result.counts.graphicsSkipped,
      },
      bytes: result.bytesOut,
      encodings: [],
    };
    // Last, and only after every entry is on disk: this is what marks the tree usable.
    sink.write(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 1)));
    await sink.flush();

    post({ kind: "done", manifest, elapsedMs: performance.now() - started });
  } catch (cause) {
    post({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
  }
}

interface QueueingSink extends SplitSink {
  flush(): Promise<void>;
}

/**
 * A `SplitSink` that queues synchronously and writes to OPFS on flush.
 *
 * Directories are created on `mkdir`, which the splitter awaits before any entry is
 * emitted — so by the time `write` runs, the handle it needs is already resolved and
 * the synchronous contract holds.
 */
function createOpfsSink(
  root: FileSystemDirectoryHandle,
  onProgress: (done: number, bytesOut: number) => void,
): QueueingSink {
  const dirs = new Map<string, FileSystemDirectoryHandle>([["", root]]);
  let queue: Array<[string, Uint8Array]> = [];
  let lastPosted = 0;

  return {
    async mkdir(path) {
      dirs.set(path, await root.getDirectoryHandle(path, { create: true }));
    },

    write(path: string, bytes: Uint8Array) {
      queue.push([path, bytes]);
    },

    async flush() {
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      for (const [path, bytes] of batch) {
        const slash = path.lastIndexOf("/");
        const dirName = slash < 0 ? "" : path.slice(0, slash);
        const fileName = slash < 0 ? path : path.slice(slash + 1);
        const dir = dirs.get(dirName);
        if (dir === undefined) {
          throw new Error(`import: directory "${dirName}" was never created`);
        }
        const handle = await dir.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        // Copied into a plain ArrayBuffer-backed view: the DOM types reject a
        // Uint8Array whose buffer could be a SharedArrayBuffer, and fflate's output
        // is typed loosely enough to trip that.
        await writable.write(bytes.slice() as unknown as ArrayBufferView<ArrayBuffer>);
        await writable.close();
      }
    },

    progress(done: number, bytesOut: number) {
      // 3,749 postMessage calls would cost more than the writes do. One per 25
      // entries is smooth at any bar width.
      if (done - lastPosted >= 25 || done === EXPECTED_ENTRIES) {
        lastPosted = done;
        onProgress(done, bytesOut);
      }
    },
  };
}

async function removeIfPresent(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // Absent, which is the normal case on a first import.
  }
}
