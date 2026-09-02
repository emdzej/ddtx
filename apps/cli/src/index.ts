#!/usr/bin/env node
/**
 * ddtx CLI — drive the ELM327 driver from a terminal.
 *
 * Exists mainly so the phase-0 car session produces numbers instead of
 * impressions. Everything above the transport is the same code the browser runs,
 * so a measurement here transfers, and `--mock` runs every command against the
 * scripted adapter so the command structure and output format are exercised
 * without hardware.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ElmDriver,
  ElmLink,
  MockElm,
  reassemblingHandler,
  respondWithPayload,
  type CanStrategy,
  type ElmTransport,
} from "@ddtx/elm";
import { EcuDatabase, type DbSource, type LoadedEcu } from "@ddtx/db";
import { ScreenRuntime } from "@ddtx/screens";
import {
  attachEcu,
  clearDtcs,
  describeAttachment,
  dtcClearRequestName,
  readDtcs,
  scanAll,
  scanCan,
  scanKline,
  simulatedReplies,
} from "@ddtx/session";
import { listPorts, looksLikeAdapter, NodeSerialTransport } from "./nodeSerial.js";
import { formatStats, latencyFloorHint, measure, STATS_HEADER } from "./bench.js";
import { runCheckup } from "./checkup.js";

/**
 * The multi-frame request `bench` uses: 11 bytes, so two frames out.
 *
 * Shared with the mock's handler so the two cannot drift — a mismatch there shows
 * up as a NO DATA row that looks like an adapter problem.
 */
const BENCH_LONG_REQUEST = `2E0100${"11".repeat(8)}`;

const USAGE = `ddtx — ELM327 diagnostics from the terminal

  ddtx ports
      List serial ports, marking those that look like an OBD adapter.

  ddtx probe   --port <path> [--baud <n>] [--strategy manual|stpx|cfc0]
      Reset the adapter, identify it, and report its capabilities.

  ddtx bench   --port <path> [--baud <n>] [--iterations <n>] [--ecu <slug>]
      Measure round-trip latency at three distances from the host. This is the
      phase-0 instrument — see apps/cli/src/bench.ts for what the numbers mean.

  ddtx read    --port <path> --ecu <slug> --screen <name> [--tree <dir>]
      Connect to an ECU and read one screen, printing values and the bus trace.

  ddtx scan    --port <path> [--vehicle <code>] [--bus can|kline|both] [--tree <dir>]
      Sweep the bus and report which ECUs are actually fitted. Read-only.
      Narrow it with --vehicle (a project code such as x70): a full sweep is
      over 100 addresses where a given vehicle has a few dozen.
      --bus defaults to both, which matters — Master II is 15 K-line ECUs to 2
      on CAN, so a CAN-only sweep would miss most of it.

  ddtx dtc     --port <path> --ecu <slug> [--clear] [--tree <dir>]
      Read stored trouble codes. --clear erases them, which is irreversible and
      asks first.

  ddtx checkup --port <path> [--vehicle <code>] [--bus can|kline|both]
               [--samples <n>] [--tree <dir>] [--json <file>]
      Everything worth measuring on a vehicle, in one **read-only** pass: adapter,
      link timing, a sweep for fitted ECUs, then per module its identity, real
      response timing, whether long replies survive flow control, and its stored
      faults. Writes nothing — no clears, no actuations. Start here on a car.

  ddtx screens --ecu <slug> [--tree <dir>]
      List an ECU's screens. Needs no adapter.

Common flags
  --mock            Run against a scripted adapter instead of a real port.
  --tree <dir>      Database tree (default: data/tree).
  --verbose         Print every command and reply.
`;

interface Args {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

function parseArgs(argvIn: readonly string[]): Args {
  let argv = argvIn;
  // `pnpm cli -- checkup` forwards the `--` as a real argument, so the first token
  // becomes `--` and every command looks unknown — a usage dump instead of the thing
  // asked for. Dropping a leading bare `--` costs nothing and `pnpm cli checkup` and
  // `pnpm cli -- checkup` then behave the same.
  if (argv[0] === "--") argv = argv.slice(1);

  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    // A flag followed by a non-flag takes it as a value; otherwise it's boolean.
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      booleans.add(name);
    }
  }
  return { command: positional[0] ?? "", flags, booleans };
}

