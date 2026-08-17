import { describe, expect, it } from "vitest";
import { digest, overlayKey } from "./keys.js";
import { Overlay } from "./overlay.js";

/** Build a bundle from plain source→target pairs, as the build tool does. */
async function bundleOf(entries: Array<[string, string, string]>): Promise<Record<string, string>> {
  const bundle: Record<string, string> = {};
  for (const [namespace, source, target] of entries) {
    bundle[`${namespace}:${await digest(source)}`] = target;
  }
  return bundle;
}

describe("keys", () => {
  it("is stable and namespaced", async () => {
    expect(await overlayKey("data", "Régime moteur")).toBe(`data:${await digest("Régime moteur")}`);
    // A 16-hex-char digest: 64 bits.
    expect((await digest("Régime moteur")).length).toBe(16);
  });

  it("normalises to NFC, so a decomposed é matches a composed one", async () => {
    // "é" as U+00E9 versus "e" + U+0301. The database mixes both.
    expect(await digest("Régime")).toBe(await digest("Régime"));
  });

  it("separates namespaces, so the same word can differ by role", async () => {
    expect(await overlayKey("data", "Etat")).not.toBe(await overlayKey("unit", "Etat"));
  });
});

describe("Overlay", () => {
  it("returns the translation once primed", async () => {
    const overlay = Overlay.create(
      "en",
      await bundleOf([["data", "Régime moteur", "Engine speed"]]),
    );
    await overlay.prime(["Régime moteur"]);
    expect(overlay.t("data", "Régime moteur")).toBe("Engine speed");
  });

  it("falls through to the source when there is no entry", async () => {
    const overlay = Overlay.create("en", await bundleOf([]));
    await overlay.prime(["Régime moteur"]);
    expect(overlay.t("data", "Régime moteur")).toBe("Régime moteur");
    expect(overlay.isUntranslated("data", "Régime moteur")).toBe(true);
  });

  it("falls through to the source when priming was forgotten", async () => {
    // Degrading to French beats rendering a blank cell.
    const overlay = Overlay.create(
      "en",
      await bundleOf([["data", "Régime moteur", "Engine speed"]]),
    );
    expect(overlay.t("data", "Régime moteur")).toBe("Régime moteur");
  });

  it("does not translate across namespaces", async () => {
    const overlay = Overlay.create("en", await bundleOf([["unit", "Etat", "State"]]));
    await overlay.prime(["Etat"]);
    expect(overlay.t("unit", "Etat")).toBe("State");
    expect(overlay.t("data", "Etat")).toBe("Etat");
  });

  it("prefers an ECU override, then a group override, then the global entry", async () => {
    const global = await digest("Etat");
    const overlay = Overlay.create("en", {
      [`data:${global}`]: "State",
      [`group:Injection/data:${global}`]: "Engine state",
      [`ecu:sirius/data:${global}`]: "Sirius state",
    });
    await overlay.prime(["Etat"]);

    expect(overlay.t("data", "Etat")).toBe("State");
    expect(overlay.t("data", "Etat", { group: "Injection" })).toBe("Engine state");
    expect(overlay.t("data", "Etat", { ecu: "sirius", group: "Injection" })).toBe("Sirius state");
    // A scope with no override of its own falls back to the global entry.
    expect(overlay.t("data", "Etat", { group: "ABS" })).toBe("State");
  });

  it("reports where a translation came from", async () => {
    const machine = await digest("Panne");
    const overlay = Overlay.create("en", {
      [`list:${await digest("Présent")}`]: "Present",
      [`list:${machine}`]: ["Failure", 1],
    });
    await overlay.prime(["Présent", "Panne", "Inconnu"]);

    expect(overlay.resolve("list", "Présent")).toEqual({ text: "Present", origin: "human" });
    expect(overlay.resolve("list", "Panne")).toEqual({ text: "Failure", origin: "machine" });
    expect(overlay.resolve("list", "Inconnu")).toEqual({ text: "Inconnu", origin: "source" });
  });

  it("leaves the empty string alone", async () => {
    // Empty captions are decorations, not missing translations.
    const overlay = Overlay.create("en", await bundleOf([]));
    await overlay.prime([""]);
    expect(overlay.t("data", "")).toBe("");
    expect(overlay.isUntranslated("data", "")).toBe(false);
  });

  it("never translates when no locale is chosen", async () => {
    const overlay = Overlay.none();
    await overlay.prime(["Régime moteur"]);
    expect(overlay.t("data", "Régime moteur")).toBe("Régime moteur");
    expect(overlay.size).toBe(0);
  });

  it("primes idempotently, so repeated calls per ECU are cheap", async () => {
    const overlay = Overlay.create("en", await bundleOf([["data", "A", "B"]]));
    await overlay.prime(["A", "A", "A"]);
    await overlay.prime(["A"]);
    expect(overlay.t("data", "A")).toBe("B");
  });
});
