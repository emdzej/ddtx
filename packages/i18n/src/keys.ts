/**
 * Overlay keys.
 *
 * The database's strings are its primary keys — `data` is keyed by the French
 * label, and a layout widget's `text` field is a lookup into it — so nothing here
 * ever rewrites a string in place. Translation is a lookup performed at the
 * render boundary and nowhere else. See docs/i18n-overlay.md.
 *
 * Keys are content-hashed rather than path-based. Reuse across the database
 * averages 20:1, so a path key would need one entry per *occurrence* where a
 * content key needs one per distinct string; and the strings are stable
 * identifiers by construction, which paths into a 2019 snapshot are not.
 */

/**
 * Which vocabulary a string belongs to.
 *
 * Named after the *reference target*, not the syntactic location, which is what
 * makes coverage compound: one `data` entry translates the `data` dictionary key,
 * every dataitem that names it, and every display caption that shows it.
 */
export type Namespace =
  /** `data{}` keys, dataitem names, and display/input captions. */
  | "data"
  /** `requests[].name`, and every reference to one. */
  | "request"
  /** `screens{}` keys and category members. */
  | "screen"
  /** `categories{}` keys. */
  | "category"
  /** DTC device names. */
  | "device"
  /** DTC failure-flag names. */
  | "deviceData"
  /** `data.lists` values — the enum labels shown in a value cell. */
  | "list"
  /** `data.unit`. Canonicalised rather than translated. */
  | "unit"
  /** `data.comment` — the help text behind a value. */
  | "comment"
  /** Static screen captions and group-box titles. */
  | "label"
  /** Button captions. `uniquename` remains the identity. */
  | "button"
  /** Button confirmation prompts. */
  | "message";

export const NAMESPACES: readonly Namespace[] = [
  "data",
  "request",
  "screen",
  "category",
  "device",
  "deviceData",
  "list",
  "unit",
  "comment",
  "label",
  "button",
  "message",
];

/** Length of the hex digest kept in a key: 64 bits, ample for ~500k strings. */
export const KEY_BITS = 16;

/**
 * `<namespace>:<sha256(NFC(source))[0..16]>`.
 *
 * Async because it uses WebCrypto, which is the only digest available in both a
 * browser and Node without a dependency. Callers hash once at load and keep the
 * map, so this is never on a render path.
 */
export async function overlayKey(namespace: Namespace, source: string): Promise<string> {
  return `${namespace}:${await digest(source)}`;
}

export async function digest(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source.normalize("NFC"));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, KEY_BITS);
}
