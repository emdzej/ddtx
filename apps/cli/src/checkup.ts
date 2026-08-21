/**
 * Everything worth measuring on a vehicle, in one read-only pass.
 *
 * Six things were deferred through the whole port as "needs a car". Each one is a
 * separate command today, and answering them by hand means running probe, bench, scan,
 * read and dtc in turn and correlating the output. On a car — engine off, battery
 * draining, someone waiting — that is the wrong shape. This runs the lot and prints one
 * report.
 *
 * ## Read-only, structurally
 *
 * Not "read-only by convention". `runCheckup` never calls anything that writes: no
 * `clearDtcs`, no button presses, no plugin procedures, and no request whose service
 * byte is a write. The one place that could go wrong — a *session* request, which is a
 * write in the sense that it changes ECU state — is deliberately included, because
 * nothing can be read from most modules without one, and it is what the read path does
 * anyway.
 *
 * Anything genuinely irreversible stays a separate, explicit command. A checkup that
 * could erase a fault memory would be a checkup nobody dares run.
 *
 * ## What each phase answers
 *
 * | Phase    | The question it was deferred on                                     |
 * | -------- | ------------------------------------------------------------------- |
 * | adapter  | What is this, and which framing strategy does it support?           |
 * | link     | Host↔adapter round trip. Already measured; re-measured for this car |
 * | sweep    | Does the autoident scanner find real modules on a real bus?          |
 * | identity | Do the reported identity bytes match what the catalogue expects?     |
 * | timing   | **Real ECU response timing** — the headline unknown                  |
 * | frames   | Does the adapter's own `CFC1` hold on a live bus, on long replies?   |
 * | faults   | Does the DTC read — and its `MoreDTC` continuation — work for real?  |
 */

import type { EcuDatabase, LoadedEcu } from "@ddtx/db";
import type { ElmDriver } from "@ddtx/elm";
import { attachEcu, describeAttachment, readDtcs, supportsDtcRead } from "@ddtx/session";
import type { ProbeResult } from "@ddtx/session";

export interface CheckupOptions {
  /** Narrow the sweep to one vehicle's addresses. */
  project?: string;
  /** `can`, `kline`, or both. */
  bus?: "can" | "kline" | "both";
  /** How many timed reads per ECU. */
  samples?: number;
  /** Progress, line by line — a sweep is slow enough that silence looks like a hang. */
  log: (line: string) => void;
}

export interface EcuFinding {
  bus: string;
  address: string;
  /** What the catalogue calls it, if it recognised the module. */
  ecuname?: string;
  slug?: string;
  /** `exact` or `approximate`, from the autoident match. */
  quality?: string;
  reported?: { diagversion: string; supplier: string; soft: string; version: string };
  /** Round trips against this module. */
  timing?: TimingSummary;
  /** The longest reply seen, in bytes — the multi-frame evidence. */
  longestReply?: number;
  /** How many replies needed more than one CAN frame. */
  multiFrameReplies?: number;
  frameErrors?: number;
  faults?: { declared: number; read: number; requestName?: string };
  notes: string[];
}

export interface TimingSummary {
  samples: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  /** Anything past this is a stall worth naming, not jitter. */
  over50ms: number;
}

export interface CheckupReport {
  adapter: string;
  strategy: string;
  addressesProbed: number;
  sweepSeconds: number;
  found: EcuFinding[];
  /** Read-only means read-only; recorded so the report can say so. */
  wrote: false;
}

/** Percentile from a sorted array, nearest-rank. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[at] as number;
}

function summarise(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? 0,
    over50ms: sorted.filter((ms) => ms > 50).length,
  };
}

/**
 * Read requests worth timing on an unknown module.
 *
 * Chosen for being read-only and cheap, and preferring the longest reply available —
 * a multi-frame response is the only thing that exercises flow control, which is the
 * open question `cfc0` and `CFC1` both hang on.
 */
