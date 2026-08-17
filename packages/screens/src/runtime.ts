/**
 * Drive one screen: work out what to ask the ECU, ask it, and decode the answers
 * back onto widgets.
 *
 * Port of `param_widget.updateDisplays` / `updateDisplay`, with the timers left
 * out. The original restarts a `QTimer` from inside its own refresh, which
 * couples cadence to completion and makes the whole thing untestable; here
 * `refresh()` is a plain async call and the caller decides when to call it again.
 *
 * Semantics kept from the original:
 *
 *  - one request per *distinct* request name, not per widget — screens commonly
 *    carry 37 displays over a handful of requests, and one in the database has
 *    169 widgets — 168 displays and one input — fed by just 2 polled requests, so
 *    the naive approach would multiply bus traffic by two orders of magnitude;
 *  - **only displays are polled.** Inputs are filled in as a side effect: when a
 *    display decodes data name X, any input bound to X takes that value
 *    (`param_widget.py:1204-1220`). An input whose data name no display fetches
 *    simply stays empty — it is never requested on its own account, and must not
 *    be shown as NO DATA;
 *  - a display whose data name is absent from its request's *receive* items is
 *    dropped by `prepareLayout`, so it never reaches here;
 *  - `manualsend` requests are never polled, only fired from a button;
 *  - `presend` entries run in order, each preceded by its own `Delay`;
 *  - a display that decodes to `null` shows as **NO DATA**, not as blank.
 */

import { buildDataStream, decodeStream, formatRequestStream, type BoundRequest } from "@ddtx/codec";
import type { LoadedEcu, PreparedButton, PreparedScreen, PreparedWidget } from "@ddtx/db";
import { negativeResponse, type EcuLink } from "@ddtx/link";

/** What the original renders as a red "NO DATA" cell. */
export const NO_DATA = "NO DATA";

export type ValueStatus =
  /** Decoded normally. */
  | "ok"
  /** The response was too short, or unusable, for this field. */
  | "no-data"
  /** The ECU refused the request this field belongs to. */
  | "rejected"
  /** The link failed. */
  | "error";

export interface WidgetValue {
  /** Display text. `null` when there is nothing to show. */
  value: string | null;
  status: ValueStatus;
  /** Set when `status` is `rejected` or `error`. */
  detail?: string;
}

export interface ScreenSnapshot {
  /** Keyed by `PreparedWidget.id`. */
  values: Map<string, WidgetValue>;
  /** One entry per request actually issued, in issue order. */
  exchanges: Exchange[];
  elapsedMs: number;
}

export interface Exchange {
  requestName: string;
  sent: string;
  received: string;
  rejected?: { code: string; message: string };
  error?: string;
  elapsedMs: number;
}

/**
 * Values the operator has typed, ready to be written into a request.
 *
 * Scoped by **request name and data name together**, matching the original's
 * `inputdict[requestName].getDataByName(dataName)`. An input widget belongs to one
 * request and contributes to that request only — the same data name under a
 * different request is a different field.
 */
export interface InputValues {
  get(requestName: string, dataName: string): string | undefined;
}

/** Build an {@link InputValues} from a flat map keyed `request\u0000dataName`. */
export function inputValuesFrom(entries: ReadonlyMap<string, string>): InputValues {
  return {
    get: (requestName, dataName) => entries.get(`${requestName}\u0000${dataName}`),
  };
}

/** Why a button press did not happen, when it didn't. */
export interface ButtonRefusal {
  requestName: string;
  /** The data name whose value would not encode. */
  field: string;
}

export interface ButtonResult {
  exchanges: Exchange[];
  /**
   * Set when a value would not encode. **Nothing was sent** — the original aborts
   * the whole sequence rather than sending a partly-filled frame
   * (`param_widget.py:993`), which on a write is the only safe choice.
   */
  refused?: ButtonRefusal;
}

export interface ScreenRuntimeOptions {
  /**
   * Diagnostic session command to send before anything else, e.g. `"10C0"`.
   * `startDiagnosticSession` in the original; omit to skip it.
   */
  sessionCommand?: string;
  /** Injected for tests, and so a UI can cancel a pending delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock, injected for deterministic tests. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class ScreenRuntime {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly sessionCommand: string | undefined;

  /**
   * The requests this screen polls: distinct, in first-appearance order, with
   * `manualsend` ones excluded, each paired with the **displays** it feeds.
   */
  readonly plan: ReadonlyArray<{ request: BoundRequest; widgets: PreparedWidget[] }>;

