/**
 * Turn a raw layout file into a model the renderer can draw without guarding.
 *
 * The database's cross-references are almost clean but not entirely, and the
 * exceptions were measured across all 1,580 ECUs rather than guessed at:
 *
 * | case | count | of | handling |
 * |---|---:|---:|---|
 * | widget `text` is `""` | 1,421 | 1,021,519 | **valid decoration** — draw the box, no value |
 * | widget `text` names absent data | 24 | 1,021,519 | drop, record a warning |
 * | widget `request` absent | 0 | 1,021,519 | drop, record a warning |
 * | `button` has no `send` | 1,367 | 104,276 | keep, renders as a no-op |
 * | `button.send` names absent request | 70 | 200,604 | drop that entry |
 * | `presend` names absent request | 1 | 11,403 | drop that entry |
 * | category names absent screen | 0 | 40,179 | drop from the menu |
 *
 * The empty-`text` case is the important one: it is 98% of all apparently
 * dangling widgets and it is not an error at all. Treating it as one would blank
 * out a fifth of the screens in the database.
 */

import type {
  ButtonWidget,
  CategoryName,
  DataName,
  DisplayWidget,
  FontDef,
  LabelWidget,
  LayoutFileDef,
  Rect,
  RequestDef,
  RequestName,
  ScreenDef,
  ScreenName,
  SendEntry,
} from "@ddtx/core";

/** A value readout or entry field whose references have been checked. */
export interface PreparedWidget {
  /**
   * Stable within a loaded layout, e.g. `display#3`. Widgets carry no identity
   * of their own in the database, and captions repeat, so the UI needs
   * something to key state and value maps on.
   */
  id: string;
  kind: "display" | "input";
  rect: Rect;
  color: string;
  fontcolor: string;
  font: FontDef;
  /**
   * Width of the **caption** half, in twips; the value half gets
   * `rect.width - captionWidth`. Named `width` in the database, which reads as
   * if it sized the value — it doesn't (`display_widget.py:127`).
   */
  captionWidth: number;
  /** Verified to exist in the ECU's `requests`. */
  request: RequestName;
  /**
   * Verified to exist in the ECU's `data`, or `null` for a decoration — a
   * widget with no value binding, which renders as an empty framed box.
   */
  dataName: DataName | null;
  /** Raw caption as authored; pass through the i18n overlay before display. */
  label: string;
}

export interface PreparedButton {
  rect: Rect;
  font: FontDef;
  text: string;
  /** Confirmation prompts. Often `[""]`, which means "no prompt". */
  messages: string[];
  /** Stable identity within the screen — safe to key UI state on. */
  uniquename: string;
  /** Always an array, and every entry's request is known to exist. */
  send: SendEntry[];
}

export interface PreparedScreen {
  name: ScreenName;
  /** Canvas size in twips; scale to CSS pixels with a single factor. */
  width: number;
  height: number;
  color: string;
  widgets: PreparedWidget[];
  labels: LabelWidget[];
  buttons: PreparedButton[];
  /** Requests to fire once on entry; every request is known to exist. */
  presend: SendEntry[];
}

export interface PreparedCategory {
  name: CategoryName;
  screens: ScreenName[];
}

export interface LayoutWarning {
  kind:
    | "widget-missing-request"
    | "widget-missing-data"
    | "display-not-in-response"
    | "button-send-missing-request"
    | "presend-missing-request"
    | "category-missing-screen";
  screen: string;
  detail: string;
}

export interface PreparedLayout {
  categories: PreparedCategory[];
  screens: Map<string, PreparedScreen>;
  /** Everything dropped, for a dev-mode surface. Empty for most ECUs. */
  warnings: LayoutWarning[];
}

/**
 * @param requests Request name → definition. The definitions (not just their
 *   names) are needed because a *display* may only read a field its request
 *   actually returns — see the `display-not-in-response` rule below.
 */
export function prepareLayout(
  layout: LayoutFileDef,
  requests: ReadonlyMap<string, RequestDef>,
  dataNames: ReadonlySet<string>,
): PreparedLayout {
  const warnings: LayoutWarning[] = [];
  const screens = new Map<string, PreparedScreen>();

  for (const [name, raw] of Object.entries(layout.screens ?? {})) {
    screens.set(name, prepareScreen(name, raw, requests, dataNames, warnings));
  }

  const categories: PreparedCategory[] = [];
  for (const [name, members] of Object.entries(layout.categories ?? {})) {
    const kept: ScreenName[] = [];
    for (const member of members) {
      if (screens.has(member)) {
        kept.push(member as ScreenName);
      } else {
        warnings.push({ kind: "category-missing-screen", screen: member, detail: name });
      }
    }
    // A category whose every screen is missing would render as an empty menu
    // entry; drop it rather than show a dead node.
    if (kept.length > 0) categories.push({ name: name as CategoryName, screens: kept });
  }

  return { categories, screens, warnings };
}

