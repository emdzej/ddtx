/**
 * The database install flow, in a real browser, against the real archive.
 *
 * Everything here needs a browser to be true at all: OPFS, a Worker, `crypto.subtle`,
 * and persistence across a reload. None of it can be unit-tested, and the two bugs
 * this found were both invisible to a type-checker —
 * `FileSystemDirectoryHandle.move` not existing (which fails *after* a full 11-second
 * import), and the progress label claiming "unpacking" while it was really hashing.
 *
 * Opt-in, because it needs a dev server, a browser, and a 100 MB archive:
 *
 *   pnpm dev                                                    # in one terminal
 *   DDTX_E2E_URL=http://localhost:5173 \
 *   DDTX_E2E_ZIP=data/ecu.zip pnpm test
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const url = process.env.DDTX_E2E_URL;
const zip = process.env.DDTX_E2E_ZIP;

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
const archive = zip === undefined ? undefined : resolve(zip);
const runnable =
  url !== undefined &&
  executablePath !== undefined &&
  archive !== undefined &&
  existsSync(archive);

describe.skipIf(!runnable)("installing the database in a browser", () => {
  it("imports, persists across a reload, and skips a repeat of the same archive", async () => {
    const { chromium } = await import("playwright-core");
    // A persistent profile, because the point is that OPFS survives a reload. An
    // incognito context would throw the tree away and prove nothing.
    const profile = join(process.env.TMPDIR ?? "/tmp", `ddtx-e2e-${process.pid}`);
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath,
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    try {
      // ── first run ────────────────────────────────────────────────────────────
      await page.goto(url as string, { waitUntil: "networkidle" });
      // The dev middleware serves a tree, so a saved preference could hide the
      // picker. Clearing makes this the genuine first-run path.
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle" });

      await page.waitForSelector("section.picker", { timeout: 20_000 });
      expect(await page.locator("main").count()).toBe(0);

      await page.setInputFiles("input[type=file]", archive as string);

      // 3,749 entries and 1.19 GB. Generous, because CI disks vary wildly.
      await page.waitForSelector("main", { timeout: 300_000 });
      expect(await page.locator("section.picker").count()).toBe(0);

      // The catalogue is the proof the tree is readable, not just present.
      const catalogue = await page.locator("aside, .catalogue").first().innerText();
      expect(catalogue).toContain("1580");

      // ── persistence ─────────────────────────────────────────────────────────
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 60_000 });
      // No picker and no permission prompt: this is what OPFS buys over a folder.
      expect(await page.locator("section.picker").count()).toBe(0);

      // ── settings describes what is installed ────────────────────────────────
      await page.getByRole("button", { name: /^Database$/ }).click();
      await page.waitForSelector(".dialog", { timeout: 10_000 });
      const facts = await page.locator(".dialog .facts").innerText();
      expect(facts).toContain("Unpacked in this browser");
      expect(facts).toContain("1580");

      // ── a repeat of the same archive is recognised, not redone ───────────────
      let unpacked = false;
      const watch = setInterval(() => {
        void page
          .locator(".dialog .unpacking")
          .count()
          .then((n) => {
            if (n > 0) unpacked = true;
          });
      }, 150);
      await page.setInputFiles(".dialog input[type=file]", archive as string);
      await page.waitForTimeout(8000);
      clearInterval(watch);

      // The hash matched, so the 1.19 GB was not written a second time. This is only
      // observable because the UI distinguishes hashing from unpacking.
      expect(unpacked).toBe(false);
      expect(await page.locator("main").count()).toBe(1);

      expect(problems).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 420_000);
});