  /** Widgets with no value to fetch. Rendered, never polled. */
  readonly decorations: readonly PreparedWidget[];

  /** Displays whose request is `manualsend`, so they only update after a button. */
  readonly manualOnly: readonly PreparedWidget[];

  /** Inputs, indexed by the data name whose decoded value fills them. */
  private readonly inputsByData = new Map<string, PreparedWidget[]>();

  constructor(
    readonly ecu: LoadedEcu,
    readonly screen: PreparedScreen,
    private readonly link: EcuLink,
    options: ScreenRuntimeOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.sessionCommand = options.sessionCommand;

    const plan: Array<{ request: BoundRequest; widgets: PreparedWidget[] }> = [];
    const byName = new Map<string, { request: BoundRequest; widgets: PreparedWidget[] }>();
    const decorations: PreparedWidget[] = [];
    const manualOnly: PreparedWidget[] = [];

    for (const widget of screen.widgets) {
      if (widget.dataName === null) {
        decorations.push(widget);
        continue;
      }

      // Inputs are never polled; they take whatever a display decodes for the
      // same data name.
      if (widget.kind === "input") {
        const siblings = this.inputsByData.get(widget.dataName);
        if (siblings === undefined) this.inputsByData.set(widget.dataName, [widget]);
        else siblings.push(widget);
        continue;
      }

      const request = ecu.requests.get(widget.request);
      // prepareLayout already guaranteed this resolves.
      if (request === undefined) continue;

      if (request.def.manualsend === true) {
        manualOnly.push(widget);
        continue;
      }

      const existing = byName.get(widget.request);
      if (existing === undefined) {
        const entry = { request, widgets: [widget] };
        byName.set(widget.request, entry);
        plan.push(entry);
      } else {
        existing.widgets.push(widget);
      }
    }

    this.plan = plan;
    this.decorations = decorations;
    this.manualOnly = manualOnly;
  }

  /**
   * Fire the screen's `presend` entries, each after its own delay.
   *
   * The original runs these only when auto-refresh is off, on the reasoning that
   * a repeating poll keeps the ECU in the right state anyway. That coupling is
   * left to the caller: call this on entry, and again after a manual refresh if
   * you are not polling.
   */
  async runPresend(): Promise<Exchange[]> {
    const exchanges: Exchange[] = [];
    for (const entry of this.screen.presend) {
      await this.sleep(Number.parseFloat(entry.Delay) || 0);
      const request = this.ecu.requests.get(entry.RequestName);
      if (request === undefined) continue;
      exchanges.push(await this.send(request));
    }
    return exchanges;
  }

  /** Read every polled request once and decode its fields onto widgets. */
  async refresh(): Promise<ScreenSnapshot> {
    const started = this.now();
    const values = new Map<string, WidgetValue>();
    const exchanges: Exchange[] = [];

    // The L2 response cache would otherwise serve the previous refresh's
    // answers; `ELM.clear_cache` exists for exactly this.
    this.link.clearCache();

    if (this.sessionCommand !== undefined) {
      exchanges.push(await this.sendRaw(this.sessionCommand, "«session»"));
    }

    for (const { request, widgets } of this.plan) {
      const exchange = await this.send(request);
      exchanges.push(exchange);

      if (exchange.error !== undefined) {
        for (const widget of widgets) {
          values.set(widget.id, { value: null, status: "error", detail: exchange.error });
        }
        continue;
      }
      if (exchange.rejected !== undefined) {
        for (const widget of widgets) {
          values.set(widget.id, {
            value: null,
            status: "rejected",
            detail: `${exchange.rejected.code} ${exchange.rejected.message}`,
          });
        }
        continue;
      }

      // Decode the whole request once; a request's fields are shared between
      // however many widgets reference them.
      const decoded = decodeStream(request, exchange.received);
      for (const widget of widgets) {
        const decodedValue = widget.dataName === null ? null : decoded[widget.dataName];
        values.set(
          widget.id,
          decodedValue === null || decodedValue === undefined
            ? { value: NO_DATA, status: "no-data" }
            : { value: decodedValue, status: "ok" },
        );
      }

      // Pre-fill inputs that share a data name with anything just decoded,
      // whatever request the input itself names.
      for (const [dataName, decodedValue] of Object.entries(decoded)) {
        if (decodedValue === null) continue;
        for (const input of this.inputsByData.get(dataName) ?? []) {
          values.set(input.id, { value: decodedValue, status: "ok" });
        }
      }
    }

    // Widgets that are never polled still need an entry, so the UI can render
    // them settled rather than perpetually loading. Blank, not NO DATA — there
    // was no failed read, only nothing that reads them.
    for (const widget of this.decorations) {
      values.set(widget.id, { value: null, status: "ok" });
    }
    for (const widget of this.manualOnly) {
      if (!values.has(widget.id)) values.set(widget.id, { value: null, status: "ok" });
    }
    for (const inputs of this.inputsByData.values()) {
      for (const input of inputs) {
        if (!values.has(input.id)) values.set(input.id, { value: null, status: "ok" });
      }
    }

    return { values, exchanges, elapsedMs: this.now() - started };
  }