function timeableRequests(ecu: LoadedEcu): string[] {
  const candidates: Array<{ name: string; bytes: number }> = [];

  for (const [name, request] of ecu.requests) {
    const sent = (request.def.sentbytes ?? "").replace(/\s+/g, "");
    if (sent.length < 2) continue;

    // Read services only. 22/21 read by identifier, 17/18/19 read faults, 1A reads
    // identification. Everything else — 2E, 2F, 31, 14, 10 — either writes, actuates,
    // or erases, and none of it belongs in a checkup.
    const service = sent.slice(0, 2).toUpperCase();
    if (!["22", "21", "1A", "17", "18", "19"].includes(service)) continue;

    // How much the reply is expected to carry, from the fields it decodes.
    let widest = 0;
    for (const item of Object.values(request.def.receivebyte_dataitems ?? {})) {
      const first = item.firstbyte ?? 1;
      const data = ecu.data.get(name);
      widest = Math.max(widest, first + (data?.bytescount ?? 1));
    }
    candidates.push({ name, bytes: widest });
  }

  // Longest first, so the multi-frame case is exercised even if only a few run.
  candidates.sort((a, b) => b.bytes - a.bytes);
  return candidates.map((c) => c.name);
}

/**
 * Run the checkup.
 *
 * Never throws for a module that misbehaves: an ECU that refuses, times out, or answers
 * nonsense is a finding, and the sweep has to reach the next address either way.
 */