/** Read the tree off local disk — the CLI has no HTTP server to go through. */
function fileSource(root: string): DbSource {
  return {
    read: (path) => Promise.resolve(new Uint8Array(readFileSync(join(root, path)))),
  };
}

/**
 * The transport for this invocation.
 *
 * `--mock` answers a handful of requests so the command paths are exercised; it
 * is not a vehicle simulator, and `bench` against it measures the harness rather
 * than any hardware.
 */
interface MockShape {
  replies?: Record<string, string>;
  /**
   * Does the ECU speak ISO-TP over CAN?
   *
   * It matters because K-line requests are written raw, with no PCI byte, so a
   * request like `2110` would otherwise be misread as a consecutive frame — its
   * first nibble is 2. Only CAN traffic gets the reassembling wrapper.
   */
  isotp?: boolean;
}

function makeTransport(args: Args, shape: MockShape = {}): ElmTransport {
  if (args.booleans.has("mock")) {
    return new MockElm({
      version: "ELM327 v1.5 (mock)",
      ...(args.flags.get("mock-stn") === undefined
        ? {}
        : { stnVersion: args.flags.get("mock-stn") }),
      latencyMs: Number(args.flags.get("mock-latency") ?? "0"),
      onFrame: (() => {
        const isotp = shape.isotp !== false;
        const answer = respondWithPayload(
          {
            "2110": "610BB87801",
            "2180": "6180" + "AA".repeat(24),
            "1003": "5003",
            "10C0": "50C0",
            "3E": "7E",
            // The bench's multi-frame request. Keyed on the request as reassembled,
            // with no padding: the driver pads nothing on the way out.
            [BENCH_LONG_REQUEST]: "6E0100",
            ...(shape.replies ?? {}),
          },
          { isotp },
        );
        // Wrapped so a multi-frame request is answered once, after its last
        // frame, as a real adapter does. Only meaningful on CAN.
        return isotp ? reassemblingHandler(answer) : answer;
      })(),
    });
  }

  const port = args.flags.get("port");
  if (port === undefined) fail("--port is required (or use --mock)");
  return new NodeSerialTransport(port, { baudRate: Number(args.flags.get("baud") ?? "38400") });
}

function makeDriver(transport: ElmTransport, args: Args): ElmDriver {
  const strategy = args.flags.get("strategy") as CanStrategy | undefined;
  const verbose = args.booleans.has("verbose");
  return new ElmDriver(transport, {
    ...(strategy === undefined ? {} : { strategy }),
    ...(verbose
      ? {
          onExchange: ({ sent, received, elapsedMs }) => {
            const reply = received.replace(/\n/g, "⏎").replace(/>$/, "");
            process.stdout.write(
              `  → ${sent.padEnd(22)} ← ${reply}  (${elapsedMs.toFixed(1)} ms)\n`,
            );
          },
        }
      : {}),
  });
}

function fail(message: string): never {
  process.stderr.write(`ddtx: ${message}\n`);
  process.exit(2);
}

/* ── commands ────────────────────────────────────────────────────────────── */

async function cmdPorts(): Promise<void> {
  const ports = await listPorts();
  if (ports.length === 0) {
    process.stdout.write("No serial ports found.\n");
    return;
  }
  process.stdout.write(`${ports.length} serial port(s):\n`);
  for (const port of ports) {
    const mark = looksLikeAdapter(port) ? "*" : " ";
    const id = [port.vendorId, port.productId].filter(Boolean).join(":");
    process.stdout.write(
      ` ${mark} ${port.path.padEnd(32)} ${(port.manufacturer ?? "").padEnd(24)} ${id}\n`,
    );
  }
  process.stdout.write("\n* looks like a USB-serial bridge of the kind OBD adapters use.\n");
}

async function cmdProbe(args: Args): Promise<void> {
  const transport = makeTransport(args);
  const driver = makeDriver(transport, args);

  await transport.open();
  try {
    process.stdout.write(`Adapter on ${transport.description}\n`);
    const info = await driver.identify();

    process.stdout.write(`  version        ${info.version}\n`);
    process.stdout.write(`  STN part       ${info.isStn ? (info.stnVersion ?? "yes") : "no"}\n`);
    process.stdout.write(`  STPX framing   ${info.supportsStpx ? "available" : "not available"}\n`);
    process.stdout.write(`  UART buffer    ${info.uartBufferSize} bytes\n`);
    process.stdout.write(`  CAN strategy   ${driver.canStrategy}\n`);

    if (!info.supportsStpx) {
      process.stdout.write(
        "\nNo STPX: ISO-TP is framed in software over one round trip per frame.\n" +
          "Run `ddtx bench` to see what that costs on this link.\n",
      );
    }
  } finally {
    await transport.close();
  }
}

