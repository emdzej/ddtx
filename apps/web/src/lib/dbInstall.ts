/**
 * Choosing and installing the database, from the main thread.
 *
 * Three ways in, one `DbSource` out:
 *
 *  - **OPFS** — the user picked `ecu.zip` once and it was unpacked. Default, because
 *    it needs no permission grant on any later visit.
 *  - **A folder** — an already-unpacked tree on disk. Costs a permission re-grant
 *    every reload, so it is offered rather than preferred.
 *  - **A URL** — a static host, or the dev-server middleware. What CI and development
 *    use.
 *
 * See docs/database-install.md.
 */

import { inspectTree, type StructureFinding, type TreeReport } from "@ddtx/dbimport";
import {
  DirectoryDbSource,
  HttpDbSource,
  openOpfsTree,
  opfsTreeInstalled,
  type DbSource,
  type DirectoryHandleLike,
} from "@ddtx/db";
import ImportWorker from "./dbImport.worker.ts?worker";
import type { ImportMessage, ImportRequest, TreeManifest } from "./dbImport.worker.js";
import {
  loadFolderHandle,
  queryFolderPermission,
  requestFolderPermission,
  saveFolderHandle,
  savedRemoteUrl,
  savedSourceKind,
  saveSourceKind,
  type DbSourceKind,
} from "./installStorage.js";

/**
 * Where the dev-server middleware serves the tree from.
 *
 * Base-relative so it still points at the right place when the app is hosted under a
 * subpath, which is what GitHub Pages does.
 */
export const DEV_DB_URL =
  (import.meta.env.VITE_DB_URL as string | undefined) ?? `${import.meta.env.BASE_URL}db`;

export interface ResolvedSource {
  kind: DbSourceKind;
  source: DbSource;
  /** Human-readable, for the status strip. */
  label: string;
}

/** Does this browser have OPFS at all? Without it, only the folder and URL work. */
export function opfsSupported(): boolean {
  return typeof navigator !== "undefined" && navigator.storage?.getDirectory !== undefined;
}

export async function treeInstalled(): Promise<boolean> {
  if (!opfsSupported()) return false;
  return opfsTreeInstalled(navigator.storage);
}

/**
 * Open whichever source the user last chose, or nothing if they never chose.
 *
 * Returns `null` rather than throwing so the caller can show the picker. The one case
 * that deliberately does *not* return null is a remembered folder whose permission has
 * lapsed: that needs a click, so it surfaces as `needsPermission`.
 */
export async function resolveSavedSource(): Promise<
  { ok: ResolvedSource } | { needsPermission: FileSystemDirectoryHandle } | null
> {
  const kind = savedSourceKind();

  if (kind === "remote") {
    const url = savedRemoteUrl();
    if (url !== null && url.length > 0) {
      return { ok: { kind: "remote", source: new HttpDbSource(url), label: url } };
    }
  }

  if (kind === "folder") {
    const handle = await loadFolderHandle();
    if (handle !== null) {
      const state = await queryFolderPermission(handle);
      if (state === "granted") return { ok: folderSource(handle) };
      if (state === "prompt") return { needsPermission: handle };
      // "denied" — the handle is spent; fall through and let the picker take over.
    }
  }

  if (kind === "opfs" || kind === null) {
    if (await treeInstalled()) {
      return {
        ok: {
          kind: "opfs",
          source: await openOpfsTree(navigator.storage),
          label: "installed database",
        },
      };
    }
  }

  return null;
}

function folderSource(handle: FileSystemDirectoryHandle): ResolvedSource {
  return {
    kind: "folder",
    source: new DirectoryDbSource(handle as unknown as DirectoryHandleLike),
    label: handle.name,
  };
}

/** Re-grant a lapsed folder permission. Must be called from a click. */
export async function grantFolder(
  handle: FileSystemDirectoryHandle,
): Promise<ResolvedSource | null> {
  const state = await requestFolderPermission(handle);
  if (state !== "granted") return null;
  saveSourceKind("folder");
  return folderSource(handle);
}

/**
 * Check a source really holds a split tree.
 *
 * Run before adopting a folder and available on demand from settings. Samples the index
 * plus a dozen ECUs rather than all 1,580: a folder picker hands back whatever was
 * clicked, and "Downloads" should be refused in a moment with a reason rather than by
 * failing on the first ECU opened half an hour later.
 */
export function verifySource(source: DbSource): Promise<TreeReport> {
  return inspectTree((path) => source.read(path));
}

