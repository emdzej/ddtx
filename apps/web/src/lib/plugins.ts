/**
 * Discovering plugins, and running one.
 *
 * The interesting half is `hostFor`. A plugin never holds a driver — it emits commands
 * and this decides what to do with them, which is what makes the write gates
 * unavoidable rather than merely conventional. Compare the original, where a plugin
 * calls `options.elm.start_session_can()` and nothing is in the way.
 *
 * A plugin also names its own ECU, which is usually *not* the one selected in the
 * catalogue. So the ECU is loaded and attached per run, and detached afterwards by
 * putting the previously-open screen back.
 *
 * See docs/plugins.md.
 */

import { buildDataStream, decodeStream, formatRequestStream, type BoundRequest } from "@ddtx/codec";
import type { LoadedEcu } from "@ddtx/db";
import { negativeResponse, type EcuLink } from "@ddtx/link";
import type {
  PluginExports,
  PluginIndexEntry,
  PluginManifest,
  PluginResult,
} from "@ddtx/plugin-sdk";
import type { PluginHost } from "@ddtx/session";

/** Where the bundler puts the plugins. Served from `public/`. */
const PLUGINS_ROOT = `${import.meta.env.BASE_URL}plugins/`;

export interface LoadedPluginModule {
  manifest: PluginManifest;
  exports: PluginExports;
  bytes: number;
}

/** Read the index and every manifest. Absent plugins are not an error — there may be none. */
export async function discoverPlugins(): Promise<PluginManifest[]> {
  let entries: PluginIndexEntry[];
  try {
    const response = await fetch(`${PLUGINS_ROOT}index.json`);
    if (!response.ok) return [];
    entries = (await response.json()) as PluginIndexEntry[];
  } catch {
    // No plugins bundled. The app is entirely usable without them.
    return [];
  }

  const manifests = await Promise.all(
    entries.map(async (entry) => {
      const response = await fetch(`${PLUGINS_ROOT}${entry.manifest}`);
      if (!response.ok) return null;
      return (await response.json()) as PluginManifest;
    }),
  );
  return manifests.filter((manifest): manifest is PluginManifest => manifest !== null);
}

/**
 * Fetch and instantiate a plugin.
 *
 * The `importObject` is empty, and that is the sandbox: a module declaring any import
 * fails here with a `LinkError` before a single instruction runs. The bundler refuses
 * such a module too, but a stale `public/` could carry one, so this is the check that
 * cannot be skipped.
 */
export async function loadPluginModule(manifest: PluginManifest): Promise<LoadedPluginModule> {
  const response = await fetch(`${PLUGINS_ROOT}${manifest.wasm}`);
  if (!response.ok) {
    throw new Error(`Cannot fetch ${manifest.name}: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const module = await WebAssembly.compile(bytes);

  const declared = WebAssembly.Module.imports(module);
  if (declared.length > 0) {
    throw new Error(
      `${manifest.name} declares imports (${declared
        .map((entry) => `${entry.module}.${entry.name}`)
        .join(", ")}) and will not be run.`,
    );
  }

  const instance = await WebAssembly.instantiate(module, {});
  return {
    manifest,
    exports: instance.exports as unknown as PluginExports,
    bytes: bytes.byteLength,
  };
}

export interface HostBinding {
  /**
   * The ECU the plugin's manifest names, or null when it names none.
   *
   * Null is legitimate — the VIN calculator needs no vehicle — and it is also the check
   * that catches a plugin which declares no ECU but asks for a request anyway: the
   * command fails with a reason rather than reaching a bus it should not be on.
   */
  ecu: LoadedEcu | null;
  link: EcuLink | null;
  /** True on a vehicle. Demo mode runs the same procedure against `SimulatedLink`. */
  live: boolean;
  /** Called before the first write. Return false to refuse the whole run. */
  confirmWrite: () => Promise<boolean>;
  /** Refuse a write outright, with a reason — the write toggle being off, say. */
  writeRefusal: () => string | null;
  log: (text: string) => void;
  ask: (prompt: string, field: string) => Promise<string | null>;
  onExchange?: (sent: string, received: string, requestName: string) => void;
}

/**
 * Turn a binding into the host a plugin talks to.
 *
 * Every command becomes a real request through the codec, so a plugin's reads decode the
 * same way a screen's do. Writes additionally pass the gate and the confirmation, and
 * the confirmation happens **once** — a procedure with four writes should not ask four
 * times, and a per-write prompt is how people learn to click through them.
 */
export function hostFor(binding: HostBinding): PluginHost {
  let confirmed = false;

  const send = async (
    requestName: string,
    values: Record<string, string>,
  ): Promise<PluginResult> => {
    if (binding.ecu === null || binding.link === null) {
      return { ok: false, error: "this plugin names no ECU, so it cannot send requests" };
    }
    const request = binding.ecu.requests.get(requestName);
    if (request === undefined) {
      return { ok: false, error: `this ECU has no request named "${requestName}"` };
    }

    const built = buildDataStream(request, values);
    if (!built.ok) {
      return { ok: false, error: `"${built.field}" is not a value that field accepts` };
    }

    const frame = formatRequestStream(built.stream);
    let received: string;
    try {
      received = await binding.link.request(frame, { requestName });
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    binding.onExchange?.(frame, received, requestName);

    const rejected = negativeResponse(received);
    if (rejected !== null) {
      // Handed back as a failure with the NRC intact, because the NRC is what explains
      // it — and a procedure often has a fallback for a specific one.
      return { ok: false, error: `NR:${rejected.code}:${rejected.message}` };
    }
    if (received.trim().length === 0) {
      return { ok: false, error: "no answer" };
    }

    return { ok: true, values: decodeValues(request, received), raw: received };
  };

  return {
    session: (requestName, values) => send(requestName, values ?? {}),

    read: (requestName) => send(requestName, {}),

    async write(requestName, values) {
      const refusal = binding.writeRefusal();
      if (refusal !== null) return { ok: false, error: refusal };

      if (!confirmed) {
        if (!(await binding.confirmWrite())) {
          return { ok: false, error: "the operator did not confirm" };
        }
        confirmed = true;
      }
      return send(requestName, values);
    },

    log: binding.log,
    ask: binding.ask,
  };
}

/**
 * Decode every field the request reads out of the reply.
 *
 * `decodeStream` yields `null` for a field the response was too short to carry. Those
 * are dropped rather than passed across as `"null"`, because the plugin side pulls
 * fields by name and an absent field should read as absent.
 */
function decodeValues(request: BoundRequest, received: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [dataName, value] of Object.entries(decodeStream(request, received))) {
    if (value !== null) values[dataName] = value;
  }
  return values;
}
