/**
 * Resolving a translation.
 *
 * The whole safety property of this package is that it only ever *reads*. Nothing
 * here returns a string that could be fed back into the database as a key, and
 * the resolution order always ends at the original French, so a missing entry
 * degrades to the untranslated text rather than to nothing.
 *
 * Resolution, most specific first:
 *
 *   1. `ecu:<slug>` scope     — an override for one ECU
 *   2. `group:<group>` scope  — an override for one ECU group
 *   3. no scope               — the common case
 *   4. the source string      — French passthrough
 *
 * Scopes 1 and 2 exist so a bad disambiguation can be fixed without forking the
 * global entry; they are expected to stay near-empty.
 */

import { digest, type Namespace } from "./keys.js";

/**
 * A translation, and where it came from.
 *
 * `machine` entries are shown with a marker in the UI, and a re-run of machine
 * translation must never overwrite a `human` one.
 */
export type Origin = "human" | "machine";

/** Bundle value: bare string for human-reviewed, `[text, 1]` for machine. */
export type BundleValue = string | readonly [string, 1];

/** `<namespace>:<hash>` → translation, optionally scoped by a prefix. */
export type Bundle = Readonly<Record<string, BundleValue>>;

export interface OverlayManifest {
  format: 1;
  locale: string;
  /** Counts per namespace, for the coverage report. */
  counts: Readonly<Record<string, number>>;
}

export interface Scope {
  /** ECU slug, for a per-ECU override. */
  ecu?: string;
  /** ECU group, for a per-group override. */
  group?: string;
}

export interface Translation {
  text: string;
  origin: Origin | "source";
}

/**
 * An in-memory overlay.
 *
 * Hashing is async, so strings are hashed once up front via {@link prime} and
 * cached; `resolve` is then synchronous, which is what a render path needs.
 */
export class Overlay {
  private readonly hashes = new Map<string, string>();

  private constructor(
    readonly locale: string,
    private readonly bundle: Bundle,
  ) {}

  static create(locale: string, bundle: Bundle): Overlay {
    return new Overlay(locale, bundle);
  }

  /** An overlay that always falls through — used when no locale is selected. */
  static none(): Overlay {
    return new Overlay("fr", {});
  }

  get size(): number {
    return Object.keys(this.bundle).length;
  }

  /**
   * Hash a batch of source strings so {@link resolve} can be synchronous.
   *
   * Call this once per loaded ECU with everything its screens might display.
   * Already-hashed strings are skipped, so calling it repeatedly is cheap.
   */
  async prime(sources: Iterable<string>): Promise<void> {
    const pending: string[] = [];
    for (const source of sources) {
      if (source !== "" && !this.hashes.has(source)) pending.push(source);
    }
    // Deduplicate before hashing: a screen commonly repeats the same caption.
    const unique = [...new Set(pending)];
    const digests = await Promise.all(unique.map((source) => digest(source)));
    unique.forEach((source, i) => this.hashes.set(source, digests[i] as string));
  }

  /**
   * The translation for a source string, or the source itself.
   *
   * Returns the source unchanged when the string wasn't primed, so a caller that
   * forgets to prime degrades to French rather than to a blank cell.
   */
  resolve(namespace: Namespace, source: string, scope: Scope = {}): Translation {
    if (source === "") return { text: source, origin: "source" };
    const hash = this.hashes.get(source);
    if (hash === undefined) return { text: source, origin: "source" };

    const suffix = `${namespace}:${hash}`;
    const candidates =
      scope.ecu !== undefined && scope.group !== undefined
        ? [`ecu:${scope.ecu}/${suffix}`, `group:${scope.group}/${suffix}`, suffix]
        : scope.ecu !== undefined
          ? [`ecu:${scope.ecu}/${suffix}`, suffix]
          : scope.group !== undefined
            ? [`group:${scope.group}/${suffix}`, suffix]
            : [suffix];

    for (const key of candidates) {
      const hit = this.bundle[key];
      if (hit === undefined) continue;
      return typeof hit === "string"
        ? { text: hit, origin: "human" }
        : { text: hit[0], origin: "machine" };
    }

    return { text: source, origin: "source" };
  }

  /** Just the text, for the common case. */
  t(namespace: Namespace, source: string, scope: Scope = {}): string {
    return this.resolve(namespace, source, scope).text;
  }

  /** Was this string left untranslated? Drives the dev-mode highlight. */
  isUntranslated(namespace: Namespace, source: string, scope: Scope = {}): boolean {
    return source !== "" && this.resolve(namespace, source, scope).origin === "source";
  }
}