async function cmdBench(args: Args): Promise<void> {
  const transport = makeTransport(args);
  const driver = makeDriver(transport, args);
  const iterations = Number(args.flags.get("iterations") ?? "40");

  await transport.open();
  try {
    const info = await driver.identify();
    process.stdout.write(
      `${info.version}${info.isStn ? ` / ${info.stnVersion ?? "STN"}` : ""} on ${transport.description}\n` +
        `strategy ${driver.canStrategy}, ${iterations} iterations each\n\n`,
    );

    const results = [];

    // 1. Adapter only — no bus. The pure host↔adapter round trip.
    results.push(await measure("AT (adapter only)", iterations, () => driver.sendRaw("AT")));

    await driver.initCan();
    await driver.setCanAddress({ idTx: "7E0", idRx: "7E8", ecuname: "bench" });

    // 2. One frame out, one back.
    results.push(
      await measure("single-frame request", iterations, async () => {
        driver.clearCache();
        await driver.request("2110", { cache: false });
      }),
    );

    // 3. A long *response*: one frame out, several back. The adapter buffers the
    //    reply, so this is still a single round trip — it isolates read volume
    //    from round-trip count.
    results.push(
      await measure("long response (1 write)", iterations, async () => {
        driver.clearCache();
        await driver.request("2180", { cache: false });
      }),
    );

    // 4. A multi-frame *request*: the driver writes each frame separately and
    //    waits for a prompt between them, so this is the row that multiplies by
    //    round-trip latency — the closest proxy for what `cfc0` would cost.
    results.push(
      await measure("multi-frame request (2 writes)", iterations, async () => {
        driver.clearCache();
        await driver.request(BENCH_LONG_REQUEST, { cache: false });
      }),
    );

    process.stdout.write(`${STATS_HEADER}\n`);
    for (const stats of results) process.stdout.write(`${formatStats(stats)}\n`);

    process.stdout.write("\nReading these numbers\n");
    const baseline = results[0];
    if (baseline !== undefined) {
      const hint = latencyFloorHint(baseline);
      if (hint !== null) {
        process.stdout.write(`  ${hint}.\n`);
        process.stdout.write(
          "  A fixed floor per exchange means `cfc0` would pay it for every flow-control\n" +
            "  frame we owe the ECU, so prefer STPX hardware or the `manual` strategy.\n",
        );
      } else {
        process.stdout.write(
          `  Adapter round trip p50 ${baseline.p50.toFixed(1)} ms with sd ${baseline.stdDev.toFixed(1)} —\n` +
            "  no obvious fixed floor. `cfc0` may be viable; compare the multi-frame row.\n",
        );
      }
    }
    const single = results[1];
    const longReply = results[2];
    const twoWrites = results[3];
    if (single !== undefined && longReply !== undefined && single.p50 > 0) {
      process.stdout.write(
        `  A long response costs ${(longReply.p50 / single.p50).toFixed(1)}× a short one —\n` +
          "  the adapter buffers the reply, so this is read volume, not round trips.\n",
      );
    }
    if (single !== undefined && twoWrites !== undefined && single.p50 > 0) {
      const ratio = twoWrites.p50 / single.p50;
      process.stdout.write(
        `  A 2-frame request costs ${ratio.toFixed(1)}× a 1-frame one. Near 2× means each\n` +
          "  write pays the full round trip, which is what `cfc0` would do for every\n" +
          "  flow-control frame owed to the ECU. Near 1× means writes pipeline.\n",
      );
    }
    process.stdout.write(`\nAdapter error counts: ${JSON.stringify(driver.errors)}\n`);
  } finally {
    await transport.close();
  }
}

/**
 * The read-only battery, for a first session on a vehicle.
 *
 * Composed from `scanAll`/`scanCan`/`scanKline` and the session helpers rather than
 * reimplementing any of it, so what it measures is exactly what the app does.
 */
