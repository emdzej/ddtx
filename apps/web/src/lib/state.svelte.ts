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
  HttpDbSource,
  type EcuSummary,
  type PreparedLayout,
  type PreparedScreen,
} from "@ddtx/db";
import { SimulatedLink, type FillMode } from "@ddtx/link";
import { ScreenRuntime, type ScreenSnapshot, testerPresentFrame } from "@ddtx/screens";
import type { LoadedEcu } from "@ddtx/db";

export type Phase = "idle" | "loading" | "ready" | "error";

/** Where the split tree lives. `/db` is what the dev server middleware serves. */
const DB_URL = import.meta.env.VITE_DB_URL ?? "/db";

interface AppState {
  phase: Phase;
  error: string | null;

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
    database = await EcuDatabase.open(new HttpDbSource(DB_URL));
    app.ecuCount = database.size;
    app.protocols = [...database.protocols];
    app.vehicles = buildVehicles(database);
    app.phase = "ready";
    applyFilters();
  } catch (cause) {
    app.phase = "error";
    app.error =
      cause instanceof Error
        ? `${cause.message} — is DDTX_DB_TREE set and the tree built?`
        : String(cause);
  }
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
    await primeOverlay();
    if (token !== selectionToken) return;
    app.ecuPhase = "ready";
  } catch (cause) {
    if (token !== selectionToken) return;
    app.ecuPhase = "error";
    app.error = cause instanceof Error ? cause.message : String(cause);
  }
}

export async function openScreen(name: string): Promise<void> {
  if (layout === null || ecu === null) return;
  const screen = layout.screens.get(name);
  if (screen === undefined) return;

  stopAutoRefresh();
  app.screen = screen;
  app.snapshot = null;
  runtime = new ScreenRuntime(ecu, screen, makeLink());

  // Presend runs on entry, as the Qt app does when it isn't polling.
  await runtime.runPresend();
  await refresh();
}

function makeLink(): SimulatedLink {
  if (ecu === null) throw new Error("makeLink called with no ECU loaded");
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

export async function pressButton(uniquename: string): Promise<void> {
  if (runtime === null || app.screen === null) return;
  const button = app.screen.buttons.find((b) => b.uniquename === uniquename);
  if (button === undefined) return;
  await runtime.pressButton(button);
  await refresh();
}
