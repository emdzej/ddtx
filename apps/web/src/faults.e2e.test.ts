/**
 * Drives the fault panel in a real browser, in demo mode.
 *
 * Worth the setup cost: writing this found three bugs that every other check passed
 * — a missing import that only fails at runtime, an erase notice wiped by the
 * re-read that confirms it, and a simulated link rebuilt per call so it forgot the
 * erase. None of those are visible to a type-checker or a unit test.
 *
 * Opt-in, because it needs a dev server and a browser:
 *
 *   pnpm dev                                   # in one terminal
 *   DDTX_E2E_URL=http://localhost:5173 pnpm test
 *
 * Set DDTX_CHROMIUM to a Chrome or Chromium binary if playwright-core's own
 * download is not present.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const url = process.env.DDTX_E2E_URL;

/** Find a usable browser: an explicit one, else any Playwright cache build. */
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

describe.skipIf(!runnable)("the fault panel, in a browser", () => {
  it("reads, expands, erases, and keeps the outcome visible", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("response", (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    try {
      // Point the app at the dev server's tree before it boots. Since the installer
      // landed, startup resolves whichever source was *saved* rather than assuming
      // `/db` — so a fresh profile lands on the picker, not the catalogue.
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        // Pin the interface language: these assertions are English, and the interface
        // now follows `navigator.languages` by default, so a machine set to anything
        // else would fail them for the wrong reason.
        localStorage.setItem("ddtx.uiLocale", "en");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
      });
      await page.reload({ waitUntil: "networkidle" });

      // A UDS ECU: fifteen status fields per record, which is the case the summary
      // line exists for.
      await page.getByText("[52]_CEPS_V1.1", { exact: true }).click();
      await page.waitForSelector("section.faults", { timeout: 15_000 });

      await page.getByRole("button", { name: /Read faults/ }).click();
      await page.waitForSelector("section.faults .row", { timeout: 15_000 });
      expect(await page.locator("section.faults .row").count()).toBe(3);

      // Records start collapsed; opening one shows every field.
      expect(await page.locator("section.faults dl").count()).toBe(0);
      await page.locator("section.faults .row").first().click();
      await page.waitForSelector("section.faults dl");
      expect(await page.locator("section.faults dl dt").count()).toBeGreaterThan(10);

      await page.getByRole("button", { name: /^Erase$/ }).click();
      await page.waitForSelector("section.faults .erased", { timeout: 15_000 });
      const panel = await page.locator("section.faults").innerText();
      // The erase outcome must survive the re-read that confirms it.
      expect(panel).toContain("Cleared with");
      expect(panel).toContain("No stored codes.");
      // Nothing left to erase, so the destructive control goes away.
      expect(await page.getByRole("button", { name: /^Erase$/ }).count()).toBe(0);

      // Selecting another ECU must not show the previous one's faults.
      await page.getByText("[52]_CEPS_V1.2", { exact: true }).click();
      await page.waitForTimeout(1500);
      expect(await page.locator("section.faults .row").count()).toBe(0);

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
