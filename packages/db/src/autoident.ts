/**
 * Match an ECU's self-reported identity against the database index.
 *
 * Port of `EcuIdent.checkWith` / `checkApproximate` and the closest-version
 * selection in `ecu_scanner.check_ecu2`. Pure and index-only, so it lives here
 * rather than in the scanner: given the four identity fields an ECU reports, it
 * says which database entries could describe it.
 *
 * The matching is looser than it looks, and deliberately so — the database
 * cannot enumerate every firmware build:
 *
 *  - `diagversion` is compared **numerically** as hex, so `"16"` and `"016"` match.
 *  - `supplier`, `soft`, and `version` are **prefix** comparisons, and the
 *    direction matters: the *index* entry must be a prefix of what the *ECU*
 *    reported. A stored `soft` of `"00"` matches a reported `"00EA"`.
 *  - Entries with an empty `diagversion` never match anything.
 */

import type { DbTreeIndex, EcuProtocol, IndexAutoIdent } from "@ddtx/core";

/** What an ECU reported when asked to identify itself. */
export interface ReportedIdentity {
  diagversion: string;
  supplier: string;
  soft: string;
  version: string;
}

/** Which transport the scan found it on. `ISO8` is treated as `KWP`. */
export type ScanProtocol = "CAN" | "KWP";

export interface AutoIdentMatch {
  slug: string;
  ecuname: string;
  group: string;
  address: string;
  protocol: EcuProtocol | "";
  /** The index entry that matched. */
  autoident: IndexAutoIdent;
  /** `exact` passed the full four-field check; `approximate` matched supplier+soft only. */
  quality: "exact" | "approximate";
  /** For approximate matches: |reported version − entry version|, as hex. */
  versionDelta?: number;
}

/** `int("0x" + s, 16)`, or `null` where Python would raise `ValueError`. */
function parseHex(s: string): number | null {
  const t = s.trim();
  if (t.length === 0 || !/^[0-9a-fA-F]+$/.test(t)) return null;
  return Number.parseInt(t, 16);
}

/** `EcuIdent.checkWith` — the full four-field test. */
function checkExact(entry: IndexAutoIdent, reported: ReportedIdentity): boolean {
  if (entry.diagnostic_version === "") return false;

  const a = parseHex(entry.diagnostic_version);
  const b = parseHex(reported.diagversion);
  if (a === null || b === null || a !== b) return false;

  // The stored value must be a prefix of what the ECU reported, not vice versa.
  const prefixes: Array<[string, string]> = [
    [entry.supplier_code.trim(), reported.supplier.trim()],
    [entry.soft_version.trim(), reported.soft.trim()],
    [entry.version.trim(), reported.version.trim()],
  ];
  for (const [stored, seen] of prefixes) {
    if (stored !== seen.slice(0, stored.length)) return false;
  }
  return true;
}

/** `EcuIdent.checkApproximate` — supplier and soft only, both exact. */
function checkApproximate(entry: IndexAutoIdent, reported: ReportedIdentity): boolean {
  if (entry.diagnostic_version === "") return false;
  return (
    entry.supplier_code.trim() === reported.supplier.trim() &&
    entry.soft_version.trim() === reported.soft.trim()
  );
}

/** Does an index entry's protocol belong to the transport we scanned on? */
function protocolMatches(protocol: EcuProtocol | "", scanned: ScanProtocol): boolean {
  const p = protocol.toUpperCase();
  if (p.includes("CAN")) return scanned === "CAN";
  if (p.startsWith("KWP")) return scanned === "KWP";
  // `check_ecu2` folds ISO8 into KWP for the approximate pass; do it in both,
  // since an ISO8 ECU is never reachable over CAN anyway.
  if (p.startsWith("ISO8")) return scanned === "KWP";
  return false;
}

/**
 * All candidates for a reported identity at a given address.
 *
 * Exact matches come first. If there are none, the approximate matches are
 * returned sorted by version distance — mirroring the original, which keeps only
 * the single closest and labels it "not perfect match". Keeping the whole sorted
 * list instead lets the UI offer the runners-up, which the Qt app cannot.
 */
export function matchAutoIdent(
  index: DbTreeIndex,
  address: string,
  reported: ReportedIdentity,
  scanned: ScanProtocol,
): AutoIdentMatch[] {
  const exact: AutoIdentMatch[] = [];
  const approximate: AutoIdentMatch[] = [];
  const wantedAddress = address.trim().toUpperCase();
  const reportedVersion = parseHex(reported.version);

  for (const [slug, entry] of Object.entries(index.ecus)) {
    if (entry.address.trim().toUpperCase() !== wantedAddress) continue;
    if (!protocolMatches(entry.protocol, scanned)) continue;

    for (const autoident of entry.autoidents) {
      const base = {
        slug,
        ecuname: entry.ecuname,
        group: entry.group,
        address: entry.address,
        protocol: entry.protocol,
        autoident,
      };

      if (checkExact(autoident, reported)) {
        exact.push({ ...base, quality: "exact" });
        // The original breaks out of the target loop on the first exact hit;
        // here we finish this entry but don't also record it as approximate.
        break;
      }

      if (checkApproximate(autoident, reported)) {
        const entryVersion = parseHex(autoident.version);
        // Non-hex versions are skipped: "If version contains ASCII characters,
        // I can do nothing for you..." — ecu_scanner.py:128
        if (reportedVersion !== null && entryVersion !== null) {
          approximate.push({
            ...base,
            quality: "approximate",
            versionDelta: Math.abs(entryVersion - reportedVersion),
          });
        }
      }
    }
  }

  if (exact.length > 0) return exact;
  return approximate.sort((a, b) => (a.versionDelta ?? 0) - (b.versionDelta ?? 0));
}
