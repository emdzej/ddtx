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
}

const CATALOGUE_KEY = "ddtx.catalogueOpen";

function readCatalogueOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(CATALOGUE_KEY) !== "false";
  } catch {
    return true;
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
  catalogueOpen: readCatalogueOpen(),
});

export function setCatalogueOpen(open: boolean): void {
  app.catalogueOpen = open;
  try {
    globalThis.localStorage?.setItem(CATALOGUE_KEY, String(open));
  } catch {
    /* private mode, or storage disabled — the toggle still works this session */
  }
}

let database: EcuDatabase | null = null;
let ecu: LoadedEcu | null = null;
let layout: PreparedLayout | null = null;
let runtime: ScreenRuntime | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;

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
    ecu = await database.loadEcu(summary.slug);
    layout = await database.loadLayout(summary.slug);
    app.categories = layout.categories;
    app.layoutWarnings = layout.warnings.length;
    app.requestCount = ecu.requests.size;
    app.dataCount = ecu.data.size;
    app.testerPresent = testerPresentFrame(ecu);
    app.ecuPhase = "ready";
  } catch (cause) {
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
