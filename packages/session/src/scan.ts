/**
 * Sweeping the bus to find out which ECUs a vehicle actually has.
 *
 * Port of `ecu_scanner.py`. This is the thing you run first at a car: it turns a
 * 1,580-entry catalogue into the dozen or so units actually fitted, by asking each
 * functional address who it is and matching the answer against the index.
 *
 * Two identification methods, tried in that order, because the newer one is faster
 * but not universal:
 *
 *  - **UDS** (`identifyByUds`): session `1003`, then four `22 F1 xx` reads for
 *    diagnostic version, supplier, soft number and version. Modern ECUs.
 *  - **KWP local id** (`identifyByLocalId`): session `10C0`, then one `2180` whose
 *    reply packs all four fields at fixed offsets. Older ECUs.
 *
 * The original tries UDS and falls back (`if not self.identify_new(...):
 * self.identify_old(...)`), and the order matters: an older ECU refuses `1003`
 * outright, which is cheap, whereas a modern one may answer `2180` with something
 * that decodes to nonsense rather than an error.
 */

import { addressName, canAddressing, mappedCanAddresses, type DbTreeIndex } from "@ddtx/core";
import { matchAutoIdent, type AutoIdentMatch, type ReportedIdentity } from "@ddtx/db";
import type { ElmDriver } from "@ddtx/elm";

/** How an ECU was identified, or why it wasn't. */
export type ProbeOutcome =
  /** Answered, and the identity matched one or more catalogue entries. */
  | "identified"
  /** Answered, but nothing in the catalogue describes it. */
  | "unknown-ecu"
  /** Nothing answered. Almost always means nothing is fitted at that address. */
  | "silent"
  /** The address has no CAN id mapping, so it cannot be addressed at all. */
  | "unmapped";

export type ScanBus = "can" | "kline";

export interface ProbeResult {
  bus: ScanBus;
  address: string;
  /** The canonical name for what sits here, from the addressing table. */
  name: string | undefined;
  outcome: ProbeOutcome;
  /** Which method got an answer. */
  via?: "uds" | "local-id";
  /** What the ECU reported about itself. */
  identity?: ReportedIdentity;
  /** Catalogue entries describing it, best first. Empty for `unknown-ecu`. */
  matches: AutoIdentMatch[];
}

export interface ScanOptions {
  /**
   * Restrict to the addresses one vehicle uses.
   *
   * Worth doing: a full sweep is 223 addresses, and a given vehicle has a few
   * dozen. Each silent address still costs a session attempt.
   */
  project?: string;
  /** Called after each address so a UI can show progress. */
  onProgress?: (done: number, total: number, result: ProbeResult) => void;
  /** Cooperative cancellation, checked between addresses. */
  signal?: { aborted: boolean };
}

export interface ScanReport {
  results: ProbeResult[];
  /** Addresses that answered, in sweep order. */
  found: ProbeResult[];
  addressesProbed: number;
  elapsedMs: number;
  /** True when a `signal` stopped it early. */
  cancelled: boolean;
}

/** `7F` — a negative response, meaning the ECU declined rather than stayed silent. */
function isNegative(reply: string): boolean {
  return reply.trim().toUpperCase().startsWith("7F");
}

/** Nothing usable came back. */
function isEmpty(reply: string): boolean {
  const compact = reply.replace(/\s+/g, "").toUpperCase();
  return compact.length === 0 || compact.includes("WRONG") || compact.includes("NODATA");
}

/**
 * Read the hex payload of a `22 F1 xx` reply as text.
 *
 * The reply is `62 F1 xx` then ASCII, so three bytes of header are dropped. Padding
 * is `20` (space) or `FF`/`00`, all of which are trimmed — an unpadded supplier name
 * is what makes the prefix match in `matchAutoIdent` work.
 */
