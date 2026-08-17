/**
 * The measurement logic is what the phase-0 conclusion rests on, so it is tested
 * rather than trusted. A wrong percentile or a hint that fires on jitter would
 * send the driver design down the wrong path.
 */

import { describe, expect, it } from "vitest";
import { latencyFloorHint, measure, summarise } from "./bench.js";

describe("summarise", () => {
  it("reports percentiles from the sorted samples", () => {
    const stats = summarise("t", [5, 1, 3, 2, 4]);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.p50).toBe(3);
    expect(stats.mean).toBe(3);
    expect(stats.count).toBe(5);
  });

  it("survives an empty run rather than dividing by zero", () => {
    expect(summarise("t", [])).toMatchObject({ count: 0, p50: 0, mean: 0, stdDev: 0 });
  });

  it("measures spread, which is what separates a floor from jitter", () => {
    const flat = summarise(
      "flat",
      Array.from({ length: 50 }, () => 17),
    );
    const noisy = summarise(
      "noisy",
      Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 1 : 40)),
    );
    expect(flat.stdDev).toBe(0);
    expect(noisy.stdDev).toBeGreaterThan(15);
  });
});

describe("latencyFloorHint", () => {
  it("recognises the 16 ms FTDI latency timer", () => {
    // Tight cluster just above 16 ms: the host waits for the timer every time.
    const samples = Array.from({ length: 40 }, (_, i) => 16.2 + (i % 3) * 0.2);
    const hint = latencyFloorHint(summarise("AT", samples));
    expect(hint).toContain("16 ms");
    expect(hint).toContain("latency timer");
  });

  it("recognises a multiple of the timer period", () => {
    // Two round trips per exchange lands near 32 ms.
    const samples = Array.from({ length: 40 }, (_, i) => 32.1 + (i % 3) * 0.3);
    expect(latencyFloorHint(summarise("AT", samples))).toContain("2×16 ms");
  });

  it("stays silent on a long tail, which is jitter rather than a floor", () => {
    // Low p50 with occasional stalls: scheduling noise, not pacing.
    const samples = [...Array.from({ length: 38 }, () => 1.1), 40, 60];
    expect(latencyFloorHint(summarise("AT", samples))).toBeNull();
  });

  it("stays silent on too few samples to mean anything", () => {
    expect(latencyFloorHint(summarise("AT", [16, 16, 16]))).toBeNull();
  });

  it("stays silent when the link is genuinely fast", () => {
    // Sub-millisecond with spread: nothing is pacing us.
    const samples = Array.from({ length: 40 }, (_, i) => 0.2 + (i % 5) * 0.15);
    expect(latencyFloorHint(summarise("AT", samples))).toBeNull();
  });
});

describe("measure", () => {
  it("discards the warm-up, which is routinely an outlier", async () => {
    // The first exchange after a protocol change is much slower; including it
    // would skew max and stdDev, the two numbers this is for.
    let call = 0;
    let clock = 0;
    const stats = await measure(
      "t",
      3,
      () => {
        call += 1;
        clock += call === 1 ? 500 : 10;
        return Promise.resolve();
      },
      { warmUp: 1, now: () => clock },
    );

    expect(call).toBe(4); // 1 warm-up + 3 measured
    expect(stats.count).toBe(3);
    expect(stats.max).toBe(10);
  });

  it("runs exactly the requested number of iterations", async () => {
    let calls = 0;
    const stats = await measure(
      "t",
      7,
      () => {
        calls += 1;
        return Promise.resolve();
      },
      { warmUp: 0, now: () => 0 },
    );
    expect(calls).toBe(7);
    expect(stats.count).toBe(7);
  });
});
