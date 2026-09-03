/**
 * Every locale carries every key, with the plural categories its language needs.
 *
 * This is a test rather than a type because i18next types its keys against one
 * language by design — `i18next.d.ts` checks call sites against `en.json` and cannot
 * say anything about `pl.json`. Without this, a key missing from Polish falls back to
 * English silently: the app still works, so nothing fails, and the gap ships.
 *
 * The plural check is the half that is easy to get wrong by hand. English needs `one`
 * and `other`; Polish needs `one`, `few`, `many` and `other`, and a translator coming
 * from a two-form language will supply two and leave 5 through 21 reading as "1
 * wymiana". `Intl.PluralRules` is asked which categories the locale actually uses
 * rather than the list being hard-coded.
 */

import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import en from "./locales/en.json";
import pl from "./locales/pl.json";

type Tree = { [key: string]: string | Tree };

/** `{ strip: { readNow: "…" } }` → `{ "strip.readNow": "…" }`. */
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

/** Split `trace.exchanges_one` into its base id and its plural category. */
const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

function pluralGroups(flat: Record<string, string>): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const key of Object.keys(flat)) {
    const match = PLURAL.exec(key);
    if (match === null) continue;
    const [, base, category] = match as unknown as [string, string, string];
    const set = groups.get(base) ?? new Set<string>();
    set.add(category);
    groups.set(base, set);
  }
  return groups;
}

const LOCALES: [string, Tree][] = [
  ["en", en as Tree],
  ["pl", pl as Tree],
];

describe("interface message catalogues", () => {
  const english = flatten(en as Tree);

  it.each(LOCALES.filter(([tag]) => tag !== "en"))(
    "%s has every key English has, and no extras",
    (_tag, tree) => {
      const other = flatten(tree);
      const missing = Object.keys(english).filter((key) => !(key in other));
      const extra = Object.keys(other).filter((key) => !(key in english));

      // Plural keys are exempt from a straight comparison: `_few` and `_many` exist in
      // Polish and must not exist in English, which is the point of the next test.
      const isPlural = (key: string) => PLURAL.test(key);
      expect(missing.filter((k) => !isPlural(k)), `missing: ${missing.join(", ")}`).toEqual([]);
      expect(extra.filter((k) => !isPlural(k)), `unknown: ${extra.join(", ")}`).toEqual([]);
    },
  );

  it.each(LOCALES)("%s supplies every plural category its language uses", (tag, tree) => {
    const rules = new Intl.PluralRules(tag);
    const required = new Set(rules.resolvedOptions().pluralCategories);
    const gaps: string[] = [];

    for (const [base, present] of pluralGroups(flatten(tree))) {
      for (const category of required) {
        if (!present.has(category)) gaps.push(`${base}_${category}`);
      }
    }
    expect(gaps, `${tag} is missing plural forms: ${gaps.join(", ")}`).toEqual([]);
  });

  it("every plural id is plural in every locale", () => {
    // A counted message that is plural in English but a single string in Polish reads
    // as "5 wymiana". Catching the shape mismatch is cheaper than catching the text.
    const bases = LOCALES.map(([tag, tree]) => [tag, pluralGroups(flatten(tree))] as const);
    const [, reference] = bases[0] as unknown as [string, Map<string, Set<string>>];
    for (const [tag, groups] of bases.slice(1)) {
      expect([...reference.keys()].sort(), `${tag} disagrees about which ids are plural`).toEqual(
        [...groups.keys()].sort(),
      );
    }
  });

  it("interpolates the same variables in every locale", () => {
    // `{{count}}` dropped from a translation is invisible until someone reads the
    // sentence and finds the number gone.
    const names = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const other = flatten(pl as Tree);
    const mismatched: string[] = [];

    for (const [key, text] of Object.entries(english)) {
      const counterpart = other[key];
      if (counterpart === undefined) continue;
      const want = names(text);
      const got = names(counterpart);
      if (want.join(",") !== got.join(",")) mismatched.push(`${key}: en{${want}} pl{${got}}`);
    }
    expect(mismatched, mismatched.join(" · ")).toEqual([]);
  });

  describe("plural selection through i18next", () => {
    // The catalogue being complete is one thing; the runtime choosing the right entry
    // is another, and this needs no browser — it is `Intl.PluralRules` and a lookup.
    beforeAll(async () => {
      await i18next.init({
        lng: "pl",
        fallbackLng: "en",
        supportedLngs: ["en", "pl"],
        defaultNS: "app",
        resources: { en: { app: en }, pl: { app: pl } },
        interpolation: { escapeValue: false },
      });
    });

    /**
     * 1 → one, 2 → few, 5 → many, and then the part a two-form language gets wrong:
     * 22 goes back to `few` and 25 to `many`, because Polish counts by the last digit
     * except in the teens.
     */
    it.each([
      [1, "wymiana"],
      [2, "wymiany"],
      [5, "wymian"],
      [22, "wymiany"],
      [25, "wymian"],
      [112, "wymian"],
    ])("%i takes the form ending in %s", (count, form) => {
      const text = i18next.t("trace.exchanges", { count, ms: 0, lng: "pl" });
      expect(text, `${count} rendered as "${text}"`).toBe(`${count} ${form} · 0 ms`);
    });

    it("agrees with Intl.PluralRules about which form each count takes", () => {
      // Rather than trusting the table above, check the runtime picks the category the
      // platform says it should — this catches a catalogue whose `_few` and `_many` are
      // swapped, which reads plausibly and is wrong.
      const rules = new Intl.PluralRules("pl");
      const forms = pl.trace as Record<string, string>;
      for (const count of [1, 2, 3, 4, 5, 11, 21, 22, 25, 101, 112]) {
        const category = rules.select(count);
        const expected = (forms[`exchanges_${category}`] ?? "")
          .replace("{{count}}", String(count))
          .replace("{{ms}}", "0");
        expect(i18next.t("trace.exchanges", { count, ms: 0, lng: "pl" }), `count ${count}`).toBe(
          expected,
        );
      }
    });
  });
});