function asciiPayload(reply: string, maxBytes: number): string {
  const compact = reply.replace(/\s+/g, "").toUpperCase();
  const body = compact.slice(6, 6 + maxBytes * 2);
  let text = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    const byte = Number.parseInt(body.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) break;
    // Stop at a terminator rather than rendering it: FF and 00 are padding here,
    // and the original strips them before comparing.
    if (byte === 0xff || byte === 0x00) break;
    text += String.fromCharCode(byte);
  }
  return text.trim();
}

/**
 * A raw identity byte as the **decimal** string the index stores.
 *
 * This matters and is easy to get wrong. `diagnostic_version` in the index is
 * decimal: across 193 distinct values not one contains `A`–`F`, and several exceed
 * 99 (`193`, `224`, `255`), which no single hex byte could spell. So a reported byte
 * of `0x16` is `"22"`, not `"16"`.
 *
 * `check_ecu` gets this right (`str(int(x, 16))`). `identify_new` does **not** — it
 * takes the raw hex characters, so a UDS scan there produces `"16"` where the index
 * holds `"22"` and the match silently fails. Ported as decimal in both paths
 * deliberately, because the alternative is a scanner that reliably finds nothing.
 */
function identityByteToDecimal(hexByte: string): string {
  const value = Number.parseInt(hexByte, 16);
  return Number.isNaN(value) ? "" : String(value);
}

/** Hex chars of a spaced reply with the spaces removed. */
function slicePacked(spaced: string, from: number, to: number): string {
  return spaced.slice(from, to).replace(/\s+/g, "").toUpperCase();
}

/** ASCII from a slice of a spaced reply. */
/**
 * Read a field as text, rendering bytes that are not printable ASCII as `?`.
 *
 * The `?` is not our invention — it is what the database already contains. A real UCH
 * reports its supplier as the bytes `00 32 31`, and the catalogue entry for that module
 * says `?21`: whatever exported these definitions wrote the unprintable byte as a
 * question mark. So rendering it the same way makes the two sides meet, and the entry
 * matches exactly.
 *
 * **A deliberate divergence.** The original breaks at the first `00` or `FF`, which for
 * that UCH yields `""` — no supplier, no exact match, and the module reported as
 * unrecognised. That is what ddtx did too until a real vehicle showed it: address 26
 * agreed on diagnostic version and soft number and still failed to identify, purely on
 * an empty supplier. The original has the same bug; being faithful to it here costs a
 * correct identification.
 *
 * Trailing padding is still dropped. `FF` filler after a three-character code has to
 * stay invisible, or the ABS's `376` would become `376??` and stop matching — which is
 * the same trap from the other side.
 */
function sliceAscii(spaced: string, from: number, to: number): string {
  const hex = slicePacked(spaced, from, to);
  let text = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) break;
    // Printable ASCII passes through; anything else becomes the placeholder the
    // database itself uses.
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
  }
  // Only *trailing* placeholders are padding. A leading one is part of the code.
  return text.replace(/\?+$/, "").trim();
}

/**
 * Pull an identity out of a `2180` reply.
 *
 * Faithful port of `check_ecu`, including its two offset schemes — the original
 * switches on the **length of the spaced string**, and the offsets differ between
 * them rather than merely extending. Both `identify_old` (CAN) and `scan_kwp`
 * (K-line) funnel through this, which is why one function serves both.
 *
 * The offsets are character positions into the spaced text, where byte *n* occupies
 * positions `3n` and `3n+1`. Kept as the original's literal numbers rather than
 * recomputed, so they can be checked against it line by line.
 */
