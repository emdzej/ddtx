#!/usr/bin/env node
/**
 * Every internal Markdown link and anchor resolves.
 *
 * Cheap to run and it catches the thing nobody notices: a heading gets renumbered or
 * reworded and four documents keep pointing at an anchor that no longer exists. Three
 * such links had accumulated by the time this was written, including two I added.
 *
 * The slug rule is GitHub's, and one detail matters: each space becomes a hyphen
 * *without collapsing runs*, so a heading containing " — " yields two hyphens where
 * the em dash was. Collapsing them — the obvious thing to write — reports working
 * links as broken, which is worse than not checking.
 *
 *   node tools/docs/check-links.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** GitHub's heading → anchor rule. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    // Each space individually, not `\s+` — see the note above.
    .replace(/ /g, "-")
    .replace(/^-+|-+$/g, "");
}

const files = [
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
  "README.md",
  "AGENTS.md",
].filter((f) => existsSync(join(ROOT, f)));

const anchors = new Map();
for (const file of files) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found = new Set();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) found.add(slug(line.replace(/^#+\s*/, "")));
  }
  anchors.set(normalize(file), found);
}

const broken = [];
for (const file of files) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#?$)/.test(target)) {
      // A bare `#fragment` still needs checking; a URL does not.
      if (!target.startsWith("#")) continue;
    }
    const [path, fragment] = target.split("#");
    const resolved = path ? normalize(join(dirname(file), path)) : normalize(file);

    if (!existsSync(join(ROOT, resolved))) {
      broken.push(`${file} → ${target} (no such file)`);
      continue;
    }
    if (!fragment) continue;
    const known = anchors.get(resolved);
    // Only Markdown files have anchors we can know about.
    if (known === undefined) continue;
    if (!known.has(fragment)) broken.push(`${file} → ${target} (no such heading)`);
  }
}

const annotate = process.env.GITHUB_ACTIONS === "true";
console.log(`Markdown links: ${files.length} files checked`);
if (broken.length === 0) {
  console.log("\nAll internal links resolve.");
  process.exit(0);
}
console.log(`\nbroken (${broken.length})`);
for (const b of broken) {
  const file = b.split(" ")[0];
  console.log(annotate ? `::error file=${relative(ROOT, join(ROOT, file))}::${b}` : `  ✗ ${b}`);
}
process.exit(1);
