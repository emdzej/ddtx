/**
 * The settings dialog: two sections behind one cog.
 *
 * The `View` popover and the `Database` button became tabs here. Three things are worth
 * pinning, and one of them is a decision rather than a behaviour.
 *
 * **Both bodies stay mounted**, one hidden. Switching tabs therefore keeps a half-typed
 * URL, which a remount would silently discard — a small thing that is very annoying if
 * you have just pasted a host.
 *
 * **A caller can name the tab.** "The database could not be read" opens the database
 * section, not whichever was open last.
 *
 * **The strip got shorter**, which was the point: it has a measured width budget and
 * these two controls cost 158px of it.
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

describe.skipIf(!runnable)("the settings dialog", () => {
  it("has both sections, keeps their state, and replaced two strip controls", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    try {
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
        localStorage.setItem("ddtx.uiLocale", "en");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 40_000 });

      // ── the strip lost both controls ─────────────────────────────────────────
      const strip = await page.locator(".strip").innerText();
      expect(strip, "the View trigger is still in the strip").not.toMatch(/\bView\b/);
      expect(strip, "the Database button is still in the strip").not.toMatch(/\bDatabase\b/);
      expect(await page.locator(".strip .cog").count()).toBe(1);

      // ── two tabs, database first ─────────────────────────────────────────────
      await page.locator(".strip .cog").click();
      await page.waitForSelector(".dialog", { timeout: 10_000 });
      expect(await page.locator('[role="tab"]').allInnerTexts()).toEqual(["Database", "View"]);
      expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe("Database");

      // Both bodies are in the DOM; one is hidden. That is what keeps their state.
      expect(await page.locator(".dialog .body").count()).toBe(2);

      // ── the view section holds what the popover did ──────────────────────────
      await page.getByRole("tab", { name: "View" }).click();
      // Lower-cased before matching: the eyebrow labels are uppercased by CSS, so
      // `innerText` reports "INTERFACE" and matching the authored casing would fail
      // for a reason that has nothing to do with the section's contents.
      const view = (await page.locator(".dialog .body:not(.hidden)").innerText()).toLowerCase();
      for (const label of ["interface", "database", "zoom", "inspect layout"]) {
        expect(view, `the view section lost ${label}`).toContain(label);
      }

      // ── a half-typed URL survives a tab switch ───────────────────────────────
      await page.getByRole("tab", { name: "Database" }).click();
      await page.locator(".dialog input.url").fill("http://example.test/half-typed");
      await page.getByRole("tab", { name: "View" }).click();
      await page.getByRole("tab", { name: "Database" }).click();
      expect(
        await page.locator(".dialog input.url").inputValue(),
        "switching tabs discarded the typed URL",
      ).toBe("http://example.test/half-typed");

      // ── Escape closes it ─────────────────────────────────────────────────────
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(await page.locator(".dialog").count()).toBe(0);

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("remembers which section was open", async () => {
    // The tab is state rather than a fresh default per open, so returning to settings
    // puts you back where you were. A caller can still name one — the stage's "could
    // not be read" asks for the database section explicitly — but that path is not
    // reachable from here: a source that fails to open sends startup to the picker
    // rather than to the error state, so there is no button to click.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("ddtx.dbSource", "remote");
        localStorage.setItem("ddtx.dbRemoteUrl", "/db");
        localStorage.setItem("ddtx.uiLocale", "en");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 40_000 });

      await page.locator(".strip .cog").click();
      await page.waitForSelector(".dialog");
      await page.getByRole("tab", { name: "View" }).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      await page.locator(".strip .cog").click();
      await page.waitForSelector(".dialog");
      expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe("View");
    } finally {
      await browser.close();
    }
  }, 120_000);
});
