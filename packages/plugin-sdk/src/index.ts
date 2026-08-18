/**
 * The plugin contract: manifest, command protocol, and WebAssembly ABI.
 *
 * A plugin is a diagnostic *procedure* — open a session, read, decide, write, verify —
 * so it cannot be a single synchronous call the way an image filter can. It is a state
 * machine the host drives: the plugin returns a command, the host performs it and hands
 * back the result, and round it goes until the plugin says `done`.
 *
 * The property that buys: a plugin compiles with **zero WebAssembly imports**, so it
 * instantiates against an empty `importObject` and there is no host function for it to
 * call. It cannot reach the bus, the DOM, or the network — not by convention but by
 * construction. And because it only ever *asks*, every write it wants goes through the
 * same gates a button press does.
 *
 * See docs/plugins.md.
 */

/* ── manifest ──────────────────────────────────────────────────────────────── */

/**
 * What a plugin is allowed to ask for.
 *
 * Declared in the manifest and enforced by the host at the command, not at load: a
 * plugin that declares `read` and emits a `write` is refused and *told* it was refused,
 * so a mis-declared manifest fails loudly instead of quietly skipping a step.
 */
export type PluginCapability =
  /** Open a diagnostic session on the ECU. */
  | "session"
  /** Send a request and decode the reply. */
  | "read"
  /** Send a request that changes something. Gated like any other write. */
  | "write"
  /** Ask the operator for a value. */
  | "ask";

export interface PluginManifest {
  /** Machine name. Matches the folder under `packages/plugins/`. */
  name: string;
  /** Human-readable label for the menu. */
  label: string;
  /** Groups plugins in the menu, as the original's `category` did. */
  category: string;
  /**
   * The ECU slug this procedure was written against, if it needs one.
   *
   * Checked against the attached vehicle before anything runs: a UCH reset aimed at
   * the wrong module is the kind of mistake worth making impossible. Absent for
   * plugins that touch no vehicle at all — the VIN CRC calculator is the only one.
   */
  ecu?: string;
  capabilities: PluginCapability[];
  description: string;
  /**
   * Shown verbatim in the confirmation before the first write.
   *
   * The original plugins carry their own warnings ("THIS PLUGIN WILL ERASE WATER PUMP
   * COUNTERS") and those are the authored words, so they are used as written rather
   * than replaced with something generic.
   */
  warning?: string;
  /** Path to the compiled module, relative to the plugin root. Filled in by the build. */
  wasm: string;
}

/** One row of the plugin index the host fetches at startup. */
export interface PluginIndexEntry {
  name: string;
  manifest: string;
}

/* ── the ABI ───────────────────────────────────────────────────────────────── */

/**
 * What every plugin exports.
 *
 * `start` and `resume` both return a pointer to a length-prefixed UTF-8 JSON command:
 * an `i32` byte count followed by that many bytes.
 */
export interface PluginExports {
  memory: WebAssembly.Memory;
  /** Bump-allocate `size` bytes and return the pointer. */
  alloc(size: number): number;
  /** Begin the procedure. Returns a pointer to the first command. */
  start(): number;
  /** Given the previous command's result, return the next command. */
  resume(ptr: number, len: number): number;
}

/* ── commands ──────────────────────────────────────────────────────────────── */

export interface SessionCommand {
  op: "session";
  request: string;
  /**
   * Values for the session request, keyed by data name.
   *
   * Needed because several session requests are parameterised rather than fixed —
   * `Start Diagnostic Session` on the Laguna II UCH takes a `Session Name` of `Etude`
   * or `APV`, and the two do different things.
   */
  values?: Record<string, string>;
}

export interface ReadCommand {
  op: "read";
  request: string;
}

export interface WriteCommand {
  op: "write";
  request: string;
  /** Keyed by data name, as `buildDataStream` expects. */
  values: Record<string, string>;
}

export interface LogCommand {
  op: "log";
  text: string;
}

export interface AskCommand {
  op: "ask";
  prompt: string;
  /** Echoed back in the result so a plugin asking twice can tell them apart. */
  field: string;
}

export interface DoneCommand {
  op: "done";
  status: "ok" | "failed";
  text: string;
}

export type PluginCommand =
  SessionCommand | ReadCommand | WriteCommand | LogCommand | AskCommand | DoneCommand;

/**
 * What the host hands back.
 *
 * `ok: false` is not fatal and the host does not abort on the plugin's behalf: "the
 * ECU refused" is frequently the answer a procedure is looking for, and only the
 * procedure knows whether it can carry on.
 */
export type PluginResult =
  | { ok: true; values?: Record<string, string>; value?: string; raw?: string }
  | { ok: false; error: string };

/** Which capability a command needs, so the host can check one against the other. */
export function requiredCapability(op: PluginCommand["op"]): PluginCapability | null {
  switch (op) {
    case "session":
      return "session";
    case "read":
      return "read";
    case "write":
      return "write";
    case "ask":
      return "ask";
    // `log` and `done` need nothing: neither touches the vehicle or the operator.
    default:
      return null;
  }
}

/**
 * The steps a plugin may take before the host gives up on it.
 *
 * A plugin is a loop the host drives, so a plugin that never returns `done` would spin
 * forever. This is the backstop, set far above any real procedure — the longest of the
 * originals is the Zoe counter reset at roughly twenty exchanges.
 */
export const MAX_PLUGIN_STEPS = 500;

export * from "./wire.js";
