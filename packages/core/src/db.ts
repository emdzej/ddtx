/**
 * Wire types for the DDT4All ECU database — the JSON produced by
 * `parameters.helpers.convertXML()` and shipped inside `ecu.zip`.
 *
 * These mirror the on-disk shape exactly, including its inconsistencies, so a
 * parsed file can be `as`-asserted into them without a normalisation step.
 * Notably `AutoIdent` (inside an ECU file) and `IndexAutoIdent` (inside
 * `db.json`) describe the same four fields under different names — both are
 * emitted by `ecu_file.py`, from `dumpJson()` and `dump_idents()` respectively.
 *
 * Shapes verified against all 1,581 ECU files in the 2019 snapshot: every
 * optional field below is genuinely absent in some files, and every
 * non-optional one is present in all of them.
 */

/* ── string namespaces ───────────────────────────────────────────────────── */

/**
 * DB strings are simultaneously identifiers and display text — `data` is keyed
 * by the French label, and a layout widget's `text` field is a lookup key into
 * it. Branding the reference-carrying strings keeps the two roles apart: only
 * these types index the DB, and the i18n layer only accepts these types (never
 * a bare `string`), so a translated label can never be used as a key.
 *
 * See docs/i18n-overlay.md. Getting this wrong breaks lookups in every locale
 * except French, and a French-locale test run will not catch it.
 */
export type DataName = string & { readonly __brand: "DataName" };
export type RequestName = string & { readonly __brand: "RequestName" };
export type ScreenName = string & { readonly __brand: "ScreenName" };
export type CategoryName = string & { readonly __brand: "CategoryName" };
export type DeviceName = string & { readonly __brand: "DeviceName" };

/* ── ECU definition file (`<ecu>.json`) ──────────────────────────────────── */

export type EcuProtocol = "CAN" | "KWP2000" | "ISO8" | "ISO";

/** Byte order for multi-byte values. Absent on ~0 files; "Big" dominates. */
export type Endianness = "Big" | "Little";

/**
 * Diagnostic-session gates a request opts out of. Only `nosds` and
 * `aftersales` occur in practice, but all five are emitted.
 */
export type DenySds = "nosds" | "plant" | "aftersales" | "engineering" | "supplier";

export interface ObdConfig {
  protocol: EcuProtocol;
  /** Functional address, hex, 2 chars. Always present. */
  funcaddr: string;
  /** ECU group ("Injection", "ABS", …). Always present, may be "". */
  funcname: string;
  /** CAN only — 11-bit (3 chars) or 29-bit (8 chars) hex. */
  send_id?: string;
  recv_id?: string;
  /** CAN only — bus speed in bit/s (250000 / 500000 / …). */
  baudrate?: number;
  /** KWP2000 only — fast init vs 5-baud. */
  fastinit?: boolean;
  /** KWP2000 / ISO8 key bytes, hex. */
  kw1?: string;
  kw2?: string;
}

/** Auto-identification tuple as stored inside an ECU file (`dumpJson`). */
export interface AutoIdent {
  diagversion: string;
  supplier: string;
  soft: string;
  version: string;
}

/**
 * One field's placement inside a request's byte stream.
 *
 * `firstbyte` is **1-based** (`ecu_data.py` does `firstbyte - 1` everywhere).
 * `bitoffset` counts from the MSB of that byte. `endian` overrides the
 * request-level endianness for this field alone.
 */
export interface DataItemDef {
  firstbyte?: number;
  bitoffset?: number;
  /** Marks the item as a reference//placeholder; carried through, unused. */
  ref?: boolean;
  endian?: Endianness;
}

export interface RequestDef {
  name: string;
  deny_sds: DenySds[];
  /** Hex template of the outgoing frame, no separators, e.g. "31A001". */
  sentbytes?: string;
  /** Minimum acceptable response length in bytes. */
  minbytes?: number;
  /** Canned response used in simulation mode. */
  replybytes?: string;
  /** Request is send-on-demand (a button), not part of a refresh cycle. */
  manualsend?: boolean;
  /** Shift the response left by N bytes before decoding. Rare (227 uses). */
  shiftbytescount?: number;
  /** Fields the caller fills in before sending, keyed by data name. */
  sendbyte_dataitems?: Record<string, DataItemDef>;
  /** Fields decoded out of the response, keyed by data name. */
  receivebyte_dataitems?: Record<string, DataItemDef>;
}

/**
 * A value definition: how to extract bits and turn them into something
 * displayable. Shared by every request that references it by name.
 *
 * Defaults, applied when a key is absent (`ecu_data.py:14-34`):
 * `bitscount` 8, `bytescount` 1, `step` 1, `offset` 0, `divideby` 1.
 */
