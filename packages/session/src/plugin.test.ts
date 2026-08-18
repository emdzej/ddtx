/**
 * The plugin loop, against a scripted plugin and a recording host.
 *
 * The two things here that must hold no matter what a plugin does: it cannot exceed
 * the capabilities its manifest declares, and it cannot run forever. Everything else
 * is a plugin's own business.
 */

import { describe, expect, it, vi } from "vitest";
import type { PluginExports, PluginManifest, PluginResult } from "@ddtx/plugin-sdk";
import { runPlugin, type PluginHost } from "./plugin.js";

/**
 * A plugin implemented in TypeScript rather than compiled from AssemblyScript.
 *
 * The wire format is real — length-prefixed UTF-8 through a `WebAssembly.Memory` — so
 * this exercises the same encoding a compiled module uses. What it avoids is a build
 * step in the unit tests; a real `.wasm` is driven by the corpus test instead.
 */
function scriptedPlugin(script: Array<string | ((reply: PluginResult) => string)>): PluginExports {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let heap = 1024;
  let step = 0;

  const alloc = (size: number): number => {
    const ptr = heap;
    heap = (heap + size + 15) & ~15;
    const needed = Math.ceil((heap + 8) / 65536);
    const current = memory.buffer.byteLength / 65536;
    if (needed > current) memory.grow(needed - current);
    return ptr;
  };

  const emit = (text: string): number => {
    const bytes = new TextEncoder().encode(text);
    const ptr = alloc(bytes.byteLength + 4);
    new DataView(memory.buffer).setInt32(ptr, bytes.byteLength, true);
    new Uint8Array(memory.buffer).set(bytes, ptr + 4);
    return ptr;
  };

  const next = (reply: PluginResult): number => {
    const entry = script[step];
    step += 1;
    if (entry === undefined) return emit('{"op":"done","status":"ok","text":"end of script"}');
    return emit(typeof entry === "function" ? entry(reply) : entry);
  };

  return {
    memory,
    alloc,
    start: () => next({ ok: true }),
    resume: (ptr, len) => {
      // The host writes results raw, not length-prefixed — it already knows the length.
      const text = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len).slice());
      return next(JSON.parse(text) as PluginResult);
    },
  };
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test",
    label: "Test",
    category: "Test",
    capabilities: ["session", "read", "write", "ask"],
    description: "",
    wasm: "test/plugin.wasm",
    ...overrides,
  };
}

function recordingHost(overrides: Partial<PluginHost> = {}): PluginHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    session: vi.fn(async (request) => {
      calls.push(`session ${request}`);
      return { ok: true } as PluginResult;
    }),
    read: vi.fn(async (request) => {
      calls.push(`read ${request}`);
      return { ok: true, values: { [request]: "42" } } as PluginResult;
    }),
    write: vi.fn(async (request, values) => {
      calls.push(`write ${request} ${JSON.stringify(values)}`);
      return { ok: true } as PluginResult;
    }),
    log: vi.fn((text: string) => {
      calls.push(`log ${text}`);
    }),
    ask: vi.fn(async () => "typed"),
    ...overrides,
  };
}

