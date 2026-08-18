/**
 * Moving commands and results across the WebAssembly memory boundary.
 *
 * Both directions are length-prefixed UTF-8: an `i32` byte count followed by that many
 * bytes. Kept here rather than in the host so the encoding has exactly one definition —
 * a mismatch between the two sides does not throw, it silently truncates or reads
 * garbage, which is the worst way for this to fail.
 */

import type { PluginCommand, PluginExports, PluginResult } from "./index.js";

/** Read a length-prefixed UTF-8 string out of the plugin's memory. */
export function readPrefixed(memory: WebAssembly.Memory, ptr: number): string {
  if (ptr <= 0) throw new Error("plugin returned a null command pointer");
  const view = new DataView(memory.buffer);
  const length = view.getInt32(ptr, true);
  if (length < 0 || ptr + 4 + length > memory.buffer.byteLength) {
    throw new Error(`plugin returned an out-of-range command (ptr ${ptr}, len ${length})`);
  }
  const bytes = new Uint8Array(memory.buffer, ptr + 4, length);
  // Copied before decoding: the view is a window onto live memory, and the next
  // `alloc` can detach the buffer entirely by growing it.
  return new TextDecoder().decode(bytes.slice());
}

/**
 * Write a string into the plugin's memory and return `[ptr, len]`.
 *
 * The `Uint8Array` view is built *after* `alloc`, because `memory.grow` inside the
 * allocator detaches `memory.buffer` and a view taken earlier would write into a dead
 * buffer. That is the one mistake in this file that produces no error at all.
 */
export function writeBytes(exports: PluginExports, text: string): [number, number] {
  const bytes = new TextEncoder().encode(text);
  const ptr = exports.alloc(bytes.byteLength);
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.byteLength];
}

export class PluginProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginProtocolError";
  }
}

/** Parse and shape-check a command the plugin emitted. */
export function parseCommand(json: string): PluginCommand {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PluginProtocolError(`plugin emitted invalid JSON: ${json.slice(0, 120)}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new PluginProtocolError("plugin emitted a non-object command");
  }

  const command = value as Record<string, unknown>;
  const op = command.op;

  switch (op) {
    case "session":
    case "read":
      if (typeof command.request !== "string" || command.request.length === 0) {
        throw new PluginProtocolError(`${op} command has no request name`);
      }
      return { op, request: command.request };

    case "write": {
      if (typeof command.request !== "string" || command.request.length === 0) {
        throw new PluginProtocolError("write command has no request name");
      }
      const values: Record<string, string> = {};
      const raw = command.values;
      if (typeof raw === "object" && raw !== null) {
        for (const [key, entry] of Object.entries(raw)) {
          // Coerced to string because `buildDataStream` looks enum labels back up by
          // text, and the original plugins pass integers and strings interchangeably —
          // `send_request({"…": 0})` and `send_request({"…": "0"})` both appear.
          values[key] = typeof entry === "string" ? entry : String(entry);
        }
      }
      return { op: "write", request: command.request, values };
    }

    case "log":
      return { op: "log", text: typeof command.text === "string" ? command.text : "" };

    case "ask":
      return {
        op: "ask",
        prompt: typeof command.prompt === "string" ? command.prompt : "",
        field: typeof command.field === "string" ? command.field : "value",
      };

    case "done":
      return {
        op: "done",
        // Only "ok" means ok. A missing or misspelled status reads as failure, because
        // the alternative is claiming a success nobody stated — and a plugin author
        // who forgot the field sees "failed" at once instead of a false green.
        status: command.status === "ok" ? "ok" : "failed",
        text: typeof command.text === "string" ? command.text : "",
      };

    default:
      throw new PluginProtocolError(`plugin emitted an unknown op: ${JSON.stringify(op)}`);
  }
}

export function encodeResult(result: PluginResult): string {
  return JSON.stringify(result);
}