export function parseIdentityBlock(reply: string): ReportedIdentity | null {
  const spaced = reply.trim().toUpperCase();

  if (spaced.length > 59) {
    // Long form: diag at byte 7, supplier bytes 8–10, soft bytes 16–17,
    // version bytes 18–19.
    const diagversion = identityByteToDecimal(slicePacked(spaced, 21, 23));
    if (diagversion === "") return null;
    return {
      diagversion,
      supplier: sliceAscii(spaced, 24, 32),
      soft: slicePacked(spaced, 48, 53),
      version: slicePacked(spaced, 54, 59),
    };
  }

  if (spaced.length > 20) {
    // Short form: diag at byte 2, supplier bytes 3–5, soft bytes 6–8,
    // version bytes 9–11.
    const diagversion = identityByteToDecimal(slicePacked(spaced, 6, 8));
    if (diagversion === "") return null;
    return {
      diagversion,
      supplier: sliceAscii(spaced, 9, 17),
      soft: slicePacked(spaced, 18, 26),
      version: slicePacked(spaced, 27, 35),
    };
  }

  return null;
}

/**
 * Identify via UDS: open session `1003`, then read four identifiers.
 *
 * Any step failing abandons the attempt — a half-read identity would match the
 * wrong catalogue entry, which is worse than no match. The session is closed on the
 * way out either way, because an ECU left in a non-default session goes on
 * broadcasting and corrupts the next address's probe (`_close_uds_session`).
 *
 * The supplier here is an ASCII *name* (`CONTINENTAL_ENGINE_SYSTEM`), not the
 * 3-digit code the older block carries. The index holds both forms — 132 entries
 * with a 3-character code, 164 with a name — so the two identification paths match
 * different entries rather than competing for the same ones.
 */
export async function identifyByUds(driver: ElmDriver): Promise<ReportedIdentity | null> {
  try {
    const session = await driver.request("1003", { cache: false });
    if (isEmpty(session) || isNegative(session)) return null;

    const version = await driver.request("22F1A0", { cache: false });
    if (isEmpty(version) || isNegative(version)) return null;
    const diagversion = identityByteToDecimal(
      version.replace(/\s+/g, "").toUpperCase().slice(6, 8),
    );
    if (diagversion === "") return null;

    const supplierReply = await driver.request("22F18A", { cache: false });
    if (isEmpty(supplierReply) || isNegative(supplierReply)) return null;

    const softReply = await driver.request("22F194", { cache: false });
    if (isEmpty(softReply) || isNegative(softReply)) return null;

    const versionReply = await driver.request("22F195", { cache: false });
    if (isEmpty(versionReply) || isNegative(versionReply)) return null;

    return {
      diagversion,
      supplier: asciiPayload(supplierReply, 63),
      soft: asciiPayload(softReply, 16),
      version: asciiPayload(versionReply, 16),
    };
  } finally {
    // Back to the default session, or the next probe reads this ECU's chatter.
    await driver.request("1001", { cache: false }).catch(() => undefined);
  }
}

/**
 * Identify via the older local-id read: session `10C0`, then `2180`.
 *
 * One reply carries all four fields, sliced by {@link parseIdentityBlock}.
 */
export async function identifyByLocalId(driver: ElmDriver): Promise<ReportedIdentity | null> {
  try {
    const session = await driver.request("10C0", { cache: false });
    if (isEmpty(session) || isNegative(session)) return null;

    const reply = await driver.request("2180", { cache: false });
    if (isEmpty(reply) || isNegative(reply)) return null;
    return parseIdentityBlock(reply);
  } finally {
    await driver.request("1081", { cache: false }).catch(() => undefined);
  }
}

/**
 * Which addresses a sweep should cover, for one bus.
 *
 * Taken from the index rather than from the addressing table, so a sweep only
 * visits addresses some ECU in the catalogue actually claims. `kline` covers both
 * `KWP2000` and `ISO8`, since both are reached the same way.
 *
 * The bus split matters more than it looks: Master II is 15 K-line ECUs to 2 on
 * CAN, so a CAN-only sweep would miss almost the whole vehicle.
 */
