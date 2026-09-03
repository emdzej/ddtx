/**
 * The interface language: detected from the browser, overridable, remembered.
 *
 * Three things worth pinning, none of which a unit test can reach.
 *
 * The **default** is `navigator.languages`, which only a real browser context has.
 * Getting this wrong is silent — an English UI for a Polish user is not an error, just
 * a worse product.
 *
 * The **override** has to win over detection and survive a reload, and it stores the
 * *preference* rather than the resolved language: "match my browser" must keep
 * following the browser afterwards, which is exactly what `i18next-browser-language`
 * `detector`'s caching gets wrong and why it is not used here.
 *
 * Plural *selection* is not here — it needs no browser, so it lives in
 * `i18n/parity.test.ts` next to the catalogues it checks.
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

/** Points the app at the dev server's tree without pinning a language. */
const SEED = () => {
  localStorage.setItem("ddtx.dbSource", "remote");
  localStorage.setItem("ddtx.dbRemoteUrl", "/db");
  localStorage.removeItem("ddtx.uiLocale");
};

describe.skipIf(!runnable)("the interface language", () => {
  it("follows the browser, and says so in the browser's own words", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      for (const [locale, expected, readNow] of [
        ["pl-PL", "pl", "Odczytaj"],
        ["en-GB", "en", "Read now"],
        // A language with no catalogue falls back to English rather than to key names.
        ["de-DE", "en", "Read now"],
      ] as [string, string, string][]) {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const problems: string[] = [];
        page.on("pageerror", (error) => problems.push(String(error)));

        await page.goto(url as string, { waitUntil: "domcontentloaded" });
        await page.evaluate(SEED);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForSelector("main", { timeout: 30_000 });

        // `<html lang>` matters beyond looks: it drives hyphenation and screen readers.
        expect(await page.evaluate(() => document.documentElement.lang), locale).toBe(expected);
        expect(await page.locator("button.read").innerText(), locale).toBe(readNow);
        expect(problems, locale).toEqual([]);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("lets a choice beat detection, and remembers the choice not the result", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      // A Polish browser, so an English UI can only come from the override.
      const context = await browser.newContext({
        locale: "pl-PL",
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      await page.goto(url as string, { waitUntil: "domcontentloaded" });
      await page.evaluate(SEED);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });
      expect(await page.locator("button.read").innerText()).toBe("Odczytaj");

      // Widok ▾ → Interfejs → English
      await page.getByRole("button", { name: /Widok/ }).click();
      await page.waitForTimeout(200);
      await page.locator(".popover select").first().selectOption("en");
      await page.waitForTimeout(300);
      expect(await page.locator("button.read").innerText()).toBe("Read now");
      expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });
      expect(await page.locator("button.read").innerText(), "the override did not survive").toBe(
        "Read now",
      );

      // Back to following the browser — and the stored value is the preference, so it
      // resolves to Polish again rather than staying on whatever it last was.
      await page.getByRole("button", { name: /^View/ }).click();
      await page.waitForTimeout(200);
      await page.locator(".popover select").first().selectOption("system");
      await page.waitForTimeout(300);
      expect(await page.locator("button.read").innerText()).toBe("Odczytaj");
      expect(await page.evaluate(() => localStorage.getItem("ddtx.uiLocale"))).toBe("system");

      await context.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

});
