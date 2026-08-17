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

import { readFileSync } from "node:fs";
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
import { requiredResponseBytes } from "@ddtx/link";
import { ScreenRuntime } from "@ddtx/screens";
import { listPorts, looksLikeAdapter, NodeSerialTransport } from "./nodeSerial.js";
import { formatStats, latencyFloorHint, measure, STATS_HEADER } from "./bench.js";

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

function parseArgs(argv: readonly string[]): Args {
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

/**
 * Replies for `--mock` built from the ECU's own definitions.
 *
 * Without this, `read --mock` shows NO DATA for everything: the transport-level
 * mock only knows the handful of frames hard-coded above, not this ECU's requests.
 * Using the database's stored `replybytes`, extended to the length the fields
 * need, is the same rule demo mode applies — so `read --mock` exercises the whole
 * stack and is a fair rehearsal for the real thing.
 *
 * Deterministic filler, not random: a rehearsal should give the same answer twice.
 */
function repliesFromEcu(ecu: LoadedEcu): Record<string, string> {
  const map: Record<string, string> = {};

  for (const request of ecu.requests.values()) {
    const sent = (request.def.sentbytes ?? "").toUpperCase();
    if (sent.length === 0) continue;

    const canned = (request.def.replybytes ?? "").toUpperCase();
    const needed = requiredResponseBytes(request);
    // Lead with the positive-response SID when nothing is stored: `firstbyte` is
    // 1-based including it, and some screens read byte 1 directly.
    const sid = ((Number.parseInt(sent.slice(0, 2), 16) + 0x40) & 0xff)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0");
    let reply = canned.length > 0 ? canned : sid;

    // Filler derived from the request name, so a screen looks the same each run.
    let seed = 0x811c9dc5;
    for (const ch of request.def.name) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x01000193);
    while (reply.length / 2 < needed) {
      seed = (Math.imul(seed, 48271) + 11) >>> 0;
      reply += ((seed >>> 16) & 0xff).toString(16).toUpperCase().padStart(2, "0");
    }

    // First definition wins, matching the original's dict-keyed lookup.
    map[sent] ??= reply;
  }
  return map;
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
        const answer = respondWithPayload({
          "2110": "610BB87801",
          "2180": "6180" + "AA".repeat(24),
          "1003": "5003",
          "10C0": "50C0",
          "3E": "7E",
          // The bench's multi-frame request. Keyed on the request as reassembled,
          // with no padding: the driver pads nothing on the way out.
          [BENCH_LONG_REQUEST]: "6E0100",
          ...(shape.replies ?? {}),
        });
        // Wrapped so a multi-frame request is answered once, after its last
        // frame, as a real adapter does.
        return shape.isotp === false ? answer : reassemblingHandler(answer);
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
    replies: repliesFromEcu(ecu),
    isotp: protocolName === "CAN",
  });
  const driver = makeDriver(transport, args);
  await transport.open();

  try {
    await driver.identify();

    // Address the ECU the way its own definition says to.
    const protocol = protocolName;
    if (protocol === "CAN") {
      await driver.initCan();
      await driver.setCanAddress({
        idTx: ecu.def.obd.send_id ?? "7E0",
        idRx: ecu.def.obd.recv_id ?? "7E8",
        ecuname: ecu.def.ecuname,
        ...(ecu.def.obd.baudrate === undefined ? {} : { baudrate: ecu.def.obd.baudrate }),
      });
    } else if (protocol === "ISO8") {
      await driver.initIso();
      await driver.setIso8Address(ecu.def.obd.funcaddr);
    } else {
      await driver.initIso();
      // `fastinit: false` in the database means the ECU wants slow init.
      await driver.setIsoAddress(ecu.def.obd.funcaddr, {
        slowInit: ecu.def.obd.fastinit === false,
      });
    }

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