/**
 * Does a project code belong to the vehicle asked for?
 *
 * Prefix, not equality, and that is a real fix rather than laxity. A single model is
 * split across several codes — Master II is `x70` **and** `x70Ph3`, and the Ph3 entries
 * carry three K-line addresses the base code does not: the parking aid at `0E`, the SVT
 * at `3F`, the tacho at `EE`. Asking for `x70` on an actual Master II therefore probed
 * 7 addresses and silently skipped 3, which is the wrong kind of silence — a module the
 * car has, never asked.
 *
 * Over-probing costs time, never damage: an address with nothing behind it answers
 * nothing, and the sweep reports only what replied. Under-probing loses a module.
 */
function matchesProject(code: string, wanted: string): boolean {
  return code.trim().toUpperCase().startsWith(wanted);
}

export function addressesToProbe(index: DbTreeIndex, bus: ScanBus, project?: string): string[] {
  const wanted = project?.trim().toUpperCase();
  const addresses = new Set<string>();
  const wantedProtocols = bus === "can" ? new Set(["CAN"]) : new Set(["KWP2000", "ISO8", "ISO"]);

  for (const entry of Object.values(index.ecus)) {
    if (!wantedProtocols.has(entry.protocol.toUpperCase())) continue;
    if (wanted !== undefined && !entry.projects.some((code) => matchesProject(code, wanted))) {
      continue;
    }
    const address = entry.address.trim().toUpperCase();
    // `00` is the bus itself and `FF` the secondary bus, neither an ECU — the
    // original skips both explicitly as "NON ISO-TP".
    if (address === "" || address === "00" || address === "FF") continue;
    addresses.add(address);
  }

  // With no project filter and nothing in the index, fall back to every address
  // that has a CAN mapping. Only meaningful for CAN — K-line addressing needs no
  // id table, so there is nothing to enumerate.
  if (addresses.size === 0 && wanted === undefined && bus === "can") {
    for (const address of mappedCanAddresses()) {
      if (address !== "00" && address !== "FF") addresses.add(address);
    }
  }
  return [...addresses].sort();
}

/** Probe one address. Assumes CAN is already initialised. */
export async function probeAddress(
  driver: ElmDriver,
  index: DbTreeIndex,
  address: string,
): Promise<ProbeResult> {
  const name = addressName(address);
  const mapping = canAddressing(address);
  if (mapping === undefined) {
    return { bus: "can", address, name, outcome: "unmapped", matches: [] };
  }

  await driver.setCanAddress({
    idTx: mapping.idTx,
    idRx: mapping.idRx,
    ecuname: `scan ${address}`,
  });

  let identity = await identifyByUds(driver);
  let via: "uds" | "local-id" = "uds";
  if (identity === null) {
    identity = await identifyByLocalId(driver);
    via = "local-id";
  }
  if (identity === null) return { bus: "can", address, name, outcome: "silent", matches: [] };

  const matches = matchAutoIdent(index, address, identity, "CAN");
  return {
    bus: "can",
    address,
    name,
    outcome: matches.length > 0 ? "identified" : "unknown-ecu",
    via,
    identity,
    matches,
  };
}

/**
 * Probe one K-line address.
 *
 * Simpler than CAN in one way and harder in another: there is no id table to look
 * up — the functional address *is* the target — but the init handshake is per
 * address and can fail outright, which CAN's re-headering never does.
 *
 * `options.opt_si = True` in `scan_kwp` forces slow init for the sweep, rather than
 * trusting each ECU's `fastinit` flag: during a scan we do not yet know which ECU
 * is there, so its flag is not available to consult.
 */
export async function probeKlineAddress(
  driver: ElmDriver,
  index: DbTreeIndex,
  address: string,
): Promise<ProbeResult> {
  const name = addressName(address);

  // A failed init means nothing is listening; the original `continue`s on it.
  const initialised = await driver.setIsoAddress(address, { slowInit: true });
  if (!initialised) return { bus: "kline", address, name, outcome: "silent", matches: [] };

  const session = await driver.request("10C0", { cache: false });
  if (isEmpty(session) || isNegative(session)) {
    return { bus: "kline", address, name, outcome: "silent", matches: [] };
  }

  const reply = await driver.request("2180", { cache: false });
  if (isEmpty(reply) || isNegative(reply)) {
    return { bus: "kline", address, name, outcome: "silent", matches: [] };
  }

  const identity = parseIdentityBlock(reply);
  if (identity === null) {
    return { bus: "kline", address, name, outcome: "silent", matches: [] };
  }

  const matches = matchAutoIdent(index, address, identity, "KWP");
  return {
    bus: "kline",
    address,
    name,
    outcome: matches.length > 0 ? "identified" : "unknown-ecu",
    via: "local-id",
    identity,
    matches,
  };
}

