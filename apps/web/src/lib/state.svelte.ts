/**
 * Application state.
 *
 * One module, because the app has exactly one thing selected at a time: a
 * database, an ECU, a screen. Splitting that across stores would add indirection
 * without adding capability.
 *
 * Deliberately no reactive wrapper around the domain objects. `EcuDatabase`,
 * `ScreenRuntime`, and `SimulatedLink` hold internal caches and `this`-bound
 * methods that a `$state` Proxy would interfere with, so they live in plain
 * variables and the UI reacts to explicit snapshots instead.
 */

import { projectLabel } from "@ddtx/core";
import { Overlay, type Namespace } from "@ddtx/i18n";
import {
  EcuDatabase,
  type EcuSummary,
  type PreparedLayout,
  type PreparedScreen,
  type PreparedWidget,
} from "@ddtx/db";
import { SimulatedLink, type EcuLink, type FillMode } from "@ddtx/link";
import {
  CANDIDATE_BAUD_RATES,
  ElmDriver,
  ElmLink,
  WebSerialTransport,
  type AdapterInfo,
  type WebSerialPortLike,
} from "@ddtx/elm";
import {
  attachEcu,
  checkWriteGates,
  scanAll,
  type ProbeResult,
  confirmationPrompt,
  describeAttachment,
  isReachable,
  withAdapterLock,
  type GateDecision,
  clearDtcs,
  readDtcs,
  simulatedDtcLink,
  dtcClearRequestName,
  dtcReadRequestName,
  type DtcLink,
  type DtcReadResult,
} from "@ddtx/session";
import {
  inputValuesFrom,
  ScreenRuntime,
  type Exchange,
  type ScreenSnapshot,
  testerPresentFrame,
} from "@ddtx/screens";
import type { LoadedEcu } from "@ddtx/db";
import {
  grantFolder,
  importArchive,
  installedManifest,
  pickFolder,
  removeInstalledTree,
  resolveSavedSource,
  storageUsage,
  useRemote,
  type ImportProgress,
  type ResolvedSource,
} from "./dbInstall.js";
import type { TreeManifest } from "./dbImport.worker.js";
import { clearFolderHandle, saveRemoteUrl, type DbSourceKind } from "./installStorage.js";

/**
 * `needs-database` is not an error state. It is the ordinary first run: no tree has
 * been installed yet, and the answer is a picker rather than a stack trace.
 */
export type Phase = "idle" | "loading" | "needs-database" | "ready" | "error";

interface AppState {
  phase: Phase;
  error: string | null;

  /** Where the database is being read from, for the status strip and settings. */
  dbSource: { kind: DbSourceKind; label: string } | null;
  /** Set when a remembered folder needs its permission re-granted by a click. */
  folderNeedsPermission: boolean;
  /** Non-null while an archive is being checked or unpacked. */
  importProgress: ImportProgress | null;
  importError: string | null;
  /** What the last import produced, so settings can show what is installed. */
  installed: TreeManifest | null;
  settingsOpen: boolean;
  storage: { usage: number; quota: number } | null;

  /** Index facts, copied out so the UI doesn't reach into the database object. */
  ecuCount: number;
  protocols: string[];
  /**
   * Vehicles, labelled with the model name rather than the project code, sorted
   * by that label. The code stays the value — it is what the index matches on.
   */
  vehicles: Facet[];
  /**
   * Groups available for the selected vehicle, with counts. Narrowed as the
   * vehicle changes, because picking a car should shorten the list of systems
   * rather than leave 171 of them on offer.
   */
  groups: Facet[];

  /** Catalogue filters. */
  group: string;
  protocol: string;
  project: string;
  results: EcuSummary[];
  /** Results are capped for render; this is the count before capping. */
  resultTotal: number;

  selected: EcuSummary | null;
  ecuPhase: Phase;
  categories: PreparedLayout["categories"];
  layoutWarnings: number;
  requestCount: number;
  dataCount: number;
  testerPresent: string | null;

  screen: PreparedScreen | null;
  snapshot: ScreenSnapshot | null;
  refreshing: boolean;

  /** Demo settings. */
  fill: FillMode;
  drift: boolean;
  autoRefresh: boolean;
  /** Draw widget bounds and the caption/value split over the canvas. */
  inspect: boolean;
  /**
   * Render scale as a percentage of the Qt app's native size, or `"fit"` to
   * shrink the canvas to the available width. 100% is `uiscale = 8`.
   */
  zoom: number | "fit";
  /**
   * Is the catalogue open? Once an ECU is picked the catalogue has done its job,
   * and 288px is worth more to the canvas — so it collapses to a rail. Kept in
   * `localStorage` because reopening it on every reload is a small, repeated
   * annoyance in a tool you keep refreshing.
   */
  catalogueOpen: boolean;
  /**
   * Is the bus trace open? Closed by default: it answers "is this screen actually
   * talking to the ECU", which is a question you ask occasionally, not a thing to
   * watch — and the canvas is worth the third of the height it was taking.
   */
  traceOpen: boolean;
  /** `"fr"` shows the database as authored; any other locale applies an overlay. */
  locale: string;
  /** Entries in the loaded overlay, for the strip's coverage readout. */
  overlaySize: number;
  /**
   * Bumped whenever the overlay changes or is re-primed.
   *
   * `t()` lives in module scope, so Svelte cannot see it as a dependency — a
   * template calling `t(...)` would keep showing the old language until something
   * else invalidated it. Reading this counter inside `t()` gives the compiler the
   * dependency it needs.
   */
  overlayVersion: number;
  /** Outline strings that fell through to French, to make gaps findable. */
  showUntranslated: boolean;