async function cmdCheckup(args: Args): Promise<void> {
  const db = await EcuDatabase.open(fileSource(args.flags.get("tree") ?? "data/tree"));
  const bus = args.flags.get("bus") ?? "both";
  const sweep = bus === "can" ? scanCan : bus === "kline" ? scanKline : scanAll;
  const samples = Number.parseInt(args.flags.get("samples") ?? "12", 10);

  const transport = makeTransport(args);
  const driver = makeDriver(transport, args);
  await transport.open();

  try {
    const report = await runCheckup(driver, db, sweep, {
      ...(args.flags.get("vehicle") === undefined
        ? {}
        : { project: args.flags.get("vehicle") as string }),
      bus: bus as "can" | "kline" | "both",
      samples: Number.isFinite(samples) ? samples : 12,
      log: (line) => process.stdout.write(`${line}\n`),
    });

    process.stdout.write(`\n${report.found.length} module(s) examined, nothing written.\n`);

    const unrecognised = report.found.filter((f) => f.slug === undefined).length;
    if (unrecognised > 0) {
      process.stdout.write(
        `${unrecognised} answered without a catalogue entry — worth reporting upstream.\n`,
      );
    }
    const stalls = report.found.reduce((sum, f) => sum + (f.timing?.over50ms ?? 0), 0);
    const frameErrors = report.found.reduce((sum, f) => sum + (f.frameErrors ?? 0), 0);
    const multi = report.found.reduce((sum, f) => sum + (f.multiFrameReplies ?? 0), 0);
    process.stdout.write(
      `${multi} multi-frame repl${multi === 1 ? "y" : "ies"}, ` +
        `${frameErrors} frame error(s), ${stalls} exchange(s) over 50 ms.\n`,
    );
    const anyCan = report.found.some((f) => f.bus.toLowerCase().startsWith("can"));
    if (anyCan && multi > 0 && frameErrors === 0) {
      // The question `cfc0` exists for: does the adapter's own flow control hold?
      process.stdout.write(
        "Multi-frame CAN replies arrived intact, so the adapter's own flow control " +
          "(AT CFC1) held.\n",
      );
    } else if (!anyCan) {
      // Said explicitly, because the first run of this printed the CFC1 conclusion on a
      // purely K-line vehicle, where there is no flow control to hold.
      process.stdout.write(
        "K-line only: ISO-TP flow control was never exercised, so nothing here speaks " +
          "to AT CFC1 or cfc0.\n",
      );
    }

    const out = args.flags.get("json");
    if (out !== undefined) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      process.stdout.write(`\nwrote ${out}\n`);
    }
  } finally {
    await transport.close();
  }
}

async function cmdScreens(args: Args): Promise<void> {
  const slug = args.flags.get("ecu");
  if (slug === undefined) fail("--ecu <slug> is required");

  const db = await EcuDatabase.open(fileSource(args.flags.get("tree") ?? "data/tree"));
  const summary = db.summary(slug);
  if (summary === undefined) fail(`no ECU named ${slug} in the index`);

  const ecu = await db.loadEcu(slug);
  const layout = await db.loadLayout(slug);

  process.stdout.write(
    `${summary.ecuname}  [${summary.group}]  addr ${summary.address}  ${summary.protocol}\n`,
  );
  process.stdout.write(
    `${ecu.requests.size} requests, ${ecu.data.size} values, ${layout.screens.size} screens\n\n`,
  );
  for (const category of layout.categories) {
    process.stdout.write(`${category.name}\n`);
    for (const name of category.screens) {
      const screen = layout.screens.get(name);
      const bound = screen?.widgets.filter((w) => w.dataName !== null).length ?? 0;
      process.stdout.write(`    ${name.padEnd(46)} ${String(bound).padStart(4)} values\n`);
    }
  }
  if (layout.warnings.length > 0) {
    process.stdout.write(`\n${layout.warnings.length} unresolved reference(s) were left out.\n`);
  }
}

