/**
 * Cross-reference check over an emitted tree.
 *
 * Reads the tree back rather than keeping parsed objects from the split — that would
 * mean holding 1.28 GB of JSON — and it checks what was actually written rather than
 * what was meant to be.
 *
 * Separate from `splitArchive` because it needs random access to both an ECU and its
 * layout, and those arrive from the archive in arbitrary order. Pairing them during
 * the stream would mean buffering unpaired entries, which in the worst case is the
 * 1.28 GB problem again.
 *
 * The browser skips this by default: the findings are diagnostic, identical for a
 * given archive, and the same run happens in CI. See docs/database-install.md §3.
 */

import type { EcuFileDef, LayoutFileDef } from "@ddtx/core";

export interface Finding {
  kind: string;
  ecu: string;
  detail: string;
}

export interface Report {
  counts: Record<string, number>;
  findingCounts: Record<string, number>;
  /** Bounded sample — the full list runs to thousands of entries. */
  samples: Finding[];
}

/** Reads a path relative to the tree root as text. Throws if it is absent. */
export type ReadText = (path: string) => string;

export function validateTree(
  slugs: readonly string[],
  read: ReadText,
  log?: (message: string) => void,
): Report {
  const counts: Record<string, number> = {};
  const findingCounts: Record<string, number> = {};
  const samples: Finding[] = [];

  const bump = (k: string, by = 1): void => {
    counts[k] = (counts[k] ?? 0) + by;
  };
  const finding = (kind: string, ecu: string, detail: string): void => {
    findingCounts[kind] = (findingCounts[kind] ?? 0) + 1;
    if (samples.length < 200) samples.push({ kind, ecu, detail });
  };

  log?.("validating cross-references…");

  for (const slug of slugs) {
    const ecu = JSON.parse(read(`ecu/${slug}.json`)) as EcuFileDef;
    let layout: LayoutFileDef;
    try {
      layout = JSON.parse(read(`layout/${slug}.json`)) as LayoutFileDef;
    } catch {
      finding("ecu without layout", slug, "");
      continue;
    }

    bump("ecus");
    const dataNames = new Set(Object.keys(ecu.data ?? {}));
    const requestNames = new Set((ecu.requests ?? []).map((r) => r.name));

    for (const req of ecu.requests ?? []) {
      bump("requests");
      for (const group of ["sendbyte_dataitems", "receivebyte_dataitems"] as const) {
        for (const name of Object.keys(req[group] ?? {})) {
          bump("dataitems");
          if (!dataNames.has(name)) {
            finding("dataitem names missing data", slug, `${req.name} → ${name}`);
          }
        }
      }
    }

    const screens = layout.screens ?? {};
    for (const [category, members] of Object.entries(layout.categories ?? {})) {
      for (const screen of members) {
        bump("categoryScreenRefs");
        if (screens[screen] === undefined) {
          finding("category names missing screen", slug, `${category} → ${screen}`);
        }
      }
    }

    for (const [screenName, screen] of Object.entries(screens)) {
      bump("screens");

      for (const kind of ["displays", "inputs"] as const) {
        for (const widget of screen[kind] ?? []) {
          bump(kind);
          if (!requestNames.has(widget.request)) {
            finding(`${kind} names missing request`, slug, `${screenName} → ${widget.request}`);
          } else if (widget.text === "") {
            // Decoration, not a binding: 1,421 of these exist and they render as a
            // static box with no value. Counted, never reported.
            bump("unboundDecorations");
          } else if (!dataNames.has(widget.text)) {
            finding(`${kind} names missing data`, slug, `${screenName} → ${widget.text}`);
          }
        }
      }

      for (const button of screen.buttons ?? []) {
        bump("buttons");
        if (button.send === undefined) {
          bump("buttonsWithoutSend");
          continue;
        }
        for (const entry of button.send) {
          bump("buttonSends");
          if (!requestNames.has(entry.RequestName)) {
            finding(
              "button send names missing request",
              slug,
              `${screenName} → ${entry.RequestName}`,
            );
          }
        }
      }

      for (const entry of screen.presend ?? []) {
        bump("presends");
        if (!requestNames.has(entry.RequestName)) {
          finding("presend names missing request", slug, `${screenName} → ${entry.RequestName}`);
        }
      }
    }
  }

  return { counts, findingCounts, samples };
}