  /** Web Serial is Chromium-desktop only; this is false everywhere else. */
  serialSupported: boolean;
  /**
   * Which link the screens are actually running through.
   *
   * A reactive fact rather than something the UI asks a function for. It used to
   * be `$derived(isLive())`, which reads the driver from module scope — Svelte
   * cannot see that, so the strip kept saying "Demo" with a vehicle attached.
   * Given that this indicator's whole job is to be true, it must not depend on a
   * variable the compiler cannot track.
   */
  linkKind: "simulated" | "elm";
  connection: "idle" | "connecting" | "connected" | "error";
  /** Status line for the strip. */
  connectionMessage: string;
  adapter: AdapterInfo | null;
  /** How this ECU is addressed once attached, for the header. */
  attachment: string | null;
  /**
   * Has the operator turned writing on?
   *
   * Off by default and never remembered. A browser tab can be backgrounded,
   * duplicated, or closed mid-write, none of which the Qt app has to survive, so
   * enabling writes is a decision made per session rather than a preference
   * (docs/plan.md §6.3).
   */
  writesEnabled: boolean;
  /** Last refusal, so the reason is visible rather than a dead button. */
  lastRefusal: string | null;
  /**
   * Result of the in-app link measurement, when it has been run.
   *
   * The CLI measures the same thing over Node's `serialport`; this measures it
   * over **Web Serial**, which is a different path — Chrome's serial service and
   * an IPC hop the CLI does not have. The two numbers together separate "this
   * hardware is slow" from "the browser adds cost", and only the browser number
   * describes what the app will actually do.
   */
  linkBench: string | null;
  benching: boolean;

  /**
   * What the operator has typed, keyed `requestName\u0000dataName`.
   *
   * Scoped by request *and* data name because that is what the write path uses: an
   * input belongs to one request, and the same data name under another request is a
   * different field.
   *
   * Cleared when the screen changes — a value typed for one screen has no meaning
   * on the next, and carrying it silently would be worse than losing it.
   */
  edits: Map<string, string>;
  /** Data name a value could not be encoded for, so the box can be marked. */
  badField: string | null;
  /**
   * Exchanges from the last button press.
   *
   * Kept separate from the refresh snapshot because a press is followed by a
   * refresh, and the refresh replaces the snapshot — so without this the trace
   * would show only the reads that came *after* the write, and what the button
   * actually sent would be invisible. On a write that is the one thing worth
   * seeing.
   */
  actionExchanges: Exchange[];
  /** Which button produced them. */
  actionLabel: string | null;

  /** Live sweep state, when one is running or has finished. */
  scanning: boolean;
  scanProgress: { done: number; total: number } | null;
  /** Only the addresses that answered — the point of a sweep. */
  scanFound: ProbeResult[];
  scanSummary: string | null;

  /** Stored fault codes, once read. Null means "not asked yet". */
  dtc: DtcReadResult | null;
  /**
   * The name of this ECU's fault-reading request, or null when it has none.
   *
   * Reactive state rather than a `supportsDtcRead(ecu)` call from a template: `ecu`
   * lives in module scope, so a derived value reading it never re-runs when it
   * changes. Three bugs of that exact shape are recorded in docs/plan.md §7.
   */
  dtcRequest: string | null;
  dtcReading: boolean;
  dtcClearing: boolean;
  /** A read that went wrong. Cleared whenever a read starts. */
  dtcNotice: string | null;
  /**
   * What happened on the last erase, kept in its own field on purpose.
   *
   * An erase is followed by a re-read to confirm it, and a re-read clears
   * `dtcNotice` — so sharing one field means the outcome of the irreversible action
   * is wiped by the step that verifies it, leaving no trace that anything happened.
   */
  dtcClearNotice: string | null;
}

const CATALOGUE_KEY = "ddtx.catalogueOpen";
const TRACE_KEY = "ddtx.traceOpen";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    return stored === null || stored === undefined ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    /* private mode, or storage disabled — the toggle still works this session */
  }
}

/** A filter option: the value the index matches on, plus what to show. */
export interface Facet {
  value: string;
  label: string;
  count: number;
}

const RESULT_CAP = 400;