function prepareScreen(
  name: string,
  raw: ScreenDef,
  requests: ReadonlyMap<string, RequestDef>,
  dataNames: ReadonlySet<string>,
  warnings: LayoutWarning[],
): PreparedScreen {
  const widgets: PreparedWidget[] = [];

  const take = (kind: "display" | "input", list: readonly DisplayWidget[]): void => {
    let ordinal = 0;
    for (const w of list) {
      const id = `${kind}#${ordinal++}`;
      const request = requests.get(w.request);
      if (request === undefined) {
        warnings.push({ kind: "widget-missing-request", screen: name, detail: w.request });
        continue;
      }
      // Resolve first, then fall back — not the other way round. Three ECUs
      // define a data entry literally named "" (an authoring artifact,
      // `{"scaled": true}`), and the Qt app binds its 5 widgets to it because it
      // looks the caption up unconditionally. Checking for the empty caption
      // first would silently turn those into decorations instead.
      let bound: DataName | null;
      if (dataNames.has(w.text)) {
        bound = w.text as DataName;
      } else if (w.text === "") {
        // No such definition and no caption: a decoration — a framed box with
        // nothing to read. 1,421 of these exist and they are not errors.
        bound = null;
      } else {
        warnings.push({ kind: "widget-missing-data", screen: name, detail: w.text });
        continue;
      }

      // A display can only show a field its request returns, so one naming a
      // field absent from `receivebyte_dataitems` is dropped — the Qt app never
      // creates the widget (`display_widget.py:104-112`). Inputs carry no such
      // requirement: they are written, and are only *filled* opportunistically
      // when some display happens to decode the same data name.
      if (kind === "display" && bound !== null) {
        if ((request.receivebyte_dataitems ?? {})[bound] === undefined) {
          warnings.push({ kind: "display-not-in-response", screen: name, detail: bound });
          continue;
        }
      }

      widgets.push({
        id,
        kind,
        rect: w.rect,
        color: w.color,
        fontcolor: w.fontcolor,
        font: w.font,
        captionWidth: w.width,
        request: w.request as RequestName,
        dataName: bound,
        label: w.text,
      });
    }
  };

  take("display", raw.displays ?? []);
  take("input", raw.inputs ?? []);

  const buttons: PreparedButton[] = (raw.buttons ?? []).map((b: ButtonWidget) => ({
    rect: b.rect,
    font: b.font,
    text: b.text,
    messages: b.messages ?? [],
    uniquename: b.uniquename,
    send: (b.send ?? []).filter((entry) => {
      if (requests.has(entry.RequestName)) return true;
      warnings.push({
        kind: "button-send-missing-request",
        screen: name,
        detail: entry.RequestName,
      });
      return false;
    }),
  }));

  const presend = (raw.presend ?? []).filter((entry) => {
    if (requests.has(entry.RequestName)) return true;
    warnings.push({ kind: "presend-missing-request", screen: name, detail: entry.RequestName });
    return false;
  });

  return {
    name: name as ScreenName,
    width: raw.width,
    height: raw.height,
    color: raw.color,
    widgets,
    labels: raw.labels ?? [],
    buttons,
    presend,
  };
}

/**
 * Group a screen's widgets by the request that feeds them.
 *
 * A screen refreshes by firing each distinct request once and distributing the
 * decoded fields, not by firing one request per widget — screens routinely have
 * 37 displays over a handful of requests, so the naive approach would multiply
 * bus traffic by an order of magnitude.
 */
export function requestsForScreen(screen: PreparedScreen): Map<RequestName, PreparedWidget[]> {
  const byRequest = new Map<RequestName, PreparedWidget[]>();
  for (const widget of screen.widgets) {
    // Decorations have no value to fetch.
    if (widget.dataName === null) continue;
    const existing = byRequest.get(widget.request);
    if (existing === undefined) byRequest.set(widget.request, [widget]);
    else existing.push(widget);
  }
  return byRequest;
}