describe("runPlugin", () => {
  it("runs a sequence and reports the plugin's own closing words", async () => {
    const plugin = scriptedPlugin([
      '{"op":"session","request":"StartDiagnosticSession.Default"}',
      '{"op":"read","request":"DataRead.Counter"}',
      '{"op":"write","request":"DataWrite.Counter","values":{"Counter":"0"}}',
      '{"op":"done","status":"ok","text":"counters cleared"}',
    ]);
    const host = recordingHost();

    const outcome = await runPlugin(manifest(), plugin, host);

    expect(outcome).toEqual({ status: "ok", text: "counters cleared", steps: 4 });
    expect(host.calls).toEqual([
      "session StartDiagnosticSession.Default",
      "read DataRead.Counter",
      'write DataWrite.Counter {"Counter":"0"}',
    ]);
  });

  it("hands each command's result back to the plugin", async () => {
    // Proves the loop is genuinely bidirectional rather than fire-and-forget.
    const plugin = scriptedPlugin([
      '{"op":"read","request":"DataRead.Counter"}',
      (reply) =>
        JSON.stringify({
          op: "done",
          status: "ok",
          text: `saw ${reply.ok ? JSON.stringify(reply.values) : "nothing"}`,
        }),
    ]);

    const outcome = await runPlugin(manifest(), plugin, recordingHost());

    expect(outcome.text).toBe('saw {"DataRead.Counter":"42"}');
  });

  it("refuses a command the manifest does not declare, and never calls the host", async () => {
    // The capability model's whole point: declaring `read` must not get you a write.
    const plugin = scriptedPlugin([
      '{"op":"write","request":"DataWrite.Counter","values":{"Counter":"0"}}',
    ]);
    const host = recordingHost();

    const outcome = await runPlugin(manifest({ capabilities: ["read"] }), plugin, host);

    expect(outcome.status).toBe("aborted");
    expect(outcome.text).toMatch(/asked to write/);
    expect(host.write).not.toHaveBeenCalled();
    expect(host.calls).toEqual([]);
  });

  it("stops a plugin that never finishes", async () => {
    // The host drives the loop, so without this a plugin holds the bus indefinitely.
    const plugin = scriptedPlugin(
      Array.from({ length: 50 }, () => '{"op":"log","text":"still going"}'),
    );
    const host = recordingHost();

    const outcome = await runPlugin(manifest(), plugin, host, { maxSteps: 8 });

    expect(outcome.status).toBe("aborted");
    expect(outcome.text).toMatch(/ran past 8 steps/);
    // Eight commands *performed*. The plugin emits a ninth from the last `resume`,
    // which is never read — the cap counts what ran, not what was offered.
    expect(outcome.steps).toBe(8);
    expect(host.calls).toHaveLength(8);
  });

  it("reports a failed command to the plugin rather than aborting", async () => {
    // "The ECU refused" is often the answer a procedure is looking for, so the plugin
    // decides what to do about it — the host does not decide on its behalf.
    const plugin = scriptedPlugin([
      '{"op":"read","request":"DataRead.Missing"}',
      (reply) =>
        JSON.stringify({
          op: "done",
          status: "ok",
          text: reply.ok ? "unexpected success" : `handled: ${reply.error}`,
        }),
    ]);
    const host = recordingHost({
      read: async () => ({ ok: false, error: "NR:31:Request out of range" }),
    });

    const outcome = await runPlugin(manifest(), plugin, host);

    expect(outcome.status).toBe("ok");
    expect(outcome.text).toBe("handled: NR:31:Request out of range");
  });

  it("turns a host that throws into a failed command", async () => {
    const plugin = scriptedPlugin([
      '{"op":"read","request":"DataRead.Counter"}',
      (reply) =>
        JSON.stringify({
          op: "done",
          status: "failed",
          text: reply.ok ? "?" : reply.error,
        }),
    ]);
    const host = recordingHost({
      read: async () => {
        throw new Error("adapter disconnected");
      },
    });

    const outcome = await runPlugin(manifest(), plugin, host);

    expect(outcome).toMatchObject({ status: "failed", text: "adapter disconnected" });
  });

  it("stops on a malformed command instead of guessing", async () => {
    const plugin = scriptedPlugin(['{"op":"exfiltrate","url":"http://elsewhere"}']);

    const outcome = await runPlugin(manifest(), plugin, recordingHost());

    expect(outcome.status).toBe("aborted");
    expect(outcome.text).toMatch(/unknown op/);
  });

  it("treats a declined prompt as a failed command, not a crash", async () => {
    const plugin = scriptedPlugin([
      '{"op":"ask","prompt":"VIN?","field":"vin"}',
      (reply) =>
        JSON.stringify({
          op: "done",
          status: "failed",
          text: reply.ok ? "got it" : reply.error,
        }),
    ]);
    const host = recordingHost({ ask: async () => null });

    const outcome = await runPlugin(manifest(), plugin, host);

    expect(outcome.text).toBe("the operator declined");
  });

  it("reports every command to the trace hook, in order", async () => {
    const seen: string[] = [];
    const plugin = scriptedPlugin([
      '{"op":"log","text":"one"}',
      '{"op":"read","request":"DataRead.X"}',
      '{"op":"done","status":"ok","text":""}',
    ]);

    await runPlugin(manifest(), plugin, recordingHost(), {
      onCommand: (command) => seen.push(command.op),
    });

    expect(seen).toEqual(["log", "read", "done"]);
  });
});