export const app = $state<AppState>({
  phase: "idle",
  error: null,
  dbSource: null,
  folderNeedsPermission: false,
  importProgress: null,
  importError: null,
  installed: null,
  settingsOpen: false,
  storage: null,
  ecuCount: 0,
  protocols: [],
  vehicles: [],
  groups: [],
  group: "",
  protocol: "",
  project: "",
  results: [],
  resultTotal: 0,
  selected: null,
  ecuPhase: "idle",
  categories: [],
  layoutWarnings: 0,
  requestCount: 0,
  dataCount: 0,
  testerPresent: null,
  screen: null,
  snapshot: null,
  refreshing: false,
  fill: "pad",
  drift: false,
  autoRefresh: false,
  inspect: false,
  zoom: 100,
  catalogueOpen: readFlag(CATALOGUE_KEY, true),
  traceOpen: readFlag(TRACE_KEY, false),
  locale: "fr",
  overlaySize: 0,
  overlayVersion: 0,
  showUntranslated: false,
  serialSupported: typeof navigator !== "undefined" && "serial" in navigator,
  linkKind: "simulated",
  connection: "idle",
  connectionMessage: "Not connected",
  adapter: null,
  attachment: null,
  writesEnabled: false,
  lastRefusal: null,
  linkBench: null,
  benching: false,
  edits: new Map(),
  badField: null,
  actionExchanges: [],
  actionLabel: null,
  scanning: false,
  scanProgress: null,
  scanFound: [],
  scanSummary: null,
  dtc: null,
  dtcRequest: null,
  dtcReading: false,
  dtcClearing: false,
  dtcNotice: null,
  dtcClearNotice: null,
});

export function setCatalogueOpen(open: boolean): void {
  app.catalogueOpen = open;
  writeFlag(CATALOGUE_KEY, open);
}

export function setTraceOpen(open: boolean): void {
  app.traceOpen = open;
  writeFlag(TRACE_KEY, open);
}

let database: EcuDatabase | null = null;
let ecu: LoadedEcu | null = null;
let layout: PreparedLayout | null = null;
let runtime: ScreenRuntime | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let overlay = Overlay.none();

/**
 * Which selection is current.
 *
 * Bumped on every `selectEcu`, and checked again after each await inside it. Two
 * fetches plus overlay priming means a slow earlier selection can finish *after* a
 * newer one — and without this guard its request and value counts would overwrite
 * the ECU actually on screen, leaving the header permanently describing something
 * else.
 */
let selectionToken = 0;

/**
 * The live driver, when a vehicle is attached.
 *
 * Plain variables rather than `$state`: `ElmDriver` and the transport hold
 * `this`-bound methods and internal buffers that a Proxy would interfere with.
 */
let driver: ElmDriver | null = null;
let transport: WebSerialTransport | null = null;

/**
 * Is a real vehicle on the other end?
 *
 * The reactive field is read **first**, deliberately. Written the other way round
 * — `driver !== null && app.linkKind === "elm"` — JavaScript short-circuits on the
 * null driver and never reads the reactive value, so nothing that calls this from
 * a template ever gets invalidated when a vehicle is attached. That is exactly how
 * the ECU buttons stayed unmarked while `pressButton` was refusing them.
 *
 * `driver` is still checked, so the answer cannot be true without one.
 */
export function isLive(): boolean {
  return app.linkKind === "elm" && driver !== null;
}

/**
 * Translate a database string for display.
 *
 * The single render-boundary entry point. Reference resolution never goes through
 * here — `prepareLayout`, the codec, and the link all work on the raw strings, so
 * a translated caption can never be used as a lookup key.
 */
export function t(namespace: Namespace, source: string): string {
  // Registers the dependency; the value itself is not used.
  void app.overlayVersion;
  return overlay.t(namespace, source, {
    ...(app.selected === null ? {} : { ecu: app.selected.slug, group: app.selected.group }),
  });
}

/** Did this string fall through untranslated? Drives the dev-mode outline. */
export function untranslated(namespace: Namespace, source: string): boolean {
  void app.overlayVersion;
  if (!app.showUntranslated || app.locale === "fr") return false;
  return overlay.isUntranslated(namespace, source, {
    ...(app.selected === null ? {} : { ecu: app.selected.slug, group: app.selected.group }),
  });
}

export async function setLocale(locale: string): Promise<void> {
  app.locale = locale;
  if (locale === "fr") {
    overlay = Overlay.none();
    app.overlaySize = 0;
  } else {
    try {
      const response = await fetch(`/i18n/${locale}/bundle.json`);
      overlay = response.ok
        ? Overlay.create(locale, (await response.json()) as Record<string, string>)
        : Overlay.none();
    } catch {
      overlay = Overlay.none();
    }
    app.overlaySize = overlay.size;
  }
  await primeOverlay();
  app.overlayVersion += 1;
}

/**
 * Hash every string the open ECU could display, so `t()` can be synchronous.
 *
 * Done per ECU rather than globally: the whole database is 509k distinct strings
 * and hashing them all up front would cost far more than it saves.
 */