  /**
   * Fire a button's requests in order, each after its delay.
   *
   * With `inputs`, every request's send fields are filled from what the operator
   * typed. Any field left unsupplied keeps the value already in `sentbytes` — see
   * `buildDataStream`.
   *
   * **Every stream is built before anything is sent.** A value that will not
   * encode aborts the whole sequence, because a button often fires several
   * requests in order and sending the first few before discovering the third is
   * malformed would leave the ECU part-way through a change.
   */
  async pressButton(button: PreparedButton, inputs?: InputValues): Promise<ButtonResult> {
    const planned: Array<{ request: BoundRequest; delayMs: number; stream: string[] }> = [];

    for (const entry of button.send) {
      const request = this.ecu.requests.get(entry.RequestName);
      if (request === undefined) continue;

      const supplied: Record<string, string> = {};
      if (inputs !== undefined) {
        for (const dataName of Object.keys(request.def.sendbyte_dataitems ?? {})) {
          const value = inputs.get(entry.RequestName, dataName);
          if (value !== undefined) supplied[dataName] = value;
        }
      }

      const built = buildDataStream(request, supplied);
      if (!built.ok) {
        return { exchanges: [], refused: { requestName: entry.RequestName, field: built.field } };
      }
      planned.push({ request, delayMs: Number.parseFloat(entry.Delay) || 0, stream: built.stream });
    }

    const exchanges: Exchange[] = [];
    for (const { request, delayMs, stream } of planned) {
      await this.sleep(delayMs);
      exchanges.push(await this.send(request, stream));
    }
    return { exchanges };
  }

  private async send(request: BoundRequest, stream?: readonly string[]): Promise<Exchange> {
    const frame = formatRequestStream(
      stream ?? (request.def.sentbytes ?? "").match(/.{1,2}/g) ?? [],
    );
    return this.sendRaw(frame, request.def.name);
  }

  private async sendRaw(frame: string, requestName: string): Promise<Exchange> {
    const started = this.now();
    try {
      const received = await this.link.request(frame, { requestName });
      const rejected = negativeResponse(received);
      return {
        requestName,
        sent: frame,
        received,
        ...(rejected === null ? {} : { rejected }),
        elapsedMs: this.now() - started,
      };
    } catch (cause) {
      return {
        requestName,
        sent: frame,
        received: "",
        error: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: this.now() - started,
      };
    }
  }
}

/**
 * The keepalive frame for this ECU, or `null` if it doesn't need one.
 *
 * CAN ECUs get `3E` (tester present) every 1.5 s while a screen is open, unless
 * the database names a request of its own for the purpose — mirroring the search
 * for a request with both "tester" and "present" in its name.
 */
export function testerPresentFrame(ecu: LoadedEcu): string | null {
  if (ecu.def.obd.protocol.toUpperCase() !== "CAN") return null;

  for (const [name, request] of ecu.requests) {
    const lowered = name.toLowerCase();
    if (lowered.includes("tester") && lowered.includes("present")) {
      const bytes = request.def.sentbytes;
      if (bytes !== undefined && bytes.length > 0) return bytes;
    }
  }
  return "3E";
}

/** The original's keepalive period. */
export const TESTER_PRESENT_INTERVAL_MS = 1500;
