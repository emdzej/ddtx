/**
 * Choosing where the database is read from.
 *
 * Three ways in, one `DbSource` out:
 *
 *  - **The archive** — `ecu.zip`, copied once into the origin private file system and
 *    read *in place* thereafter. The default, because it needs no permission grant on
 *    any later visit and because there is nothing to unpack.
 *  - **A folder** — an already-split tree on disk. Costs a permission re-grant every
 *    reload, so it is offered rather than preferred.
 *  - **A URL** — a static host, or the dev-server middleware. What development uses.
 *
 * Every one of them is a csfs backend now. This file used to be 313 lines plus a
 * 208-line worker plus 190 lines of handle plumbing, most of which existed to unpack
 * 3,749 entries into OPFS and to survive being interrupted while doing it. Reading the
 * archive where it lies deletes the whole problem: no progress, no per-entry write
 * queue, no completion marker, no partial state to detect.
 *
 * See docs/database-install.md.
 */

import { archiveDbSource, csfsDbSource, type ArchiveFacts, type DbSource } from "@ddtx/db";
import { BlobFile, type CsFile } from "@emdzej/csfs-core";
import { FsaFileSystem, isFsaSupported, pickDirectory, queryAccess, requestAccess } from "@emdzej/csfs-fsa";
import { httpFileSystem } from "@emdzej/csfs-http";
import { isOpfsSupported, opfsFileSystem, persist, quota } from "@emdzej/csfs-opfs";
import {
  clearStored,
  loadFolderHandle,
  saveFolderHandle,
  savedRemoteUrl,
  savedSourceKind,
  saveSourceKind,
  type DbSourceKind,
} from "./installStorage.js";
import { ui } from "./ui.svelte.js";

/**
 * Where the dev-server middleware serves the tree from.
 *
 * Base-relative so it still points at the right place when the app is hosted under a
 * subpath, which is what GitHub Pages does.
 */
export const DEV_DB_URL =
  (import.meta.env.VITE_DB_URL as string | undefined) ?? `${import.meta.env.BASE_URL}db`;

/**
 * OPFS is shared by everything on the origin, so root under a name of our own rather
 * than at `/` — where another app on the same origin could list and delete it.
 */
const NAMESPACE = "ddtx";

/** The archive's name inside the namespace. One file, so no layout to get wrong. */
const ARCHIVE = "ecu.zip";

export interface ResolvedSource {
  kind: DbSourceKind;
  source: DbSource;
  /** Human-readable, for the status strip. */
  label: string;
  /** Present for the archive: what it turned out to contain. */
  facts?: ArchiveFacts;
}

export function opfsSupported(): boolean {
  return isOpfsSupported();
}

export function folderPickerSupported(): boolean {
  return isFsaSupported();
}

/** Is an archive already stored? */
export async function archiveStored(): Promise<boolean> {
  if (!isOpfsSupported()) return false;
  try {
    const fs = await opfsFileSystem({ namespace: NAMESPACE });
    return (await fs.file(ARCHIVE)) !== null;
  } catch {
    return false;
  }
}

/** Bytes the stored archive occupies, and what the browser will allow. */
export async function storageUsed(): Promise<{ archive: number; usage?: number; quota?: number }> {
  if (!isOpfsSupported()) return { archive: 0 };
  const fs = await opfsFileSystem({ namespace: NAMESPACE });
  const file = await fs.file(ARCHIVE);
  return { archive: file?.size ?? 0, ...(await quota()) };
}

async function fromArchiveFile(file: CsFile, label: string): Promise<ResolvedSource> {
  const source = await archiveDbSource(file);
  return { kind: "archive", source, label, facts: source.facts };
}

/**
 * Copy `ecu.zip` into OPFS and open it.
 *
 * Streamed rather than buffered — `write` takes a `ReadableStream`, so 104 MB never
 * sits in memory as one array. It is still a copy: a `File` from a picker is a handle
 * to something the user may move or delete, and OPFS is the only store that never asks
 * permission again.
 *
 * The archive is validated by opening it *before* the previous one is replaced, so a
 * wrong file cannot destroy a working database — the bug that motivated
 * `inspectArchive`, and now structural rather than a check that has to be remembered.
 */