export interface DataDef {
  bitscount?: number;
  bytescount?: number;
  /** Apply the linear transform (step/offset/divideby) and format as decimal. */
  scaled?: boolean;
  /** Two's-complement. Only honoured for bytescount 1 and 2. */
  signed?: boolean;
  /** Defined by a `<Bytes>` element rather than `<Bits>`. */
  byte?: boolean;
  /** Display as a binary string. */
  binary?: boolean;
  /** Decode the bytes as ASCII text. */
  bytesascii?: boolean;
  step?: number;
  offset?: number;
  divideby?: number;
  /** Printf-ish precision hint, e.g. "#0.00" — only the decimals matter. */
  format?: string;
  unit?: string;
  comment?: string;
  /**
   * Enum map, raw integer value → label. **JSON object keys are strings**
   * even though the values are numeric, so parse before comparing.
   *
   * The labels are load-bearing: writing a value looks the label back up to
   * recover the integer, so the UI must carry the key, not the shown text.
   */
  lists?: Record<string, string>;
}

export interface DeviceDef {
  name: string;
  /** DTC number this device reports under. */
  dtc: number;
  dtctype: number;
  /** Failure-flag name → flag value. */
  devicedata: Record<string, string>;
}

export interface EcuFileDef {
  ecuname: string;
  obd: ObdConfig;
  endian?: Endianness;
  autoidents: AutoIdent[];
  requests: RequestDef[];
  data: Record<string, DataDef>;
  devices: DeviceDef[];
}

/* ── screen layout file (`<ecu>.json.layout`) ────────────────────────────── */

/**
 * Rectangle in VB twips, relative to the screen's own `width`/`height`.
 * Renders as absolutely-positioned CSS scaled by one factor.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FontDef {
  name: string;
  /** Points. */
  size: number;
  /** "0" or "1" — a string, not a boolean. */
  bold: string;
  italic: string;
}

/** A request to fire, with a settling delay in ms (as a string). */
export interface SendEntry {
  RequestName: string;
  Delay: string;
}

/** Read-only value readout. `text` names a data item, `request` names its request. */
export interface DisplayWidget {
  rect: Rect;
  /** CSS `rgb(r,g,b)`, already in that form on disk. */
  color: string;
  fontcolor: string;
  font: FontDef;
  text: string;
  request: string;
  /** Width of the value half of the widget, in twips. */
  width: number;
}

/** Writable field. Same shape as {@link DisplayWidget}. */
export type InputWidget = DisplayWidget;

/** Static caption or group box. Uses `bbox`, not `rect`. */
export interface LabelWidget {
  bbox: Rect;
  color: string;
  fontcolor: string;
  font: FontDef;
  text: string;
  /** "0" left, "1" right, "2" centre, "" unset. */
  alignment: string;
}

export interface ButtonWidget {
  rect: Rect;
  font: FontDef;
  text: string;
  /** Confirmation prompts shown before sending. Often `[""]`. */
  messages: string[];
  /** Stable identity within the screen — unlike `text`, safe to translate. */
  uniquename: string;
  /**
   * Requests to fire on click. **Absent on 122 of 13,777 buttons**, so guard
   * before iterating.
   */
  send?: SendEntry[];
}

export interface ScreenDef {
  /** Canvas size in twips, e.g. 16380 × 10020. */
  width: number;
  height: number;
  color: string;
  displays: DisplayWidget[];
  inputs: InputWidget[];
  labels: LabelWidget[];
  buttons: ButtonWidget[];
  /** Requests fired once on screen entry. */
  presend: SendEntry[];
}

export interface LayoutFileDef {
  screens: Record<string, ScreenDef>;
  /** Category name → screen names, in menu order. */
  categories: Record<string, string[]>;
}

/* ── index (`db.json`) ───────────────────────────────────────────────────── */

/** Auto-identification tuple as stored in `db.json` (`dump_idents`). */
export interface IndexAutoIdent {
  diagnostic_version: string;
  supplier_code: string;
  soft_version: string;
  version: string;
}

export interface IndexEntry {
  /** "" on one entry in the 2019 snapshot — treat as unusable. */
  protocol: EcuProtocol | "";
  ecuname: string;
  /** Functional address, hex. */
  address: string;
  group: string;
  projects: string[];
  autoidents: IndexAutoIdent[];
}

/** `db.json`: ECU file name (with `.json` suffix) → summary. 1,580 entries. */
export type DbIndex = Record<string, IndexEntry>;

/* ── split static tree (`index.json`) ────────────────────────────────────── */

/**
 * The index `tools/db-split` emits and `@ddtx/db` loads: the upstream summary
 * re-keyed by slug, plus the facets a client would otherwise derive by walking
 * all 1,580 entries on every startup.
 *
 * A slug is the zip entry name minus `.json`, which is URL-safe for every entry
 * in the 2019 snapshot (verified: no characters outside `[A-Za-z0-9._-]`, no
 * case-insensitive collisions). Definitions live at `ecu/<slug>.json` and
 * screens at `layout/<slug>.json`.
 *
 * ~1.1 MB, 118 KB gzipped — small enough to load eagerly and search in-process.
 */
export interface DbTreeIndex {
  format: 1;
  ecus: Record<string, IndexEntry>;
  groups: string[];
  projects: string[];
  protocols: string[];
}