async function cmdRead(args: Args): Promise<void> {
  const slug = args.flags.get("ecu");
  const screenName = args.flags.get("screen");
  if (slug === undefined) fail("--ecu <slug> is required");
  if (screenName === undefined) fail("--screen <name> is required");

  const db = await EcuDatabase.open(fileSource(args.flags.get("tree") ?? "data/tree"));
  const ecu = await db.loadEcu(slug);
  const layout = await db.loadLayout(slug);
  const screen = layout.screens.get(screenName);
  if (screen === undefined) {
    fail(`no screen named ${JSON.stringify(screenName)} — try \`ddtx screens --ecu ${slug}\``);
  }

  const protocolName = ecu.def.obd.protocol.toUpperCase();
  const transport = makeTransport(args, {
    replies: simulatedReplies(ecu),
    isotp: protocolName === "CAN",
  });
  const driver = makeDriver(transport, args);
  await transport.open();

  try {
    await driver.identify();

    // Address the ECU the way its own definition says to.
    const attachment = await attachEcu(driver, ecu);
    process.stdout.write(`attached: ${describeAttachment(attachment)}\n`);

    const runtime = new ScreenRuntime(ecu, screen, new ElmLink(driver));
    await runtime.runPresend();
    const snapshot = await runtime.refresh();

    process.stdout.write(`\n${ecu.def.ecuname} — ${screenName}\n`);
    process.stdout.write(`${runtime.plan.length} request(s), ${snapshot.elapsedMs} ms\n\n`);

    for (const widget of screen.widgets) {
      if (widget.dataName === null) continue;
      const value = snapshot.values.get(widget.id);
      const unit = ecu.data.get(widget.dataName)?.unit ?? "";
      const shown = value?.value ?? "";
      const flag = value?.status === "ok" ? " " : "!";
      process.stdout.write(
        `${flag} ${widget.label.slice(0, 48).padEnd(50)}${shown.padStart(18)} ${unit}\n`,
      );
    }

    process.stdout.write("\nbus trace\n");
    for (const exchange of snapshot.exchanges) {
      const note =
        exchange.rejected !== undefined
          ? `  ${exchange.rejected.code} ${exchange.rejected.message}`
          : exchange.error !== undefined
            ? `  ${exchange.error}`
            : "";
      process.stdout.write(
        `  ${exchange.requestName.slice(0, 34).padEnd(36)} → ${exchange.sent.padEnd(14)} ← ${exchange.received}${note}\n`,
      );
    }
  } finally {
    await transport.close();
  }
}

async function cmdScan(args: Args): Promise<void> {
  const db = await EcuDatabase.open(fileSource(args.flags.get("tree") ?? "data/tree"));
  const vehicle = args.flags.get("vehicle");

  const transport = makeTransport(args);
  const driver = makeDriver(transport, args);
  await transport.open();

  try {
    const info = await driver.identify();
    process.stdout.write(
      `${info.version} on ${transport.description}\n` +
        `sweeping ${args.flags.get("bus") ?? "both"} — ` +
        `${vehicle === undefined ? "every mapped address" : `addresses used by ${vehicle}`}\n\n`,
    );

    const bus = args.flags.get("bus") ?? "both";
    const sweep = bus === "can" ? scanCan : bus === "kline" ? scanKline : scanAll;

    const report = await sweep(driver, db.index, {
      ...(vehicle === undefined ? {} : { project: vehicle }),
      onProgress: (done, total, result) => {
        // One line per address as it goes, because a sweep is slow enough that
        // silence would look like a hang.
        const mark =
          result.outcome === "identified" ? "✓" : result.outcome === "unknown-ecu" ? "?" : " ";
        const detail =
          result.outcome === "identified"
            ? (result.matches[0]?.ecuname ?? "")
            : result.outcome === "unknown-ecu"
              ? `unrecognised — supplier ${result.identity?.supplier ?? "?"}`
              : result.outcome;
        process.stdout.write(
          `[${String(done).padStart(3)}/${total}] ${mark} ${result.bus.padEnd(5)} ` +
            `${result.address.padEnd(4)} ${(result.name ?? "").slice(0, 32).padEnd(34)} ${detail}\n`,
        );
      },
    });

    process.stdout.write(
      `\n${report.found.length} of ${report.addressesProbed} addresses answered` +
        `${report.cancelled ? " (cancelled)" : ""}, ${(report.elapsedMs / 1000).toFixed(1)} s\n\n`,
    );

    for (const result of report.found) {
      process.stdout.write(`${result.bus.padEnd(5)} ${result.address}  ${result.name ?? "?"}\n`);
      const id = result.identity;
      if (id !== undefined) {
        process.stdout.write(
          `      reported  diag ${id.diagversion}  supplier ${id.supplier}  ` +
            `soft ${id.soft}  version ${id.version}   (via ${result.via})\n`,
        );
      }
      if (result.matches.length === 0) {
        process.stdout.write("      no catalogue entry describes this\n");
      }
      for (const match of result.matches.slice(0, 4)) {
        const how =
          match.quality === "exact" ? "exact" : `closest, Δversion ${match.versionDelta ?? "?"}`;
        process.stdout.write(`      ${how.padEnd(24)} ${match.ecuname}   [${match.slug}]\n`);
      }
      if (result.matches.length > 4) {
        process.stdout.write(`      … and ${result.matches.length - 4} more\n`);
      }
    }
  } finally {
    await transport.close();
  }
}

