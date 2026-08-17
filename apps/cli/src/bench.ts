/**
 * Timing measurement — the phase-0 instrument.
 *
 * The open question in `docs/plan.md` §6.1 is whether software ISO-TP flow
 * control (`AT CFC0`) can work over a link whose latency we cannot control. The
 * FTDI latency timer defaults to 16 ms and cannot be changed from a web page, so
 * the question is not "is it fast enough on average" but "is there a fixed
 * per-round-trip floor, and how big is it".
 *
 * So this measures three things at increasing distance from the host, and the
 * differences between them are the answer:
 *
 *   1. `AT` — the adapter answers from its own firmware. No bus involved, so this
 *      is the pure host↔adapter round trip: UART, USB, and the driver's latency
 *      timer, and nothing else.
 *   2. single-frame request — one write, one CAN exchange, one reply.
 *   3. multi-frame request — several frames each way, so several round trips.
 *
 * If (1) clusters near a multiple of 16 ms, the latency timer is in play and
 * `cfc0` is not viable — each flow-control frame we owe the ECU would pay that
 * cost. If (1) is a millisecond or two and (3) scales with frame count, the
 * per-round-trip floor is small and `cfc0` becomes worth implementing.
 *
 * Reported as a distribution, never a mean: a mean hides exactly the periodic
 * stalls this is looking for.
 */

export interface Sample {
  label: string;
  ms: number;
}

export interface Stats {
  label: string;
  count: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  /** Standard deviation, as a quick read on how bimodal the distribution is. */
  stdDev: number;
}

export function summarise(label: string, samples: readonly number[]): Stats {
  if (samples.length === 0) {
    return { label, count: 0, min: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0, stdDev: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number;

  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;

  return {
    label,
    count: sorted.length,
    min: sorted[0] as number,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] as number,
    mean,
    stdDev: Math.sqrt(variance),
  };
}

/**
 * Does this distribution look like a fixed latency floor rather than jitter?
 *
 * The signature of the FTDI latency timer is a p50 sitting just above a multiple
 * of the timer period with little spread — the host waits for the timer on almost
 * every exchange. Jitter from scheduling looks the opposite: a low p50 with a
 * long tail.
 *
 * A hint for reading the output, not a verdict. The measurement is the evidence.
 */
export function latencyFloorHint(stats: Stats): string | null {
  if (stats.count < 10) return null;

  // Tight distribution well above zero: something is pacing us.
  const tight = stats.stdDev < stats.p50 * 0.25;
  if (!tight) return null;

  for (const period of [16, 8, 4, 2, 1]) {
    const multiples = stats.p50 / period;
    const nearMultiple = Math.abs(multiples - Math.round(multiples)) < 0.25;
    if (nearMultiple && Math.round(multiples) >= 1 && stats.p50 >= period * 0.9) {
      return `p50 sits near ${Math.round(multiples)}×${period} ms with little spread — consistent with a ${period} ms driver latency timer pacing every exchange`;
    }
  }
  return null;
}

/** One row of the report, padded so columns line up in a terminal. */
export function formatStats(stats: Stats): string {
  const ms = (value: number): string => value.toFixed(1).padStart(7);
  return (
    `${stats.label.padEnd(26)}${String(stats.count).padStart(5)}` +
    `${ms(stats.min)}${ms(stats.p50)}${ms(stats.p90)}${ms(stats.p99)}${ms(stats.max)}${ms(stats.stdDev)}`
  );
}

export const STATS_HEADER =
  `${"measurement".padEnd(26)}${"n".padStart(5)}${"min".padStart(7)}${"p50".padStart(7)}` +
  `${"p90".padStart(7)}${"p99".padStart(7)}${"max".padStart(7)}${"sd".padStart(7)}`;

/**
 * Run `iterations` timed calls, discarding a warm-up.
 *
 * The first exchange after a protocol change is routinely an order of magnitude
 * slower than the rest — the adapter is still settling — and including it would
 * skew the max and the standard deviation, which are the two numbers this is
 * actually for.
 */
export async function measure(
  label: string,
  iterations: number,
  run: () => Promise<unknown>,
  options: { warmUp?: number; now?: () => number } = {},
): Promise<Stats> {
  const warmUp = options.warmUp ?? 1;
  const now = options.now ?? (() => performance.now());

  for (let i = 0; i < warmUp; i++) await run();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = now();
    await run();
    samples.push(now() - started);
  }
  return summarise(label, samples);
}
