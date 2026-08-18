/**
 * The wire format, both directions.
 *
 * Worth testing rather than eyeballing because every failure mode here is silent: a
 * length mismatch reads garbage, a detached buffer writes into nothing, and a
 * malformed command from a plugin would otherwise surface as an unrelated crash
 * somewhere in the host.
 */

import { describe, expect, it } from "vitest";
import { parseCommand, PluginProtocolError, readPrefixed, writeBytes } from "./wire.js";
import type { PluginExports } from "./index.js";

/** A stand-in for a plugin's memory and bump allocator. */
function fakePlugin(initialPages = 1): PluginExports & { heap: number } {
  const memory = new WebAssembly.Memory({ initial: initialPages });
  const state = { heap: 1024 };
  return {
    memory,
    get heap() {
      return state.heap;
    },
    alloc(size: number) {
      const ptr = state.heap;
      state.heap = (state.heap + size + 15) & ~15;
      const needed = Math.ceil((state.heap + 8) / 65536);
      const current = memory.buffer.byteLength / 65536;
      // Growing detaches `memory.buffer`, which is the trap `writeBytes` avoids.
      if (needed > current) memory.grow(needed - current);
      return ptr;
    },
    start: () => 0,
    resume: () => 0,
  };
}

/** Put a length-prefixed string into memory the way a plugin's `emit` would. */
function emit(plugin: PluginExports, text: string): number {
  const bytes = new TextEncoder().encode(text);
  const ptr = plugin.alloc(bytes.byteLength + 4);
  const view = new DataView(plugin.memory.buffer);
  view.setInt32(ptr, bytes.byteLength, true);
  new Uint8Array(plugin.memory.buffer).set(bytes, ptr + 4);
  return ptr;
}

describe("readPrefixed", () => {
  it("round-trips a command", () => {
    const plugin = fakePlugin();
    const json = '{"op":"read","request":"DataRead.Counter"}';
    expect(readPrefixed(plugin.memory, emit(plugin, json))).toBe(json);
  });

  it("round-trips multi-byte characters by byte length, not character count", () => {
    // Every French label in the database is a chance to get this wrong.
    const plugin = fakePlugin();
    const json = '{"op":"log","text":"Régime moteur — état protégé"}';
    expect(readPrefixed(plugin.memory, emit(plugin, json))).toBe(json);
  });

  it("refuses a null pointer instead of reading offset zero", () => {
    const plugin = fakePlugin();
    expect(() => readPrefixed(plugin.memory, 0)).toThrow(/null command pointer/);
  });

  it("refuses a length that runs past the end of memory", () => {
    const plugin = fakePlugin();
    const ptr = plugin.alloc(16);
    new DataView(plugin.memory.buffer).setInt32(ptr, 1_000_000, true);
    expect(() => readPrefixed(plugin.memory, ptr)).toThrow(/out-of-range/);
  });
});

describe("writeBytes", () => {
  it("writes where the plugin can read it back", () => {
    const plugin = fakePlugin();
    const [ptr, len] = writeBytes(plugin, '{"ok":true}');
    const bytes = new Uint8Array(plugin.memory.buffer, ptr, len);
    expect(new TextDecoder().decode(bytes)).toBe('{"ok":true}');
  });

  it("survives an allocation that grows memory", () => {
    // The failure this guards against is silent: a view taken before `alloc` points
    // into a buffer that `memory.grow` has detached, so the write lands nowhere.
    const plugin = fakePlugin(1);
    const big = "x".repeat(200_000);
    const [ptr, len] = writeBytes(plugin, big);
    expect(plugin.memory.buffer.byteLength).toBeGreaterThan(65536);
    expect(new TextDecoder().decode(new Uint8Array(plugin.memory.buffer, ptr, len))).toBe(big);
  });
});

describe("parseCommand", () => {
  it("reads each op", () => {
    expect(parseCommand('{"op":"session","request":"StartDiagnosticSession.Default"}')).toEqual({
      op: "session",
      request: "StartDiagnosticSession.Default",
    });
    expect(parseCommand('{"op":"done","status":"ok","text":"cleared"}')).toEqual({
      op: "done",
      status: "ok",
      text: "cleared",
    });
  });

  it("coerces write values to strings", () => {
    // The originals pass both: `send_request({"x": 0})` and `send_request({"x": "0"})`.
    // `buildDataStream` looks enum labels back up by text, so it needs strings.
    const command = parseCommand('{"op":"write","request":"DataWrite.X","values":{"a":0,"b":"1"}}');
    expect(command).toEqual({ op: "write", request: "DataWrite.X", values: { a: "0", b: "1" } });
  });

  it("treats an unknown status as failure rather than success", () => {
    const command = parseCommand('{"op":"done","status":"weird","text":""}');
    expect(command).toEqual({ op: "done", status: "failed", text: "" });
  });

  it("rejects a command with no request name", () => {
    expect(() => parseCommand('{"op":"read"}')).toThrow(PluginProtocolError);
    expect(() => parseCommand('{"op":"write","values":{}}')).toThrow(PluginProtocolError);
  });

  it("rejects malformed JSON and unknown ops", () => {
    expect(() => parseCommand("not json")).toThrow(/invalid JSON/);
    expect(() => parseCommand('{"op":"exfiltrate"}')).toThrow(/unknown op/);
  });
});
