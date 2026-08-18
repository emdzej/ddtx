/**
 * Driving a plugin.
 *
 * A plugin is a state machine: it returns a command, the host performs it, the host
 * hands back the result. This is the loop, plus the two things that must not be
 * skippable — the capability check and the step cap.
 *
 * The I/O itself is the caller's, behind `PluginHost`. That is deliberate: writes have
 * to pass the same gates a button press does (writes enabled, adapter lock, operator
 * confirmed), and those live where the UI is. Putting them behind an interface keeps
 * this loop testable with a fake host and keeps the gating in one place rather than
 * duplicated here.
 *
 * See docs/plugins.md.
 */

import {
  MAX_PLUGIN_STEPS,
  parseCommand,
  PluginProtocolError,
  readPrefixed,
  requiredCapability,
  writeBytes,
  type PluginCommand,
  type PluginExports,
  type PluginManifest,
  type PluginResult,
} from "@ddtx/plugin-sdk";

/** What the host must be able to do on the plugin's behalf. */
export interface PluginHost {
  /** Open a diagnostic session. `values` is set for parameterised session requests. */
  session(request: string, values?: Record<string, string>): Promise<PluginResult>;
  /** Send a request and decode the reply. */
  read(request: string): Promise<PluginResult>;
  /**
   * Send a request that changes something.
   *
   * The implementation is expected to have gone through the write gates. This module
   * cannot check that for you, which is exactly why it is not this module's job.
   */
  write(request: string, values: Record<string, string>): Promise<PluginResult>;
  /** Show a line of progress. */
  log(text: string): void;
  /** Ask the operator for a value. `null` means they declined. */
  ask(prompt: string, field: string): Promise<string | null>;
}

export interface PluginOutcome {
  status: "ok" | "failed" | "aborted";
  /** The plugin's own closing words, or the reason it was stopped. */
  text: string;
  /** Commands performed, for the trace. */
  steps: number;
}

export interface RunOptions {
  /** Lower the cap, for tests. */
  maxSteps?: number;
  /** Called for every command, before it runs. The trace hook. */
  onCommand?: (command: PluginCommand) => void;
}

export class PluginCapabilityError extends Error {
  constructor(
    public readonly plugin: string,
    public readonly needed: string,
  ) {
    super(`Plugin "${plugin}" asked to ${needed}, which its manifest does not declare`);
    this.name = "PluginCapabilityError";
  }
}

/**
 * Run a plugin to completion.
 *
 * Never throws for anything the plugin did — a bad command, a refused capability, or
 * running past the step cap all come back as `aborted` with a reason, because a plugin
 * misbehaving is a result to report and not an exception for the app to handle.
 */
export async function runPlugin(
  manifest: PluginManifest,
  exports: PluginExports,
  host: PluginHost,
  options: RunOptions = {},
): Promise<PluginOutcome> {
  const cap = new Set(manifest.capabilities);
  const limit = options.maxSteps ?? MAX_PLUGIN_STEPS;

  let pointer: number;
  try {
    pointer = exports.start();
  } catch (cause) {
    return abort(`the plugin failed on start: ${describe(cause)}`, 0);
  }

  for (let step = 1; step <= limit; step += 1) {
    let command: PluginCommand;
    try {
      command = parseCommand(readPrefixed(exports.memory, pointer));
    } catch (cause) {
      // A protocol error is the plugin's fault, so it stops the plugin and says so
      // rather than propagating as if the host were broken.
      return abort(describe(cause), step);
    }

    options.onCommand?.(command);

    if (command.op === "done") {
      return { status: command.status, text: command.text, steps: step };
    }

    const needed = requiredCapability(command.op);
    if (needed !== null && !cap.has(needed)) {
      return abort(`it asked to ${command.op}, which its manifest does not declare`, step);
    }

    let result: PluginResult;
    try {
      result = await perform(command, host);
    } catch (cause) {
      // The host threw — a dropped adapter, a cancelled lock. Reported to the plugin
      // as a failed command, because a procedure may well have a fallback.
      result = { ok: false, error: describe(cause) };
    }

    try {
      const [ptr, len] = writeBytes(exports, JSON.stringify(result));
      pointer = exports.resume(ptr, len);
    } catch (cause) {
      return abort(`the plugin failed on resume: ${describe(cause)}`, step);
    }
  }

  // Never said `done`. The cap exists because the host drives the loop, so a plugin
  // that keeps emitting commands would otherwise hold the bus indefinitely.
  return abort(`it ran past ${limit} steps without finishing`, limit);
}

async function perform(command: PluginCommand, host: PluginHost): Promise<PluginResult> {
  switch (command.op) {
    case "session":
      return host.session(command.request, command.values);
    case "read":
      return host.read(command.request);
    case "write":
      return host.write(command.request, command.values);
    case "log":
      host.log(command.text);
      return { ok: true };
    case "ask": {
      const answer = await host.ask(command.prompt, command.field);
      return answer === null
        ? { ok: false, error: "the operator declined" }
        : { ok: true, value: answer };
    }
    case "done":
      // Handled by the caller before we get here.
      return { ok: true };
  }
}

function abort(reason: string, steps: number): PluginOutcome {
  return { status: "aborted", text: reason, steps };
}

function describe(cause: unknown): string {
  if (cause instanceof PluginProtocolError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
