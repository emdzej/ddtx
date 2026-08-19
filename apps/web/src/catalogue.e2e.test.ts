/**
 * The catalogue's filters, in the order they are meant to be used.
 *
 * Vehicle first, because that is the question a user can actually answer — they know
 * which car is in front of them, not which of 171 system groups it belongs to — and
 * picking one narrows the group list rather than leaving all 171 on offer.
 *
 * Pinned because it regressed silently and the cause was invisible to every other check:
 * `VehiclePicker`'s root class is `.picker`, and a `:global(.picker) { grid-row: 3 }`
 * rule added in `App.svelte` for the *database install* screen reached into the
 * catalogue and pinned the vehicle dropdown to row 3 — below the selects, in a grid
 * whose DOM order had it first. Nothing failed, nothing type-checked wrong, and the
 * markup read correctly. Only the rendered position was wrong.
 *
 * Opt-in, and it needs a database:
 *
 *   pnpm dev
 *   DDTX_E2E_URL=http://localhost:5173 pnpm test
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const url = process.env.DDTX_E2E_URL;

function findChromium(): string | undefined {
  const explicit = process.env.DDTX_CHROMIUM;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const entry of readdirSync(cache)) {
    for (const candidate of [
      join(cache, entry, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      join(
        cache,
        entry,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const executablePath = findChromium();
const runnable = url !== undefined && executablePath !== undefined;

describe.skipIf(!runnable)("the catalogue filters", () => {
  it("puts the vehicle picker above the group and bus selects", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      // Point at the dev server's tree: startup resolves whichever source was saved, so
      // a fresh profile would land on the install screen instead of the catalogue.
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".filters .picker", { timeout: 20_000 });

      const boxes = await page.evaluate(() => {
        const filters = document.querySelector(".filters");
        const picker = filters?.querySelector(".picker");
        const selects = filters?.querySelector(".selects");
        if (picker == null || selects == null) return null;
        return {
          pickerTop: picker.getBoundingClientRect().top,
          selectsTop: selects.getBoundingClientRect().top,
        };
      });

      expect(boxes).not.toBeNull();
      // Rendered position, not DOM order — the regression had the markup right.
      expect(
        boxes?.pickerTop,
        "the vehicle picker must render above the group and bus selects",
      ).toBeLessThan(boxes?.selectsTop as number);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("narrows the group list when a vehicle is chosen", async () => {
    // The reason vehicle comes first: it makes the next choice smaller. If this stops
    // being true, the ordering is just a preference rather than a sequence.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".filters .picker", { timeout: 20_000 });

      const groupOptions = () =>
        page.locator(".filters .selects select").first().locator("option").count();
      const before = await groupOptions();

      await page.locator(".filters .picker input").click();
      await page.locator(".filters .picker input").fill("Master");
      await page.waitForTimeout(300);
      const option = page
        .locator(".filters .picker [role=option], .filters .picker li button")
        .first();
      await option.click();
      await page.waitForTimeout(500);

      const after = await groupOptions();
      expect(after, `groups did not narrow: ${before} → ${after}`).toBeLessThan(before);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