async function primeOverlay(): Promise<void> {
  if (ecu === null || app.locale === "fr") return;
  const sources: string[] = [];
  for (const [name, data] of ecu.data) {
    sources.push(name);
    if (data.unit !== "") sources.push(data.unit);
    if (data.comment !== "") sources.push(data.comment);
    for (const label of data.lists.values()) sources.push(label);
  }
  for (const name of ecu.requests.keys()) sources.push(name);
  for (const device of ecu.def.devices ?? []) {
    sources.push(device.name);
    for (const flag of Object.keys(device.devicedata ?? {})) sources.push(flag);
  }
  if (layout !== null) {
    for (const category of layout.categories) {
      sources.push(category.name);
      for (const screen of category.screens) sources.push(screen);
    }
    for (const screen of layout.screens.values()) {
      sources.push(screen.name);
      for (const label of screen.labels) sources.push(label.text);
      for (const button of screen.buttons) {
        sources.push(button.text);
        for (const message of button.messages) sources.push(message);
      }
    }
  }
  await overlay.prime(sources);
  app.overlayVersion += 1;
}

/** The loaded ECU, for components that need data definitions (units, comments). */
export function currentEcu(): LoadedEcu | null {
  return ecu;
}

export async function openDatabase(): Promise<void> {
  app.phase = "loading";
  app.error = null;
  try {
    const resolved = await resolveSavedSource();

    if (resolved === null) {
      // First run, or the remembered source is gone. Not an error — offer the picker.
      app.phase = "needs-database";
      app.dbSource = null;
      return;
    }
    if ("needsPermission" in resolved) {
      // The handle survived the reload but its permission did not, and
      // `requestPermission` only works inside a user gesture. So the UI has to ask.
      app.phase = "needs-database";
      app.folderNeedsPermission = true;
      pendingFolder = resolved.needsPermission;
      return;
    }

    await useSource(resolved.ok);
  } catch (cause) {
    app.phase = "error";
    app.error = cause instanceof Error ? cause.message : String(cause);
  }
}

/** The folder whose permission lapsed, held until a click can re-request it. */
let pendingFolder: FileSystemDirectoryHandle | null = null;

/** Open a resolved source and populate the index facets from it. */
async function useSource(resolved: ResolvedSource): Promise<void> {
  database = await EcuDatabase.open(resolved.source);
  app.dbSource = { kind: resolved.kind, label: resolved.label };
  app.folderNeedsPermission = false;
  app.ecuCount = database.size;
  app.protocols = [...database.protocols];
  app.vehicles = buildVehicles(database);
  app.phase = "ready";
  app.error = null;
  applyFilters();
}

/** Unpack `ecu.zip` into the browser's own storage, then open it. */
export async function installArchive(file: File): Promise<void> {
  app.importError = null;
  // Starts as "hashing", not "unpacking": the archive is checked against what is
  // already installed first, and claiming to unpack during that is a label the user
  // can catch out when the same archive is then skipped instantly.
  app.importProgress = { phase: "hashing", done: 0, total: 0, bytesOut: 0 };
  try {
    const outcome = await importArchive(file, (progress) => {
      app.importProgress = progress;
    });
    app.installed = outcome.manifest;
    const resolved = await resolveSavedSource();
    if (resolved !== null && "ok" in resolved) await useSource(resolved.ok);
    else throw new Error("the archive unpacked but the tree could not be opened");
  } catch (cause) {
    app.importError = cause instanceof Error ? cause.message : String(cause);
  } finally {
    app.importProgress = null;
  }
}

