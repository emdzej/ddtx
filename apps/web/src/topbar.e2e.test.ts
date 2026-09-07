/**
 * The top strip stays one row, and its settings live behind popovers.
 *
 * Worth pinning because it regressed by accretion, not by a bug: every feature added one
 * more control until twelve of them needed ~1,666px, which only fits above a 1600px
 * viewport. Nothing failed — it just quietly stopped fitting on a laptop. A width budget
 * is the only thing that catches that.
 *
 * Opt-in, because it needs a dev server:
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

describe.skipIf(!runnable)("the top strip", () => {
  it("fits on one row down to 860px in every language, with no inline settings", async () => {
    // Every language, because the budget is about pixels and translations are not the
    // same width. Polish needed 49px more than English and overflowed 860px by 10 —
    // the strip still looked fine, the whole document just scrolled sideways. Asserting
    // this in English only would have shipped that.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      for (const [width, language] of [
        [1440, "en"],
        [1024, "en"],
        [860, "en"],
        [1024, "pl"],
        [860, "pl"],
      ] as [number, string][]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        await page.goto(url as string, { waitUntil: "domcontentloaded" });
        await page.evaluate((lng) => localStorage.setItem("ddtx.uiLocale", lng), language);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForTimeout(600);

        const strip = await page.evaluate(() => {
          const element = document.querySelector(".strip");
          if (element === null) return null;
          return {
            height: Math.round(element.getBoundingClientRect().height),
            overflow: element.scrollWidth - element.clientWidth,
            // Only the trigger buttons and the two read controls, not a select each for
            // language and zoom.
            selects: element.querySelectorAll(":scope > label select").length,
          };
        });

        const where = `${language} at ${width}px`;
        expect(strip, `strip missing, ${where}`).not.toBeNull();
        // One row. Two rows means it wrapped, which is the failure this guards.
        expect(strip?.height, `strip wrapped, ${where}`).toBeLessThan(40);
        expect(strip?.overflow, `strip overflows, ${where}`).toBeLessThanOrEqual(0);
        // The page must not scroll sideways either — that is how the Polish overflow
        // showed up: the strip pushed `.app` wider than the viewport.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          `the document scrolls sideways, ${where}`,
        ).toBeLessThanOrEqual(0);
        // Language and zoom belong in the View panel, not inline.
        expect(strip?.selects, `a select crept back inline, ${where}`).toBe(0);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("shows a marker on the cog only when a setting is off its default", async () => {
    // An indicator that is always on says nothing. This was written against the wrong
    // default once and the dot was permanent — and again when the `View` popover became
    // a tab, because the interface language has a default and someone reading Polish
    // would have carried a lit dot forever. It is deliberately not part of the
    // condition; what is, is the states you can forget you are in.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.setItem("ddtx.uiLocale", "pl"));
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(600);

      const dots = () => page.locator(".strip .cog .dot").count();
      // Polish, which is off the `system` default — and must not light the dot.
      expect(await dots(), "the interface language lit the dot").toBe(0);

      await page.locator(".strip .cog").click();
      await page.waitForSelector(".dialog", { timeout: 10_000 });
      await page.getByRole("tab", { name: /Widok|View/ }).click();
      const inspect = page.locator(".dialog .field.check input[type=checkbox]").last();
      await inspect.check();
      await page.waitForTimeout(150);
      expect(await dots()).toBe(1);

      await inspect.uncheck();
      await page.waitForTimeout(150);
      expect(await dots()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("closes the demo popover when the cog is clicked", async () => {
    // The outside-click handler runs in the capture phase for this reason: without it,
    // clicking straight from a popover trigger to another control leaves the panel
    // open. There used to be two popovers to move between; now the cog is the other
    // trigger, and the failure is the same one.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
      await page.goto(url as string, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);

      await page.getByRole("button", { name: /^Demo/ }).click();
      expect(await page.locator(".strip .panel").count()).toBe(1);

      await page.locator(".strip .cog").click();
      await page.waitForTimeout(150);
      expect(await page.locator(".strip .panel").count(), "the popover stayed open").toBe(0);
      expect(await page.locator(".dialog").count()).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