/** Ask for a folder holding an already-split tree. Must be called from a click. */
export async function pickFolder(): Promise<ResolvedSource | null> {
  const picker = (
    globalThis as {
      showDirectoryPicker?: (options?: {
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (picker === undefined) return null;

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ mode: "read" });
  } catch {
    return null; // The user cancelled.
  }

  // Verified before it is remembered, so a wrong folder never becomes the saved source.
  const candidate = folderSource(handle);
  const report = await verifySource(candidate.source);
  if (!report.ok) throw new ArchiveRejected(report.findings);

  await saveFolderHandle(handle);
  saveSourceKind("folder");
  return candidate;
}

export function useRemote(url: string): ResolvedSource {
  saveSourceKind("remote");
  return { kind: "remote", source: new HttpDbSource(url), label: url };
}

/* ── importing ecu.zip ─────────────────────────────────────────────────────── */

export interface ImportProgress {
  /**
   * What is actually happening.
   *
   * Split out because hashing 100 MB takes a second or two, and labelling that
   * "unpacking" is a lie the user can see through when the same archive is then
   * skipped instantly. It also makes "was the split skipped?" observable.
   */
  phase: "hashing" | "unpacking";
  done: number;
  total: number;
  bytesOut: number;
}

export interface ImportOutcome {
  manifest: TreeManifest;
  elapsedMs: number;
  /** Survivable structural complaints, if any. */
  warnings?: StructureFinding[];
}

/** Thrown when an archive is not a usable database. Nothing was written. */
export class ArchiveRejected extends Error {
  constructor(public readonly findings: StructureFinding[]) {
    super(findings.map((f) => f.message).join(" "));
    this.name = "ArchiveRejected";
  }
}

/** SHA-256 of the archive, so a re-import of the same snapshot can be recognised. */
async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The manifest of the installed tree, or null if nothing is installed. */
export async function installedManifest(): Promise<TreeManifest | null> {
  try {
    const source = await openOpfsTree(navigator.storage);
    const raw = await source.read("manifest.json");
    return JSON.parse(new TextDecoder().decode(raw)) as TreeManifest;
  } catch {
    return null;
  }
}

/** The SHA-256 of the archive that produced the installed tree, if there is one. */
export async function installedSourceHash(): Promise<string | null> {
  return (await installedManifest())?.source?.sha256 ?? null;
}

/**
 * Unpack `ecu.zip` into OPFS.
 *
 * The archive's bytes are transferred to the Worker rather than copied — at ~100 MB a
 * structured clone would double the peak.
 *
 * Skips the work when the same archive is already installed, which is the same
 * SHA-256 check the CLI's `--if-needed` does and for the same reason: it rewrites
 * 1.19 GB and takes about fifteen seconds.
 */
export async function importArchive(
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options: { force?: boolean } = {},
): Promise<ImportOutcome> {
  onProgress?.({ phase: "hashing", done: 0, total: 0, bytesOut: 0 });
  const bytes = await file.arrayBuffer();
  const sha256 = await digest(bytes);

  const already = await installedManifest();
  if (options.force !== true && already?.source?.sha256 === sha256) {
    // The same snapshot is already unpacked. Re-running would rewrite 1.19 GB to
    // arrive at exactly the same tree — the CLI's `--if-needed` check, client-side.
    saveSourceKind("opfs");
    return { manifest: already, elapsedMs: 0 };
  }

  const worker = new ImportWorker();
  try {
    const outcome = await new Promise<ImportOutcome>((resolve, reject) => {
      let warnings: StructureFinding[] = [];
      worker.onmessage = (event: MessageEvent<ImportMessage>) => {
        const message = event.data;
        if (message.kind === "rejected") {
          // Refused before anything was written, so whatever was installed is intact.
          reject(new ArchiveRejected(message.findings));
        } else if (message.kind === "warnings") {
          warnings = message.findings;
        } else if (message.kind === "progress") {
          onProgress?.({
            phase: "unpacking",
            done: message.done,
            total: message.total,
            bytesOut: message.bytesOut,
          });
        } else if (message.kind === "done") {
          resolve({
            manifest: message.manifest,
            elapsedMs: message.elapsedMs,
            ...(warnings.length === 0 ? {} : { warnings }),
          });
        } else if (message.kind === "error") {
          reject(new Error(message.message));
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || "import worker failed"));

      const request: ImportRequest = { zip: bytes, name: file.name, sha256 };
      worker.postMessage(request, [bytes]);
    });
    saveSourceKind("opfs");
    return outcome;
  } finally {
    worker.terminate();
  }
}

/** Throw the installed tree away. Used by the settings dialog before a re-import. */
export async function removeInstalledTree(): Promise<void> {
  if (!opfsSupported()) return;
  const root = await navigator.storage.getDirectory();
  const ddtx = await root.getDirectoryHandle("ddtx", { create: true });
  for (const name of ["tree", "tree.incoming"]) {
    try {
      await ddtx.removeEntry(name, { recursive: true });
    } catch {
      // Already gone.
    }
  }
}

/** Bytes OPFS is using, for the settings dialog. Approximate — the browser's own figure. */
export async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}