/** Point at an already-split tree in a folder on disk. Must be called from a click. */
export async function chooseFolder(): Promise<void> {
  app.importError = null;
  const resolved = await pickFolder();
  if (resolved === null) return;
  try {
    await useSource(resolved);
  } catch (cause) {
    app.importError =
      `That folder does not look like a split tree — ` +
      `${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/** Re-grant the remembered folder's permission. Must be called from a click. */
export async function continueWithFolder(): Promise<void> {
  if (pendingFolder === null) return;
  const resolved = await grantFolder(pendingFolder);
  if (resolved === null) {
    app.importError = "Permission was not granted, so that folder cannot be read.";
    return;
  }
  await useSource(resolved);
}

/** Read the tree over HTTP — a static host, or the dev server. */
export async function chooseRemote(url: string): Promise<void> {
  app.importError = null;
  saveRemoteUrl(url);
  try {
    await useSource(useRemote(url));
  } catch (cause) {
    app.importError = `Nothing readable at that URL — ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}

export function setSettingsOpen(open: boolean): void {
  app.settingsOpen = open;
  if (open) void refreshStorage();
}

async function refreshStorage(): Promise<void> {
  app.storage = await storageUsage();
  app.installed = await installedManifest();
}

/** Delete the installed tree and go back to the picker. */
export async function forgetDatabase(): Promise<void> {
  await removeInstalledTree();
  await clearFolderHandle();
  database = null;
  ecu = null;
  layout = null;
  runtime = null;
  app.installed = null;
  app.dbSource = null;
  app.selected = null;
  app.screen = null;
  app.snapshot = null;
  app.categories = [];
  app.results = [];
  app.settingsOpen = false;
  app.phase = "needs-database";
}

/** Every vehicle in the index, named and counted, ordered by model name. */
function buildVehicles(db: EcuDatabase): Facet[] {
  const counts = new Map<string, number>();
  for (const summary of db.list()) {
    for (const code of summary.projects) {
      if (code === "" || code.startsWith("#")) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: projectLabel(value), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Groups present among the ECUs the current vehicle admits.
 *
 * Deliberately ignores the group filter itself: a dropdown that removed its own
 * current value would fight the user.
 */
function buildGroups(db: EcuDatabase): Facet[] {
  const counts = new Map<string, number>();
  for (const summary of db.list(app.project === "" ? {} : { project: app.project })) {
    if (summary.group === "") continue;
    counts.set(summary.group, (counts.get(summary.group) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Re-derive the group list after a vehicle change, dropping a group the new
 * vehicle doesn't have rather than silently returning no results.
 */
export function selectVehicle(code: string): void {
  app.project = code;
  app.groups = database === null ? [] : buildGroups(database);
  if (app.group !== "" && !app.groups.some((g) => g.value === app.group)) app.group = "";
  applyFilters();
}

export function applyFilters(): void {
  if (database === null) return;
  if (app.groups.length === 0) app.groups = buildGroups(database);
  const all = database.list({
    ...(app.group === "" ? {} : { group: app.group }),
    ...(app.protocol === "" ? {} : { protocol: app.protocol }),
    ...(app.project === "" ? {} : { project: app.project }),
  });
  app.resultTotal = all.length;
  app.results = all.slice(0, RESULT_CAP);
}

export async function selectEcu(summary: EcuSummary): Promise<void> {
  if (database === null) return;
  const token = ++selectionToken;
  stopAutoRefresh();
  app.selected = summary;
  app.ecuPhase = "loading";
  app.screen = null;
  app.snapshot = null;
  runtime = null;
  // Cleared, not left behind: the header must not assert "0 requests" while the
  // definitions are still in flight, nor show the previous ECU's totals.
  app.categories = [];
  app.layoutWarnings = 0;
  app.requestCount = 0;
  app.dataCount = 0;
  app.testerPresent = null;
  // One ECU's faults must never be read as another's.
  app.dtc = null;
  app.dtcNotice = null;
  app.dtcClearNotice = null;
  app.dtcRequest = null;
  simulated = null;

  try {
    const loadedEcu = await database.loadEcu(summary.slug);
    const loadedLayout = await database.loadLayout(summary.slug);
    // Someone selected a different ECU while these were in flight; that
    // selection owns the state now.
    if (token !== selectionToken) return;

    ecu = loadedEcu;
    layout = loadedLayout;
    app.categories = loadedLayout.categories;
    app.layoutWarnings = loadedLayout.warnings.length;
    app.requestCount = loadedEcu.requests.size;
    app.dataCount = loadedEcu.data.size;
    app.testerPresent = testerPresentFrame(loadedEcu);
    app.dtcRequest = dtcReadRequestName(loadedEcu) ?? null;
    await primeOverlay();
    if (token !== selectionToken) return;
    app.ecuPhase = "ready";
  } catch (cause) {
    if (token !== selectionToken) return;
    app.ecuPhase = "error";
    app.error = cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Ask for a port and bring up the adapter.
 *
 * Must be called from a click: `requestPort()` needs a user gesture, which is why
 * the browser cannot enumerate ports on its own the way the CLI can.
 *
 * Baud rates are tried in the order `ELM.__init__` tries them, because an ELM327
 * clone's rate is whatever it was last set to and there is no way to ask.
 */
export async function connect(): Promise<void> {
  const serial = (
    navigator as unknown as { serial?: { requestPort(): Promise<WebSerialPortLike> } }
  ).serial;
  if (serial === undefined) {
    app.connection = "error";
    app.connectionMessage = "This browser has no Web Serial. Use Chrome or Edge on desktop.";
    return;
  }

  app.connection = "connecting";
  app.connectionMessage = "Choosing a port…";
  app.lastRefusal = null;

  let port: WebSerialPortLike;
  try {
    port = await serial.requestPort();
  } catch {
    // The operator dismissed the picker; that is not an error worth shouting.
    app.connection = "idle";
    app.connectionMessage = "Not connected";
    return;
  }

  for (const baudRate of CANDIDATE_BAUD_RATES) {
    app.connectionMessage = `Trying ${baudRate} baud…`;
    const candidate = new WebSerialTransport(port, { baudRate }, `Web Serial @ ${baudRate}`);
    try {
      await candidate.open();
      const candidateDriver = new ElmDriver(candidate);
      const info = await candidateDriver.identify();

      // An adapter at the wrong baud answers noise, not a version string.
      if (info.version === "unknown") {
        await candidate.close();
        continue;
      }

      transport = candidate;
      driver = candidateDriver;
      app.adapter = info;
      app.linkKind = "elm";
      app.connection = "connected";
      app.connectionMessage = `${info.version} at ${baudRate} baud · ${candidateDriver.canStrategy}`;
      // Re-open the current screen through the real link.
      await reopenCurrentScreen();
      return;
    } catch (cause) {
      await candidate.close().catch(() => undefined);
      app.connectionMessage = cause instanceof Error ? cause.message : String(cause);
    }
  }

  app.connection = "error";
  app.connectionMessage = "No ELM327 answered on that port at any baud rate.";
}

/**
 * Measure the round-trip floor over Web Serial.
 *
 * `AT` is the probe because the adapter answers it from firmware — no bus is
 * involved, so this isolates the host↔adapter path and works with the vehicle
 * unplugged. What matters is the shape: a tight distribution means a fixed floor,
 * a long tail means something is stalling, and a p50 near a multiple of 16 ms
 * means a driver latency timer is pacing every exchange (docs/protocols.md §2.4).
 */
export async function benchLink(iterations = 200): Promise<void> {
  const active = driver;
  if (active === null || app.benching) return;

  app.benching = true;
  app.linkBench = "Measuring…";
  try {
    // Discard a warm-up: the first exchange after an idle period is routinely an
    // outlier and would dominate the max.
    for (let i = 0; i < 3; i++) await active.sendRaw("AT");

    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      await active.sendRaw("AT");
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    const at = (fraction: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(fraction * samples.length))] ?? 0;
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const sd = Math.sqrt(
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length,
    );
    const stalls = samples.filter((value) => value > 50).length;

    app.linkBench =
      `n=${samples.length}  min ${(samples[0] ?? 0).toFixed(1)}  p50 ${at(0.5).toFixed(1)}  ` +
      `p90 ${at(0.9).toFixed(1)}  p99 ${at(0.99).toFixed(1)}  max ${(samples.at(-1) ?? 0).toFixed(1)} ms  ` +
      `· sd ${sd.toFixed(1)}  · over 50 ms: ${stalls}`;
  } catch (cause) {
    app.linkBench = cause instanceof Error ? cause.message : String(cause);
  } finally {
    app.benching = false;
  }
}

let scanSignal: { aborted: boolean } | null = null;

/**
 * Sweep the bus for ECUs that are actually fitted.
 *
 * Restricted to the selected vehicle when there is one: that turns 130-odd
 * addresses into a few dozen, and each address that answers nothing still costs an
 * init attempt — which on K-line is a 5-baud handshake, not a cheap re-header.
 */
export async function startScan(): Promise<void> {
  const active = driver;
  if (active === null || database === null || app.scanning) return;

  const signal = { aborted: false };
  scanSignal = signal;
  app.scanning = true;
  app.scanFound = [];
  app.scanSummary = null;
  app.scanProgress = { done: 0, total: 0 };

  try {
    const report = await scanAll(active, database.index, {
      ...(app.project === "" ? {} : { project: app.project }),
      signal,
      onProgress: (done, total, result) => {
        app.scanProgress = { done, total };
        if (result.outcome === "identified" || result.outcome === "unknown-ecu") {
          app.scanFound = [...app.scanFound, result];
        }
      },
    });
    app.scanSummary =
      `${report.found.length} of ${report.addressesProbed} addresses answered in ` +
      `${(report.elapsedMs / 1000).toFixed(1)} s${report.cancelled ? " (stopped)" : ""}`;
  } catch (cause) {
    app.scanSummary = cause instanceof Error ? cause.message : String(cause);
  } finally {
    app.scanning = false;
    app.scanProgress = null;
    scanSignal = null;
    // The sweep closed the protocol, so the open screen's ECU must be re-attached
    // before anything is read again.
    const name = app.screen?.name;
    if (name !== undefined) await openScreen(name);
  }
}

export function stopScan(): void {
  if (scanSignal !== null) scanSignal.aborted = true;
}

/** Open the ECU a sweep found, if the catalogue names one. */
export async function openScanResult(result: ProbeResult): Promise<void> {
  const slug = result.matches[0]?.slug;
  if (slug === undefined || database === null) return;
  const summary = database.summary(slug);
  if (summary === undefined) return;
  await selectEcu(summary);
}

let simulated: DtcLink | null = null;

/**
 * Where fault reads and clears are sent.
 *
 * Demo mode gets a simulated link rather than being locked out, so this panel can be
 * built and its confirmation flow exercised without a vehicle.
 */
function dtcLink(): DtcLink | null {
  if (driver !== null) return driver;
  if (ecu === null) return null;
  // Kept for the life of the selection rather than rebuilt per call: the simulated
  // link remembers an erase, and a fresh one each time would forget it and keep
  // reporting the faults that were just cleared.
  simulated ??= simulatedDtcLink(ecu);
  return simulated;
}

/** Reading faults is safe on any vehicle, so it needs no gate. */
export async function readFaults(): Promise<void> {
  const link = dtcLink();
  if (link === null || ecu === null || app.dtcReading) return;
  app.dtcReading = true;
  app.dtcNotice = null;
  try {
    const outcome = await withAdapterLock(() => readDtcs(link, ecu as LoadedEcu));
    if (!outcome.ran) {
      app.dtcNotice = "Another ddtx tab is using this adapter.";
      return;
    }
    app.dtc = outcome.value ?? null;
  } catch (cause) {
    app.dtcNotice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    app.dtcReading = false;
  }
}

/**
 * Erase stored faults.
 *
 * Irreversible and it discards evidence, so on a vehicle it goes through the same
 * gates as a button press and names the frame in the prompt. Demo mode is exempt for
 * the same reason button presses are: there is nothing to protect.
 */
export async function clearFaults(): Promise<void> {
  const link = dtcLink();
  if (link === null || ecu === null || app.dtcClearing) return;

  const live = isLive();
  if (live) {
    const gate = checkWriteGates({ writesEnabled: app.writesEnabled, live: true });
    if (!gate.allowed) {
      app.lastRefusal = gate.reason ?? "Not allowed.";
      return;
    }
    const named = dtcClearRequestName(ecu);
    const how = named ?? "the generic 14 FF 00 request";
    if (
      !globalThis.confirm(
        `Erase every stored fault code in ${ecu.def.ecuname} using ${how}?\n\n` +
          "This cannot be undone, and it destroys the record of what went wrong.",
      )
    ) {
      app.lastRefusal = "Cancelled.";
      return;
    }
  }

  app.dtcClearing = true;
  app.dtcClearNotice = null;
  try {
    const outcome = await withAdapterLock(() => clearDtcs(link, ecu as LoadedEcu));
    if (!outcome.ran) {
      app.dtcClearNotice = "Another ddtx tab is using this adapter.";
      return;
    }
    const result = outcome.value;
    if (result === undefined) return;
    app.dtcClearNotice = result.cleared
      ? `Cleared with ${result.frame}${result.usedFallback ? " (generic request)" : ""}.`
      : `Not cleared: ${result.detail ?? "no answer"}.`;
    app.lastRefusal = null;
    // Re-read, because "cleared" is a claim until the ECU answers with nothing.
    if (result.cleared) await readFaults();
  } catch (cause) {
    app.dtcClearNotice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    app.dtcClearing = false;
  }
}

export async function disconnect(): Promise<void> {
  stopAutoRefresh();
  // Writing is never left on across a connection: the next vehicle is a new
  // decision.
  app.writesEnabled = false;
  try {
    await driver?.closeProtocol();
  } catch {
    /* the adapter may already be gone */
  }
  await transport?.close().catch(() => undefined);
  driver = null;
  transport = null;
  app.linkKind = "simulated";
  app.adapter = null;
  app.attachment = null;
  app.connection = "idle";
  app.connectionMessage = "Not connected";
  app.linkBench = null;
  app.scanFound = [];
  app.scanSummary = null;
  await reopenCurrentScreen();
}

/** Rebuild the runtime so a link change takes effect on the open screen. */
async function reopenCurrentScreen(): Promise<void> {
  const name = app.screen?.name;
  if (name === undefined) return;
  await openScreen(name);
}

export async function openScreen(name: string): Promise<void> {
  if (layout === null || ecu === null) return;
  const screen = layout.screens.get(name);
  if (screen === undefined) return;

  stopAutoRefresh();
  app.screen = screen;
  app.snapshot = null;
  app.edits = new Map();
  app.badField = null;
  app.actionExchanges = [];
  app.actionLabel = null;

  // With a vehicle attached the adapter has to be configured for this ECU before
  // anything is sent. Cheap to repeat: the driver short-circuits when it is
  // already addressing it, so moving between screens of one ECU costs nothing.
  if (driver !== null) {
    if (!isReachable(ecu)) {
      app.attachment = null;
      app.connectionMessage = `${ecu.def.obd.protocol} is not reachable from a browser`;
      return;
    }
    try {
      app.attachment = describeAttachment(await attachEcu(driver, ecu));
    } catch (cause) {
      app.attachment = null;
      app.connectionMessage = cause instanceof Error ? cause.message : String(cause);
      return;
    }
  }

  runtime = new ScreenRuntime(ecu, screen, makeLink());

  // Presend runs on entry, as the Qt app does when it isn't polling.
  await runtime.runPresend();
  await refresh();
}

/**
 * The link the screen runtime talks through.
 *
 * `ElmLink` and `SimulatedLink` are interchangeable, which is what lets demo mode
 * stay the offline development path instead of becoming dead code once hardware
 * works.
 */
function makeLink(): EcuLink {
  if (ecu === null) throw new Error("makeLink called with no ECU loaded");
  if (driver !== null) return new ElmLink(driver);
  return new SimulatedLink(ecu.requests, { fill: app.fill, drift: app.drift });
}

export async function refresh(): Promise<void> {
  if (runtime === null || app.refreshing) return;
  app.refreshing = true;
  try {
    app.snapshot = await runtime.refresh();
  } finally {
    app.refreshing = false;
  }
  if (app.autoRefresh) {
    autoTimer = setTimeout(() => void refresh(), 700);
  }
}

/** Rebuild the link so a changed fill mode or drift setting takes effect. */
export async function reconfigureDemo(): Promise<void> {
  if (ecu === null || app.screen === null) return;
  const wasAuto = app.autoRefresh;
  stopAutoRefresh();
  runtime = new ScreenRuntime(ecu, app.screen, makeLink());
  app.autoRefresh = wasAuto;
  await refresh();
}

export function setAutoRefresh(on: boolean): void {
  app.autoRefresh = on;
  if (on) void refresh();
  else stopAutoRefresh();
}

function stopAutoRefresh(): void {
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  app.autoRefresh = false;
}

/** Key an edit the way the write path reads it. */
function editKey(requestName: string, dataName: string): string {
  return `${requestName}\u0000${dataName}`;
}

/** The value showing in an input: what was typed, else what was last read. */
export function inputValue(widget: PreparedWidget): string {
  const dataName = widget.dataName;
  if (dataName === null) return "";
  const typed = app.edits.get(editKey(widget.request, dataName));
  if (typed !== undefined) return typed;
  return app.snapshot?.values.get(widget.id)?.value ?? "";
}

/** Has this input been typed into since the screen opened? */
export function isEdited(widget: PreparedWidget): boolean {
  const dataName = widget.dataName;
  if (dataName === null) return false;
  return app.edits.has(editKey(widget.request, dataName));
}

export function setInputValue(widget: PreparedWidget, value: string): void {
  const dataName = widget.dataName;
  if (dataName === null) return;
  // A new Map so Svelte sees the change; mutating in place would not invalidate.
  const next = new Map(app.edits);
  next.set(editKey(widget.request, dataName), value);
  app.edits = next;
  if (app.badField === dataName) app.badField = null;
}

export function revertInput(widget: PreparedWidget): void {
  const dataName = widget.dataName;
  if (dataName === null) return;
  const next = new Map(app.edits);
  next.delete(editKey(widget.request, dataName));
  app.edits = next;
}

/**
 * Would pressing a button be allowed right now?
 *
 * Exposed so a button can be disabled with the reason in its tooltip, rather than
 * looking pressable and then silently doing nothing.
 *
 * Demo mode is exempt: there is no vehicle to protect, and gating it would make
 * the offline path useless for building screens.
 */
export function buttonGate(): GateDecision {
  if (!isLive()) return { allowed: true };
  return checkWriteGates({ writesEnabled: app.writesEnabled, live: true });
}

/**
 * Fire a button's requests.
 *
 * On a live vehicle this is the only path that puts bytes on the bus off the back
 * of a click, so every gate is checked here rather than trusted to the caller:
 * writes enabled, tab visible, no other tab holding the adapter, and the operator
 * confirmed. See docs/plan.md §6.3.
 */
export async function pressButton(uniquename: string): Promise<void> {
  if (runtime === null || app.screen === null) return;
  const button = app.screen.buttons.find((b) => b.uniquename === uniquename);
  if (button === undefined) return;

  const live = isLive();
  if (live) {
    const gate = checkWriteGates({ writesEnabled: app.writesEnabled, live: true });
    if (!gate.allowed) {
      app.lastRefusal = gate.reason ?? "Not allowed.";
      return;
    }

    const prompt = confirmationPrompt(
      button.text,
      button.messages,
      button.send.map((entry) => entry.RequestName),
    );
    if (!globalThis.confirm(prompt)) {
      app.lastRefusal = "Cancelled.";
      return;
    }

    const outcome = await withAdapterLock(async () =>
      runtime?.pressButton(button, inputValuesFrom(app.edits)),
    );
    if (!outcome.ran) {
      app.lastRefusal =
        "Another ddtx tab is using this adapter. Close it, or disconnect there first.";
      return;
    }
    if (outcome.value?.refused !== undefined) {
      app.badField = outcome.value.refused.field;
      app.lastRefusal = `“${outcome.value.refused.field}” is not a value this field accepts, so nothing was sent.`;
      return;
    }
    app.actionExchanges = outcome.value?.exchanges ?? [];
    app.actionLabel = button.text;
  } else {
    const result = await runtime.pressButton(button, inputValuesFrom(app.edits));
    if (result.refused !== undefined) {
      app.badField = result.refused.field;
      app.lastRefusal = `“${result.refused.field}” is not a value this field accepts, so nothing was sent.`;
      return;
    }
    app.actionExchanges = result.exchanges;
    app.actionLabel = button.text;
  }

  app.badField = null;
  app.lastRefusal = null;
  await refresh();
}
