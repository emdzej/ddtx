/**
 * These gates are the only thing between a click and bytes on a live vehicle, so
 * they are tested for what they *refuse*, not just what they allow. A gate that
 * fails open is worse than no gate, because the UI would report protection that
 * isn't there.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ADAPTER_LOCK,
  checkWriteGates,
  confirmationPrompt,
  refusalReason,
  withAdapterLock,
} from "./guard.js";

const visible = () => true;
const hidden = () => false;

describe("checkWriteGates", () => {
  it("allows a write only when every condition holds", () => {
    expect(checkWriteGates({ writesEnabled: true, live: true, isVisible: visible })).toEqual({
      allowed: true,
    });
  });

  it("refuses when writing has not been enabled", () => {
    // The default state, and the one that matters most: nothing is enabled until
    // the operator says so.
    const decision = checkWriteGates({ writesEnabled: false, live: true, isVisible: visible });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("writes-disabled");
    expect(decision.reason).toMatch(/turned off/i);
  });

  it("refuses when the tab is in the background", () => {
    // A hidden tab's timers are throttled, which can stall an ISO-TP sequence
    // between frames — mid-write is the worst place to stall.
    const decision = checkWriteGates({ writesEnabled: true, live: true, isVisible: hidden });
    expect(decision.refusal).toBe("not-visible");
    expect(decision.reason).toMatch(/background/i);
  });

  it("refuses when nothing is connected", () => {
    const decision = checkWriteGates({ writesEnabled: true, live: false, isVisible: visible });
    expect(decision.refusal).toBe("not-live");
  });

  it("checks writes-enabled before visibility, so the reason is the actionable one", () => {
    // With both wrong, telling someone to focus the tab would send them chasing
    // the wrong thing.
    const decision = checkWriteGates({ writesEnabled: false, live: true, isVisible: hidden });
    expect(decision.refusal).toBe("writes-disabled");
  });

  it("gives every refusal a plain-language reason", () => {
    for (const refusal of [
      "writes-disabled",
      "not-live",
      "not-visible",
      "lock-unavailable",
      "declined",
    ] as const) {
      expect(refusalReason(refusal).length).toBeGreaterThan(0);
    }
  });
});

describe("withAdapterLock", () => {
  it("runs the write while holding the lock", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback({}));
    const outcome = await withAdapterLock(async () => "done", { request } as never);

    expect(outcome).toEqual({ ran: true, value: "done" });
    expect(request).toHaveBeenCalledWith(
      ADAPTER_LOCK,
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    );
  });

  it("refuses rather than queueing when another tab holds it", async () => {
    // Waiting would surprise the operator, who pressed a button and saw nothing.
    const request = async (
      _name: string,
      _options: unknown,
      callback: (lock: unknown) => unknown,
    ) => callback(null);
    const outcome = await withAdapterLock(async () => "done", { request } as never);
    expect(outcome).toEqual({ ran: false, refusal: "lock-unavailable" });
  });

  it("proceeds where Web Locks is unavailable", async () => {
    // The lock is defence against a second tab, not the primary gate; refusing
    // everything on an older browser would cost more than it protects.
    const outcome = await withAdapterLock(async () => 42, undefined);
    expect(outcome).toEqual({ ran: true, value: 42 });
  });

  it("propagates a failure from the write itself", async () => {
    const request = async (
      _name: string,
      _options: unknown,
      callback: (lock: unknown) => unknown,
    ) => callback({});
    await expect(
      withAdapterLock(
        async () => {
          throw new Error("port closed");
        },
        { request } as never,
      ),
    ).rejects.toThrow("port closed");
  });
});

describe("confirmationPrompt", () => {
  it("uses the database's own warning verbatim when there is one", () => {
    // These are authored warnings about irreversible actions; replacing them with
    // something generic would lose the specific thing being warned about.
    const prompt = confirmationPrompt(
      "Effacement",
      ["Attention, effacement des pannes mémorisées !"],
      ["ClearDTC"],
    );
    expect(prompt).toBe("Attention, effacement des pannes mémorisées !");
  });

  it("joins multiple authored messages", () => {
    expect(confirmationPrompt("B", ["First.", "Second."], [])).toBe("First.\nSecond.");
  });

  it("names the requests when the database offers no warning", () => {
    // What is about to happen is more useful than "are you sure".
    const prompt = confirmationPrompt("Réinitialiser", [""], ["ResetLearned", "StopComm"]);
    expect(prompt).toContain("Réinitialiser");
    expect(prompt).toContain("ResetLearned, StopComm");
  });

  it("falls back to naming the button when it sends nothing", () => {
    expect(confirmationPrompt("Inert", [], [])).toBe("Run “Inert”?");
  });

  it("ignores whitespace-only messages, which the database is full of", () => {
    // `messages: [""]` is the common shape and means "no prompt authored".
    const prompt = confirmationPrompt("B", ["   ", ""], ["Req"]);
    expect(prompt).toContain("This sends: Req");
  });
});
