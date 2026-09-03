#!/usr/bin/env node
/**
 * Validate the interface catalogues, and report what is only worth a warning.
 *
 * `apps/web/src/i18n/parity.test.ts` already fails the build on the things that are
 * unambiguously broken — a missing key, a missing plural category, a dropped
 * `{{variable}}`. This is for the rest, which a test should not fail on:
 *
 *   - **Coverage.** A new locale lands incomplete, and blocking that would mean no
 *     locale could ever be started. So the number is printed, not enforced.
 *   - **Dead keys.** A catalogue entry no call site references — usually a rename that
 *     left the old id behind. A warning rather than an error because ids are also
 *     reached through lookup tables (`REFUSAL_ID`, `SOURCE_LABEL`, `FILL_HELP`), and no
 *     static scan sees every one of those.
 *   - **Probably untranslated.** A value byte-identical to English. Often correct —
 *     "Demo", "CAN" — so there is an allowlist and the rest is a warning.
 *
 * Errors here are the same checks the test makes, repeated so that a translation
 * problem shows up as its own line in the checks list instead of inside a test summary.
 *
 *   node tools/i18n/check-ui.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const LOCALES = join(ROOT, "apps/web/src/i18n/locales");
const SOURCE = join(ROOT, "apps/web/src");
const SOURCE_LOCALE = "en";

/** Values that are meant to be the same in every language. */
const SAME_BY_DESIGN = new Set([
  "Demo",
  "DDTX",
  "CAN",
  "ddtx",
  // Genuinely the same word in Polish.
  "problem",
]);

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

const errors = [];
const warnings = [];

function flatten(tree, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

/** `trace.exchanges_one` → `trace.exchanges`; anything else unchanged. */
const baseId = (key) => {
  const m = PLURAL.exec(key);
  return m === null ? key : m[1];
};

const variables = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");

// ── load ─────────────────────────────────────────────────────────────────────
const tags = readdirSync(LOCALES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const catalogues = new Map();
for (const tag of tags) {
  const path = join(LOCALES, `${tag}.json`);
  try {
    catalogues.set(tag, flatten(JSON.parse(readFileSync(path, "utf8"))));
  } catch (cause) {
    errors.push({ file: path, message: `not valid JSON — ${cause.message}` });
  }
}

const source = catalogues.get(SOURCE_LOCALE);
if (source === undefined) {
  console.error(`no ${SOURCE_LOCALE}.json, so there is nothing to compare against`);
  process.exit(1);
}

// ── every id referenced anywhere in the app ──────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|svelte)$/.test(path) && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const referenced = new Set();
for (const file of walk(SOURCE)) {
  const text = readFileSync(file, "utf8");
  // Any string literal shaped like an id, not just `ui(...)` — ids also live in lookup
  // tables, and matching the shape finds those without a parser.
  for (const m of text.matchAll(/["'`]([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*)["'`]/g)) {
    referenced.add(m[1]);
  }
}

// ── errors: the same ground the test covers ──────────────────────────────────
for (const [tag, catalogue] of catalogues) {
  if (tag === SOURCE_LOCALE) continue;

  const rules = new Intl.PluralRules(tag);
  const needed = new Set(rules.resolvedOptions().pluralCategories);

  // Plural bases are checked once, not once per English form — `exchanges_one` and
  // `exchanges_other` share a base and would each report the whole category list.
  const checkedBases = new Set();

  for (const key of Object.keys(source)) {
    const base = baseId(key);
    if (PLURAL.test(key)) {
      if (checkedBases.has(base)) continue;
      checkedBases.add(base);
      // Plural: the locale needs its own categories, not English's.
      for (const category of needed) {
        if (catalogue[`${base}_${category}`] === undefined) {
          errors.push({ file: `${tag}.json`, message: `missing plural form ${base}_${category}` });
        }
      }
      continue;
    }
    if (catalogue[key] === undefined) {
      errors.push({ file: `${tag}.json`, message: `missing key ${key}` });
      continue;
    }
    if (variables(source[key]) !== variables(catalogue[key])) {
      errors.push({
        file: `${tag}.json`,
        message:
          `${key} interpolates {${variables(catalogue[key])}} ` +
          `but English has {${variables(source[key])}}`,
      });
    }
  }

  for (const key of Object.keys(catalogue)) {
    if (source[key] !== undefined) continue;
    // A plural form English does not have is expected; anything else is a stale id.
    if (PLURAL.test(key) && source[`${baseId(key)}_other`] !== undefined) continue;
    errors.push({ file: `${tag}.json`, message: `unknown key ${key} — not in English` });
  }
}

// ── warnings ─────────────────────────────────────────────────────────────────
const dead = [...new Set(Object.keys(source).map(baseId))]
  .filter((id) => !referenced.has(id))
  .sort();
for (const id of dead) {
  warnings.push({ file: "en.json", message: `${id} is not referenced by any call site` });
}

for (const [tag, catalogue] of catalogues) {
  if (tag === SOURCE_LOCALE) continue;
  const copied = Object.keys(source)
    .filter((key) => catalogue[key] !== undefined)
    .filter((key) => catalogue[key] === source[key])
    .filter((key) => !SAME_BY_DESIGN.has(source[key]))
    .sort();
  for (const key of copied) {
    warnings.push({ file: `${tag}.json`, message: `${key} is identical to English` });
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const sourceIds = new Set(Object.keys(source).map(baseId));

console.log("Interface translations\n");
for (const tag of tags) {
  const catalogue = catalogues.get(tag);
  if (catalogue === undefined) continue;
  if (tag === SOURCE_LOCALE) {
    console.log(`  ${tag.padEnd(4)} ${String(sourceIds.size).padStart(4)} ids   source`);
    continue;
  }
  const present = [...sourceIds].filter((id) =>
    Object.keys(catalogue).some((key) => baseId(key) === id),
  ).length;
  // Floored, so 228 of 229 reads as 99% rather than rounding up to a complete-looking
  // 100% with a key missing.
  const pct = Math.floor((present / sourceIds.size) * 100);
  console.log(
    `  ${tag.padEnd(4)} ${String(present).padStart(4)} ids   ${String(pct).padStart(3)}%` +
      (pct < 100 ? `   ${sourceIds.size - present} missing` : ""),
  );
}

const annotate = process.env.GITHUB_ACTIONS === "true";
const line = (level, { file, message }) =>
  annotate
    ? `::${level} file=${relative(ROOT, join(LOCALES, file))}::${message}`
    : `  ${level === "error" ? "✗" : "!"} ${file}  ${message}`;

if (warnings.length > 0) {
  console.log(`\nwarnings (${warnings.length})`);
  for (const w of warnings) console.log(line("warning", w));
}

if (errors.length > 0) {
  console.log(`\nerrors (${errors.length})`);
  for (const e of errors) console.log(line("error", e));
  console.log("\nTranslations are inconsistent. See the errors above.");
  process.exit(1);
}

console.log(
  warnings.length > 0
    ? "\nNo errors. The warnings above do not fail the build."
    : "\nNo problems.",
);