export async function installArchive(file: File): Promise<ResolvedSource> {
  if (!isOpfsSupported()) {
    throw new Error(ui("install.noOpfs"));
  }

  // Opened straight off the picked File first. If it is not a database archive this
  // throws before anything is written.
  await fromArchiveFile(new BlobFile(`/${file.name}`, file), file.name);

  const fs = await opfsFileSystem({ namespace: NAMESPACE });
  // Asked before writing 104 MB, not after. The browser may refuse; the answer is
  // reported rather than thrown, because an evictable database still works.
  await persist().catch(() => false);
  await fs.write(ARCHIVE, file.stream());

  saveSourceKind("archive");
  // Re-open from OPFS so the returned source is the stored copy, not the picked file —
  // otherwise the first session would hold a handle that a reload cannot reproduce.
  const stored = await fs.file(ARCHIVE);
  if (stored === null) throw new Error(ui("install.notReadBack"));
  return await fromArchiveFile(stored, file.name);
}

/** Open the archive already in OPFS, or `null` if there is none. */
export async function openStoredArchive(): Promise<ResolvedSource | null> {
  if (!isOpfsSupported()) return null;
  const fs = await opfsFileSystem({ namespace: NAMESPACE });
  const file = await fs.file(ARCHIVE);
  if (file === null) return null;
  return await fromArchiveFile(file, ARCHIVE);
}

/** Forget the stored archive and any remembered folder. */
export async function forgetArchive(): Promise<void> {
  if (isOpfsSupported()) {
    const fs = await opfsFileSystem({ namespace: NAMESPACE });
    await fs.remove(ARCHIVE).catch(() => undefined);
  }
  await clearStored();
}

/**
 * Ask for a folder holding a split tree.
 *
 * Verified before it is remembered: a folder that is not a tree is rejected here rather
 * than at the first ECU the user clicks.
 */
export async function chooseFolder(): Promise<ResolvedSource> {
  const handle = await pickDirectory("read");
  const resolved = await fromFolder(handle);
  await saveFolderHandle(handle);
  saveSourceKind("folder");
  return resolved;
}

async function fromFolder(handle: FileSystemDirectoryHandle): Promise<ResolvedSource> {
  const fs = new FsaFileSystem(handle);
  const source = csfsDbSource(fs);
  // One read that must succeed. `index.json` is the tree's root document, so its
  // absence means this is not a tree.
  await source.read("index.json");
  return { kind: "folder", source, label: handle.name };
}

/**
 * Can the remembered folder be used without asking?
 *
 * Browsers drop file access on reload — the handle survives in IndexedDB but
 * `queryPermission` then reports `"prompt"`, and re-granting only works inside a user
 * gesture. So this distinguishes "needs a click" from "gone", which is the difference
 * between showing a button and showing the picker.
 */
export async function folderStatus(): Promise<"ready" | "needs-permission" | "absent"> {
  const handle = await loadFolderHandle();
  if (handle === null) return "absent";
  return (await queryAccess(handle, "read")) ? "ready" : "needs-permission";
}

/** Re-grant access to the remembered folder. Must be called from a user gesture. */
export async function continueWithFolder(): Promise<ResolvedSource> {
  const handle = await loadFolderHandle();
  if (handle === null) throw new Error(ui("install.folderRejected"));
  if (!(await requestAccess(handle, "read"))) {
    throw new Error(ui("install.noPermission"));
  }
  return await fromFolder(handle);
}

/**
 * Read the tree over HTTP.
 *
 * csfs-http needs a manifest, because HTTP cannot list a directory — `db-split` emits
 * `csfs-manifest.json` beside the tree for exactly this.
 */
export async function chooseRemote(url: string): Promise<ResolvedSource> {
  const fs = httpFileSystem(url);
  const source = csfsDbSource(fs);
  await source.read("index.json");
  saveSourceKind("url", url);
  return { kind: "url", source, label: url };
}

/** Re-open whatever was used last. `null` means "ask the user". */
export async function resolveSavedSource(): Promise<ResolvedSource | null> {
  const kind = savedSourceKind();

  if (kind === "url") {
    const url = savedRemoteUrl();
    if (url !== null) return await chooseRemote(url).catch(() => null);
  }

  if (kind === "folder") {
    // Never prompts: re-granting needs a gesture, so a folder that lost permission is
    // reported by `folderStatus` and re-opened by `continueWithFolder`.
    if ((await folderStatus()) === "ready") {
      const handle = await loadFolderHandle();
      if (handle !== null) return await fromFolder(handle).catch(() => null);
    }
    return null;
  }

  return await openStoredArchive().catch(() => null);
}
