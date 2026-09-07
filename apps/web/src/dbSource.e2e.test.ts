/**
 * Choosing a database, in a real browser, against the real archive.
 *
 * Everything here needs a browser to be true at all: OPFS, and persistence across a
 * reload. None of it can be unit-tested.
 *
 * The flow this covers used to unpack 3,749 entries into OPFS and had to survive being
 * interrupted mid-way; it now copies one file and reads it where it lies, so what is
 * worth asserting has changed. Gone: progress phases, and a repeat import being
 * skipped by hash — there is no derived copy to compare against, so a repeat simply
 * re-copies 104 MB in about a second. Kept, because they are what a user notices: the
 * picker on first run, no picker on the second, and settings describing what is there.
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
  url !== undefined && executablePath !== undefined && archive !== undefined && existsSync(archive);

describe.skipIf(!runnable)("choosing a database in a browser", () => {
  it("stores the archive, reads it in place, and persists across a reload", async () => {
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

      await page.waitForSelector("section.install", { timeout: 20_000 });
      expect(await page.locator("main").count()).toBe(0);

      const started = Date.now();
      await page.setInputFiles("input[type=file]", archive as string);

      // One streamed copy of 104 MB, then an 88 ms open. Still generous, because CI
      // disks vary wildly — but this used to need 300 s.
      await page.waitForSelector("main", { timeout: 120_000 });
      const elapsed = Date.now() - started;
      expect(await page.locator("section.install").count()).toBe(0);

      // The catalogue is the proof the archive is readable, not just present.
      const catalogue = await page.locator("aside, .catalogue").first().innerText();
      expect(catalogue).toContain("1580");

      // Not a benchmark, a regression fence: unpacking took ~15 s and if that ever
      // comes back this is where it shows. Loose enough for a slow disk.
      expect(elapsed, `install took ${elapsed} ms`).toBeLessThan(30_000);

      // ── persistence ─────────────────────────────────────────────────────────
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 60_000 });
      // No picker and no permission prompt: this is what OPFS buys over a folder.
      expect(await page.locator("section.install").count()).toBe(0);

      // ── settings describes what is stored ───────────────────────────────────
      await page.getByRole("button", { name: /^Database$/ }).click();
      await page.waitForSelector(".dialog", { timeout: 10_000 });
      const facts = await page.locator(".dialog .facts").innerText();
      expect(facts).toContain("Stored in this browser");
      expect(facts).toContain("1580");
      // The archive itself, not an unpacked size: 104 MB rather than 1.19 GB, which is
      // the whole point of reading it in place.
      expect(facts).toMatch(/\b1\d\d MB|\b100 MB/);

      // ── a repeat re-copies, and that is fine ────────────────────────────────
      // There is no snapshot hash any more: nothing is derived from the archive, so
      // there is nothing to compare a new one against. Re-picking the same file copies
      // it again, which costs about a second rather than fifteen.
      const again = Date.now();
      await page.setInputFiles(".dialog input[type=file]", archive as string);
      await page.waitForFunction(
        () => document.querySelector(".dialog .unpacking") === null,
        undefined,
        { timeout: 120_000 },
      );
      expect(Date.now() - again, "a repeat import got slower").toBeLessThan(30_000);
      expect(await page.locator("main").count()).toBe(1);

      expect(problems).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 420_000);
});