export async function runCheckup(
  driver: ElmDriver,
  db: EcuDatabase,
  scan: (
    driver: ElmDriver,
    index: EcuDatabase["index"],
    options: {
      project?: string;
      onProgress?: (done: number, total: number, r: ProbeResult) => void;
    },
  ) => Promise<{ found: ProbeResult[]; addressesProbed: number; elapsedMs: number }>,
  options: CheckupOptions,
): Promise<CheckupReport> {
  const { log } = options;
  const samples = options.samples ?? 12;

  const info = await driver.identify();
  log(`adapter    ${info.version}`);
  log(`strategy   ${driver.canStrategy}`);
  log("");

  log(
    `sweeping ${options.bus ?? "both"}${options.project === undefined ? "" : ` for ${options.project}`}…`,
  );
  const sweep = await scan(driver, db.index, {
    ...(options.project === undefined ? {} : { project: options.project }),
    onProgress: (done, total, result) => {
      if (result.outcome === "identified" || result.outcome === "unknown-ecu") {
        log(
          `  [${String(done).padStart(3)}/${total}] ${result.bus.padEnd(5)} ${result.address}  ` +
            `${result.matches[0]?.ecuname ?? result.name ?? "unrecognised"}`,
        );
      }
    },
  });
  log(
    `  ${sweep.found.length} of ${sweep.addressesProbed} addresses answered in ` +
      `${(sweep.elapsedMs / 1000).toFixed(1)} s`,
  );
  log("");

  const findings: EcuFinding[] = [];

  for (const result of sweep.found) {
    const finding: EcuFinding = {
      bus: result.bus,
      address: result.address,
      notes: [],
    };
    const match = result.matches[0];
    if (match !== undefined) {
      finding.ecuname = match.ecuname;
      finding.slug = match.slug;
      finding.quality = match.quality;
    }
    if (result.identity !== undefined) {
      finding.reported = {
        diagversion: result.identity.diagversion,
        supplier: result.identity.supplier,
        soft: result.identity.soft,
        version: result.identity.version,
      };
    }

    if (match === undefined) {
      finding.notes.push("answered, but no catalogue entry describes it — nothing to read");
      findings.push(finding);
      continue;
    }

    log(`${finding.ecuname} (${result.bus} ${result.address})`);

    let ecu: LoadedEcu;
    try {
      ecu = await db.loadEcu(match.slug);
    } catch (cause) {
      finding.notes.push(`could not load its definitions: ${describe(cause)}`);
      findings.push(finding);
      continue;
    }

    try {
      const attachment = await attachEcu(driver, ecu);
      log(`  attached   ${describeAttachment(attachment)}`);
    } catch (cause) {
      finding.notes.push(`could not attach: ${describe(cause)}`);
      findings.push(finding);
      continue;
    }

    // ── timing, and the multi-frame evidence ────────────────────────────────
    //
    // `multiFrame` counts replies that needed ISO-TP framing, which exists on CAN only.
    // On K-line a 26-byte reply arrives as 26 bytes with no PCI bytes and no flow
    // control, so counting it as multi-frame would support a conclusion about `CFC1`
    // that the measurement cannot make.
    const canBus = result.bus.toLowerCase().startsWith("can");
    const durations: number[] = [];
    let longest = 0;
    let multiFrame = 0;
    let frameErrors = 0;

    const before = driver.errors.frame;
    for (const name of timeableRequests(ecu).slice(0, samples)) {
      const request = ecu.requests.get(name);
      if (request === undefined) continue;
      const frame = (request.def.sentbytes ?? "").replace(/\s+/g, "");

      const started = Date.now();
      let reply = "";
      try {
        reply = await driver.request(frame, { cache: false });
      } catch (cause) {
        finding.notes.push(`${name}: ${describe(cause)}`);
        continue;
      }
      durations.push(Date.now() - started);

      // Hex only. A reply can carry `NO DATA` or an echo, and counting those characters
      // gave "longest reply 6.5 bytes" on a real module — a fractional byte, which is
      // the tell that something non-hex was being measured.
      const hex = reply.replace(/[^0-9A-Fa-f]/g, "");
      const bytes = Math.floor(hex.length / 2);
      longest = Math.max(longest, bytes);
      // Only meaningful on CAN. K-line has no ISO-TP framing at all, so a long reply
      // there says nothing about flow control — see the note below.
      if (canBus && bytes > 7) multiFrame += 1;
    }
    frameErrors = driver.errors.frame - before;

    if (durations.length > 0) {
      finding.timing = summarise(durations);
      finding.longestReply = longest;
      finding.multiFrameReplies = multiFrame;
      finding.frameErrors = frameErrors;
      const t = finding.timing;
      log(
        `  timing     n=${t.samples} min ${t.min} p50 ${t.p50} p90 ${t.p90} max ${t.max} ms` +
          `  ·  over 50 ms: ${t.over50ms}`,
      );
      log(
        `  frames     longest reply ${longest} bytes  ·  multi-frame ${multiFrame}` +
          `  ·  frame errors ${frameErrors}`,
      );
      if (!canBus) {
        finding.notes.push(
          `K-line: replies carry no ISO-TP framing, so the ${longest}-byte longest reply ` +
            "says nothing about flow control",
        );
      } else if (multiFrame === 0) {
        finding.notes.push("no reply exceeded one frame, so flow control was never exercised");
      }
    } else {
      finding.notes.push("nothing readable answered, so no timing was collected");
      log("  timing     nothing answered");
    }

    // ── faults ──────────────────────────────────────────────────────────────
    if (supportsDtcRead(ecu)) {
      try {
        const dtc = await readDtcs(driver, ecu);
        finding.faults = {
          declared: dtc.declared,
          read: dtc.records.length,
          ...(dtc.requestName === undefined ? {} : { requestName: dtc.requestName }),
        };
        log(`  faults     ${dtc.declared} declared, ${dtc.records.length} read (${dtc.outcome})`);
        if (dtc.declared > dtc.records.length) {
          finding.notes.push(
            `declared ${dtc.declared} faults but only ${dtc.records.length} decoded — ` +
              "the response did not carry them all",
          );
        }
      } catch (cause) {
        finding.notes.push(`fault read failed: ${describe(cause)}`);
      }
    } else {
      log("  faults     this ECU describes no readable fault request");
    }

    for (const note of finding.notes) log(`  note       ${note}`);
    log("");
    findings.push(finding);
  }

  return {
    adapter: info.version,
    strategy: driver.canStrategy,
    addressesProbed: sweep.addressesProbed,
    sweepSeconds: sweep.elapsedMs / 1000,
    found: findings,
    wrote: false,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
