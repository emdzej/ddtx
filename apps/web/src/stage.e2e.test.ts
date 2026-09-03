/**
 * Full screen gives the screen the two index columns' width, and gives it back.
 *
 * The number is the point: screens are fixed-size canvases the database chose, and on a
 * 1280px viewport the stage gets 748px of it. That is not a styling preference — a
 * regression in the grid template silently costs 532px of a screen that is already
 * being scrolled sideways, and nothing throws.
 *
 * Also pinned here: the escape hatch. Full screen removes the only two ways to choose an
 * ECU or a screen, so `Escape`, the strip control, and deselecting must all get out.
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

describe.skipIf(!runnable)("the full-screen stage", () => {
  it("hands the screen the panels' width, and every exit works", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    try {
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        // Pin the interface language: these assertions are English, and the interface
        // now follows `navigator.languages` by default, so a machine set to anything
        // else would fail them for the wrong reason.
        localStorage.setItem("ddtx.uiLocale", "en");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
        // A saved preference would start this mid-state.
        localStorage.removeItem("ddtx.stageFull");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });

      // Nothing open yet, so there is nothing to make full screen.
      expect(await page.getByRole("button", { name: "Full screen" }).isDisabled()).toBe(true);

      await page.getByText("[52]_CEPS_V1.1", { exact: true }).click();
      await page.getByRole("button", { name: "Measurement", exact: true }).first().click();
      await page.waitForSelector(".scroller", { timeout: 20_000 });

      const stageWidth = () =>
        page.evaluate(() => Math.round(document.querySelector(".stage")!.getBoundingClientRect().width));

      const docked = await stageWidth();

      await page.getByRole("button", { name: "Full screen" }).click();
      await page.waitForTimeout(300);
      const full = await stageWidth();

      // 288px of catalogue and 244px of screen list, to the pixel.
      expect(full - docked, `expected 532px back, got ${full - docked}`).toBe(532);
      expect(await page.locator(".catalogue").count()).toBe(0);
      // The strip survives: Read now and Keep reading are what you want while looking.
      expect(await page.getByRole("button", { name: "Read now" }).count()).toBe(1);
      // Widening the stage must not widen the document.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(await page.evaluate(() => document.documentElement.clientWidth));

      // ── every way out ────────────────────────────────────────────────────────
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(await stageWidth()).toBe(docked);

      await page.keyboard.press("f");
      await page.waitForTimeout(250);
      expect(await stageWidth()).toBe(full);

      await page.getByRole("button", { name: "Dock the screen" }).click();
      await page.waitForTimeout(250);
      expect(await stageWidth()).toBe(docked);

      // ── the preference is remembered ─────────────────────────────────────────
      await page.keyboard.press("f");
      await page.waitForTimeout(250);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });
      await page.waitForTimeout(600);
      // Remembered, but no screen is open after a reload — so the panels are back and
      // the user is not stranded without a catalogue.
      expect(await page.locator(".catalogue").count()).toBe(1);

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("hands the keyboard to the about dialog while it is open", async () => {
    // The about dialog is reached from the wordmark, and its `Escape` has to beat the
    // stage's. Both listen on `window`, so without the guard one keypress does two
    // things: closing the dialog would also dock the screen behind it, and `F` would
    // resize a stage the user cannot even see.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));

    try {
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        // Pin the interface language: these assertions are English, and the interface
        // now follows `navigator.languages` by default, so a machine set to anything
        // else would fail them for the wrong reason.
        localStorage.setItem("ddtx.uiLocale", "en");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
        localStorage.removeItem("ddtx.stageFull");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });

      await page.getByText("[52]_CEPS_V1.1", { exact: true }).click();
      await page.getByRole("button", { name: "Measurement", exact: true }).first().click();
      await page.waitForSelector(".scroller", { timeout: 20_000 });

      const stageWidth = () =>
        page.evaluate(() =>
          Math.round(document.querySelector(".stage")!.getBoundingClientRect().width),
        );
      const docked = await stageWidth();
      const dialog = page.locator('[aria-label="About ddtx"]');

      await page.getByRole("button", { name: "DDTX" }).click();
      await page.waitForSelector('[aria-label="About ddtx"]', { timeout: 10_000 });

      // The guide is the point of the dialog, so the link has to be right — a 404 here
      // is invisible until someone clicks it.
      expect(await dialog.getByRole("link", { name: "Read the user guide" }).getAttribute("href")).toBe(
        "https://github.com/emdzej/ddtx/blob/main/docs/user-guide.md",
      );

      await page.keyboard.press("f");
      await page.waitForTimeout(250);
      expect(await stageWidth(), "F resized the stage behind the dialog").toBe(docked);
      expect(await dialog.count(), "F closed the dialog").toBe(1);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      expect(await dialog.count(), "Escape did not close the dialog").toBe(0);
      expect(await stageWidth(), "Escape reached the stage as well as the dialog").toBe(docked);

      // Closed, the shortcut works again.
      await page.keyboard.press("f");
      await page.waitForTimeout(250);
      expect(await stageWidth()).toBeGreaterThan(docked);

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