/**
 * Sweep the bus.
 *
 * CAN is initialised once and each address only re-headers, which is why this is
 * bearable: the per-address cost is the session attempt, not a protocol setup.
 */
export async function scanCan(
  driver: ElmDriver,
  index: DbTreeIndex,
  options: ScanOptions = {},
): Promise<ScanReport> {
  return sweep(driver, index, "can", options);
}

/** Sweep the K-line bus. What Master II mostly needs. */
export async function scanKline(
  driver: ElmDriver,
  index: DbTreeIndex,
  options: ScanOptions = {},
): Promise<ScanReport> {
  return sweep(driver, index, "kline", options);
}

/**
 * Sweep both buses and merge the reports.
 *
 * The order is CAN then K-line, because switching protocols is the expensive part
 * and doing it once each way is the least of it.
 */
export async function scanAll(
  driver: ElmDriver,
  index: DbTreeIndex,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const started = Date.now();

  // Both address counts up front, so progress is reported against one stable
  // total. Reporting each bus's own total made the denominator jump mid-sweep,
  // which reads as a bug even though the count was right.
  const canCount = addressesToProbe(index, "can", options.project).length;
  const klineCount = addressesToProbe(index, "kline", options.project).length;
  const total = canCount + klineCount;

  const relay = (offset: number): ScanOptions["onProgress"] =>
    options.onProgress === undefined
      ? undefined
      : (done, _busTotal, result) => options.onProgress?.(offset + done, total, result);

  const can = await sweep(driver, index, "can", { ...options, onProgress: relay(0) });
  if (can.cancelled) return { ...can, elapsedMs: Date.now() - started };

  const kline = await sweep(driver, index, "kline", {
    ...options,
    onProgress: relay(canCount),
  });

  const results = [...can.results, ...kline.results];
  return {
    results,
    found: results.filter((r) => r.outcome === "identified" || r.outcome === "unknown-ecu"),
    addressesProbed: results.length,
    elapsedMs: Date.now() - started,
    cancelled: kline.cancelled,
  };
}

async function sweep(
  driver: ElmDriver,
  index: DbTreeIndex,
  bus: ScanBus,
  options: ScanOptions,
): Promise<ScanReport> {
  const addresses = addressesToProbe(index, bus, options.project);
  const results: ProbeResult[] = [];
  const started = Date.now();
  let cancelled = false;

  if (addresses.length === 0) {
    return { results, found: [], addressesProbed: 0, elapsedMs: 0, cancelled: false };
  }

  // Once per sweep, not per address: the per-address cost has to be the probe, or
  // a 100-address sweep would be unusable.
  if (bus === "can") await driver.initCan();
  else await driver.initIso();

  for (const [i, address] of addresses.entries()) {
    if (options.signal?.aborted === true) {
      cancelled = true;
      break;
    }
    const result =
      bus === "can"
        ? await probeAddress(driver, index, address)
        : await probeKlineAddress(driver, index, address);
    results.push(result);
    options.onProgress?.(i + 1, addresses.length, result);
  }

  // Leave the bus as we found it, whether or not the sweep completed.
  await driver.closeProtocol().catch(() => undefined);

  return {
    results,
    found: results.filter((r) => r.outcome === "identified" || r.outcome === "unknown-ecu"),
    addressesProbed: results.length,
    elapsedMs: Date.now() - started,
    cancelled,
  };
}
