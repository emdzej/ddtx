/**
 * Content that outgrows its box: scrollbars you can see, names that stay in their panel.
 *
 * Both of these were invisible to every other kind of test.
 *
 * The scrollbars: macOS draws overlay scrollbars, which appear during a gesture and
 * fade. A wheel scrolls vertically, so the vertical bar shows itself and the horizontal
 * one never does — a screen wider than the stage looked clipped rather than scrollable,
 * even though `scrollLeft` moved perfectly well. `::-webkit-scrollbar` opts out of
 * overlay scrollbars, but Chromium *ignores* those rules on any element that also sets
 * `scrollbar-width` or `scrollbar-color` — which `app.css` did, on `*`. So the fix and
 * the thing that disabled the fix were forty lines apart in the same file, and nothing
 * failed. Asserting the scrollbar takes real width is the only way to notice.
 *
 * The names: ECU names are identifiers, and `15-40_V35_CAN_V_MESSAGE_LIST_OFFICIAL_04_
 * 03_2016` is one unbreakable 47-character word. It set the row's min-content width and
 * spilled the catalogue and the screen-list header over their dividers onto the canvas.
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

/** The longest name in the database, and the ECU the overflow was reported on. */
const LONG_NAME = "15-40_V35_CAN_V_MESSAGE_LIST_OFFICIAL_04_03_2016";

describe.skipIf(!runnable)("content that outgrows its box", () => {
  it("keeps the scrollbar rules effective, and long names inside their panel", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    // Deliberately narrow: wide enough for the three columns, too narrow for a
    // 1125px canvas, so the stage must scroll in both directions at once.
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
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
        localStorage.removeItem("ddtx.stageFull");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("main", { timeout: 30_000 });

      // ── the two rules that cancelled each other ──────────────────────────────
      // Not measured, because scrollbar width is not observable in a headless
      // browser — it reserves nothing whether the scrollbars are overlay or not, so
      // an assertion on the reserved width passes and fails for the wrong reasons.
      // The cause is deterministic, though: Chromium drops `::-webkit-scrollbar` on
      // any element that also sets `scrollbar-width` or `scrollbar-color`, so those
      // standard properties must stay fenced behind the `@supports` that excludes the
      // engines with the pseudo-elements.
      const rules = await page.evaluate(() => {
        let webkitWidth: string | null = null;
        const unfenced: string[] = [];

        const walk = (list: CSSRuleList, condition: string | null): void => {
          for (const rule of list) {
            if (rule instanceof CSSStyleRule) {
              if (rule.selectorText.includes("::-webkit-scrollbar")) {
                if (rule.style.width !== "") webkitWidth = rule.style.width;
              } else if (
                rule.style.getPropertyValue("scrollbar-width") !== "" ||
                rule.style.getPropertyValue("scrollbar-color") !== ""
              ) {
                // Fenced only if the guard is about the pseudo-element itself.
                if (condition === null || !condition.includes("::-webkit-scrollbar")) {
                  unfenced.push(`${condition ?? "(top level)"} → ${rule.selectorText}`);
                }
              }
            } else if (rule instanceof CSSSupportsRule) {
              walk(rule.cssRules, rule.conditionText);
            } else if ("cssRules" in rule) {
              walk((rule as CSSGroupingRule).cssRules, condition);
            }
          }
        };

        for (const sheet of document.styleSheets) {
          try {
            walk(sheet.cssRules, null);
          } catch {
            // A cross-origin sheet, which this app has none of.
          }
        }
        return { webkitWidth, unfenced };
      });

      expect(rules.webkitWidth, "no ::-webkit-scrollbar width, so macOS draws overlay bars").toBe(
        "10px",
      );
      expect(
        rules.unfenced,
        `scrollbar-width/color outside the @supports fence disables every ` +
          `::-webkit-scrollbar rule in Chromium: ${JSON.stringify(rules.unfenced)}`,
      ).toEqual([]);

      // ── the long name stays in its panel ─────────────────────────────────────
      await page
        .locator(".catalogue li button, .catalogue .ecu")
        .filter({ hasText: LONG_NAME })
        .first()
        .click();
      await page.waitForTimeout(900);

      const spilling = await page.evaluate(() => {
        const out: { selector: string; text: string; over: number }[] = [];
        const pairs: [string, string][] = [
          [".catalogue .name", ".catalogue"],
          [".catalogue .meta", ".catalogue"],
          [".contents h2", ".contents"],
        ];
        for (const [selector, panel] of pairs) {
          for (const element of document.querySelectorAll(selector)) {
            const box = element.closest(panel)?.getBoundingClientRect();
            const own = element.getBoundingClientRect();
            if (box !== undefined && own.right > box.right + 0.5) {
              out.push({
                selector,
                text: (element.textContent ?? "").trim().slice(0, 50),
                over: Math.round(own.right - box.right),
              });
            }
          }
        }
        return out;
      });
      expect(spilling, `text past its panel edge: ${JSON.stringify(spilling)}`).toEqual([]);

      // ── the canvas plate keeps its trailing padding ───────────────────────────
      // A screen with a 9000-twip canvas, which at 1:8 is 1125px — wider than the
      // stage at this viewport, so it is genuinely scrolled sideways.
      await page
        .locator(".catalogue li button, .catalogue .ecu")
        .filter({ hasText: "1540___Head_Up_Display___D2 sample" })
        .first()
        .click();
      await page.waitForTimeout(900);
      await page.locator(".contents li button").first().click();
      await page.waitForSelector(".scroller", { timeout: 20_000 });
      await page.waitForTimeout(400);

      const scrolled = await page.evaluate(() => {
        const scroller = document.querySelector(".scroller") as HTMLElement;
        scroller.scrollLeft = 99_999;
        const frame = scroller.querySelector(".frame") as HTMLElement;
        return {
          maxScrollLeft: scroller.scrollLeft,
          gapAfterFrame: Math.round(
            scroller.getBoundingClientRect().right - frame.getBoundingClientRect().right,
          ),
        };
      });

      // Scrollable sideways at all — the symptom was reported as a missing scrollbar,
      // but this held throughout: the bar was invisible, not absent.
      expect(scrolled.maxScrollLeft).toBeGreaterThan(0);
      // Overflow past a block's edge does not extend the scroll area, so the plate is
      // sized to its content — otherwise its right edge sits flush against the end of
      // the scroll with no padding at all.
      expect(scrolled.gapAfterFrame, "the plate lost its trailing padding").toBe(24);

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
