/**
 * Remembering where the database came from, across sessions.
 *
 * Three things get persisted and they need three different stores, which is worth
 * saying plainly because the reasons are not interchangeable:
 *
 *  - **The OPFS tree** persists itself. Nothing to store, and no permission to
 *    re-acquire. This is why it is the default.
 *  - **A picked folder** is a `FileSystemDirectoryHandle`: structured-cloneable but
 *    not JSON-serialisable, so `localStorage` cannot hold it. It goes in a one-record
 *    IndexedDB store. The handle survives a reload; its *permission* does not —
 *    browsers drop file access deliberately, and `requestPermission` only works
 *    inside a user gesture. Hence the "Continue with last folder" button: a click is
 *    a gesture, startup code is not.
 *  - **A remote URL** and **which source is selected** are strings, so
 *    `localStorage`.
 *
 * Independent implementation. The equivalent in the bimmerz packages is licensed
 * PolyForm Noncommercial and this project is GPL-3.0 (docs/plan.md §5.1), so nothing
 * is copied across — though with `FileSystemDirectoryHandle` being non-serialisable
 * there is only one shape this can take.
 */

const DB_NAME = "ddtx";
const DB_VERSION = 1;
const STORE = "install";
const FOLDER_KEY = "folder";

const SOURCE_KEY = "ddtx.dbSource";
const REMOTE_URL_KEY = "ddtx.dbRemoteUrl";

/** Where the app is currently reading the database from. */
export type DbSourceKind = "opfs" | "folder" | "remote";

export type PermissionState = "granted" | "denied" | "prompt";

/**
 * The Chromium-only permission methods.
 *
 * The DOM types declare these as always present. In practice older Chromiums and any
 * test stub omit them, so they are narrowed here rather than trusted.
 */
type HandleWithPermissions = {
  queryPermission?: (desc?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (desc?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Every one of these swallows its errors.
 *
 * Losing the memory of which folder was picked costs one extra click. Throwing out of
 * startup because IndexedDB is unavailable — private browsing, storage pressure, a
 * blocked upgrade — would cost the whole app.
 */
export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const request = tx.objectStore(STORE).put(handle, FOLDER_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (cause) {
    console.warn("[ddtx/install] could not remember the folder:", cause);
  }
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(FOLDER_KEY);
      request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch (cause) {
    console.warn("[ddtx/install] could not read the remembered folder:", cause);
    return null;
  }
}

export async function clearFolderHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const request = tx.objectStore(STORE).delete(FOLDER_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (cause) {
    console.warn("[ddtx/install] could not forget the folder:", cause);
  }
}

/**
 * Does the stored handle still have live read access?
 *
 * `"prompt"` is the normal answer after a reload and means "ask inside a click".
 * `"denied"` means the handle is spent and the user has to pick again.
 */
export async function queryFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const h = handle as unknown as HandleWithPermissions;
  if (h.queryPermission === undefined) return "prompt";
  try {
    return await h.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

/** Must be called from inside a user gesture, or the browser refuses it. */
export async function requestFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const h = handle as unknown as HandleWithPermissions;
  if (h.requestPermission === undefined) return "prompt";
  try {
    return await h.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

/* ── plain strings ─────────────────────────────────────────────────────────── */

function readLocal(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Full or blocked. Not worth failing over.
  }
}

export function savedSourceKind(): DbSourceKind | null {
  const value = readLocal(SOURCE_KEY);
  return value === "opfs" || value === "folder" || value === "remote" ? value : null;
}

export function saveSourceKind(kind: DbSourceKind): void {
  writeLocal(SOURCE_KEY, kind);
}

export function savedRemoteUrl(): string | null {
  return readLocal(REMOTE_URL_KEY);
}

export function saveRemoteUrl(url: string | null): void {
  writeLocal(REMOTE_URL_KEY, url);
}

/** Is the folder picker available at all? Chromium-only, unlike OPFS. */
export function folderPickerSupported(): boolean {
  return (
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}
