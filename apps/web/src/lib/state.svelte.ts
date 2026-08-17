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
  groups: string[];
  protocols: string[];
  projects: string[];

  /** Catalogue filters. */
  search: string;
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
}

const RESULT_CAP = 400;

export const app = $state<AppState>({
  phase: "idle",
  error: null,
  ecuCount: 0,
  groups: [],
  protocols: [],
  projects: [],
  search: "",
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
});

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
    app.groups = [...database.groups];
    app.protocols = [...database.protocols];
    app.projects = [...database.projects];
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

export function applyFilters(): void {
  if (database === null) return;
  const all = database.list({
    ...(app.search.trim() === "" ? {} : { search: app.search.trim() }),
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