async function cmdDtc(args: Args): Promise<void> {
  const slug = args.flags.get("ecu");
  if (slug === undefined) fail("--ecu <slug> is required");

  const db = await EcuDatabase.open(fileSource(args.flags.get("tree") ?? "data/tree"));
  const ecu = await db.loadEcu(slug);

  const transport = makeTransport(args, {
    replies: simulatedReplies(ecu),
    isotp: ecu.def.obd.protocol.toUpperCase() === "CAN",
  });
  const driver = makeDriver(transport, args);
  await transport.open();

  try {
    await driver.identify();
    const attachment = await attachEcu(driver, ecu);
    process.stdout.write(`${ecu.def.ecuname} — ${describeAttachment(attachment)}\n\n`);

    const result = await readDtcs(driver, ecu, { sessionCommand: "10C0" });

    switch (result.outcome) {
      case "unsupported":
        process.stdout.write("This ECU's file describes no way to read trouble codes.\n");
        return;
      case "rejected":
        process.stdout.write(`The ECU refused: ${result.detail ?? "no reason given"}\n`);
        return;
      case "unreadable":
        process.stdout.write(`Could not read the response: ${result.detail ?? ""}\n`);
        process.stdout.write(`  raw: ${result.raw ?? ""}\n`);
        return;
      case "none":
        process.stdout.write("No stored trouble codes.\n");
        break;
      case "ok":
        process.stdout.write(
          `${result.declared} code(s) declared, ${result.records.length} read` +
            ` via ${result.requestName}\n\n`,
        );
        for (const record of result.records) {
          process.stdout.write(`  DTC #${record.index + 1}\n`);
          for (const field of record.fields) {
            const shown = field.labelled ? field.value : `${field.value} [0x${field.hex}]`;
            process.stdout.write(`      ${field.name.slice(0, 42).padEnd(44)} ${shown}\n`);
          }
        }
        break;
    }

    if (!args.booleans.has("clear")) {
      if (result.outcome === "ok") {
        process.stdout.write("\nPass --clear to erase them.\n");
      }
      return;
    }

    // Erasing is irreversible, so it asks — the CLI's equivalent of the app's
    // confirmation gate.
    const clearVia = dtcClearRequestName(ecu);
    process.stdout.write(
      `\nAbout to erase the stored codes using ` +
        `${clearVia ?? `the generic ${"14FF00"} (this ECU names no clear request)`}.\n`,
    );
    if (!(await confirm("Erase them? [y/N] "))) {
      process.stdout.write("Left alone.\n");
      return;
    }

    const cleared = await clearDtcs(driver, ecu, { sessionCommand: "10C0" });
    process.stdout.write(
      cleared.cleared
        ? `Cleared, using ${cleared.frame}${cleared.usedFallback ? " (generic frame)" : ""}.\n`
        : `Clear failed: ${cleared.detail ?? "no reason given"}\n`,
    );
  } finally {
    await transport.close();
  }
}

/** A y/N prompt on stdin. Returns false on anything that is not a yes. */
async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive: refusing is the safe default for something irreversible.
    process.stdout.write(`${prompt}(not a terminal — refusing)\n`);
    return false;
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
    });
    process.stdin.resume();
  });
}

/* ── entry ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "ports":
      await cmdPorts();
      return;
    case "probe":
      await cmdProbe(args);
      return;
    case "bench":
      await cmdBench(args);
      return;
    case "read":
      await cmdRead(args);
      return;
    case "scan":
      await cmdScan(args);
      return;
    case "dtc":
      await cmdDtc(args);
      return;
    case "checkup":
      await cmdCheckup(args);
      return;
    case "screens":
      await cmdScreens(args);
      return;
    default:
      process.stdout.write(USAGE);
      process.exit(args.command === "" ? 0 : 2);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`ddtx: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
