#!/usr/bin/env python3
"""Extract translatable strings from the database, scoped to a vehicle.

Two commands:

    extract <tree> <vehicle-code>...   list what needs translating
    build   <tree>                     turn authored files into hashed bundles

Authoring format is a plain `{source: translation}` map per namespace, under
`i18n/source/<locale>/<namespace>.json`. `build` hashes the sources into the keys
the runtime uses. Authoring against the source text rather than the hash is what
makes the files reviewable and diffable — the hash is a delivery detail.

Strings are classified before being offered for translation, because the database
is only ~12% French: a third is already English (much of it UDS-standard) and a
quarter is language-neutral. Translating blind would mangle more than it fixed.
"""

import collections
import hashlib
import json
import os
import re
import sys
import unicodedata

KEY_BITS = 16

NAMESPACES = [
    "data", "request", "screen", "category", "device", "deviceData",
    "list", "unit", "comment", "label", "button", "message",
]

FR_DIACRITICS = set("éèêëàâçùûôîïœÉÈÊÀÂÇÙÔÎ")

FR_WORDS = set("""de du des le la les un une aux avec pour sur par sans sous et ou au
etat état regime régime defaut défaut moteur capteur vanne debit débit vitesse
apprentissage apprentissages calculateur calculateurs consigne rapport mesure valeur
seuil tension temperature température pression niveau essai panne pannes reinit réinit
lecture ecriture écriture nombre position ouverture fermeture commande arret arrêt
marche presence présence absence droit gauche avant arriere arrière compteur releve
relevé parametre paramètre pedale pédale boite boîte roue allumage injection embrayage
frein huile eau air carburant demande gestion duree durée cycle effacement contact cle
clé porte feu feux alimentation sortie sorties entree entrée entrees entrées defauts
défauts memorisee mémorisée memorisees mémorisées presente présente courant tableau
bord general générale generale actuateur actuateurs voyant reglage réglage
selection sélection choix ancien nouvelle nouveau selon suivant avec""".split())

EN_WORDS = set("""the and of for with without status test failed not completed since
last clear pending confirmed warning indicator requested available mask type category
manufacturer supplier record identifier speed engine value read write count number
time out enabled disabled supported monitor error fault reset request response session
control routine data byte high low left right front rear open close on off yes no true
false ok start stop mode state level temperature pressure voltage current flow
position learned adaptation line lines device devices parameters acoustic
accelerometer ejection generic functions""".split())

IDENTIFIER = re.compile(r"^[A-Za-z0-9_.$\-/\[\]()#]+$")
WORD = re.compile(r"[A-Za-zÀ-ÿ]{2,}")


def classify(text):
    """`fr`, `en`, `neutral`, `unknown`, or `empty`.

    A heuristic, and honest about it: `unknown` means "a human should decide",
    not "translate this". It is dominated by short abbreviations.
    """
    t = text.strip()
    if not t:
        return "empty"
    words = [w.lower() for w in WORD.findall(t)]
    if not words:
        return "neutral"
    # CamelCase or dotted identifiers are UDS/AUTOSAR names, not prose.
    if IDENTIFIER.match(t) and " " not in t and re.search(r"[a-z][A-Z]|\.", t):
        return "neutral"
    if any(c in FR_DIACRITICS for c in t):
        return "fr"
    fr = sum(1 for w in words if w in FR_WORDS)
    en = sum(1 for w in words if w in EN_WORDS)
    if fr > en:
        return "fr"
    if en > fr:
        return "en"
    if len(t) <= 4 and t.upper() == t:
        return "neutral"
    return "unknown"


def digest(source):
    normalised = unicodedata.normalize("NFC", source).encode("utf-8")
    return hashlib.sha256(normalised).hexdigest()[:KEY_BITS]


def ecus_for(tree, codes):
    index = json.load(open(os.path.join(tree, "index.json"), encoding="utf-8"))
    wanted = {c.lower() for c in codes}
    return sorted(
        slug
        for slug, entry in index["ecus"].items()
        if any(p.lower() in wanted for p in entry["projects"])
    ), index


def collect(tree, slugs):
    """namespace -> Counter(source -> occurrences) over the given ECUs."""
    found = collections.defaultdict(collections.Counter)
    for slug in slugs:
        ecu = json.load(open(f"{tree}/ecu/{slug}.json", encoding="utf-8"))
        layout = json.load(open(f"{tree}/layout/{slug}.json", encoding="utf-8"))

        for request in ecu.get("requests", []):
            found["request"][request["name"]] += 1
        for name, definition in ecu.get("data", {}).items():
            found["data"][name] += 1
            if definition.get("unit"):
                found["unit"][definition["unit"]] += 1
            if definition.get("comment"):
                found["comment"][definition["comment"]] += 1
            for label in (definition.get("lists") or {}).values():
                found["list"][label] += 1
        for device in ecu.get("devices", []):
            found["device"][device["name"]] += 1
            for flag in device.get("devicedata", {}):
                found["deviceData"][flag] += 1

        for category in layout.get("categories", {}):
            found["category"][category] += 1
        for name, screen in layout.get("screens", {}).items():
            found["screen"][name] += 1
            for widget in screen.get("labels", []):
                found["label"][widget["text"]] += 1
            for button in screen.get("buttons", []):
                found["button"][button["text"]] += 1
                for message in button.get("messages", []):
                    if message:
                        found["message"][message] += 1
    return found


def cmd_extract(tree, codes, out_path):
    slugs, index = ecus_for(tree, codes)
    found = collect(tree, slugs)

    print(f"{len(slugs)} ECUs for {', '.join(codes)}")
    groups = collections.Counter(index["ecus"][s]["group"] for s in slugs)
    print(f"  groups: {dict(groups.most_common())}\n")

    payload = {"vehicles": codes, "ecus": slugs, "namespaces": {}}
    header = f"{'namespace':12}{'distinct':>9}{'occurs':>8}{'fr':>7}{'unknown':>9}{'offered':>9}"
    print(header)
    total_offered = 0
    for namespace in NAMESPACES:
        counter = found[namespace]
        if not counter:
            continue
        classes = collections.Counter(classify(s) for s in counter)
        # Offered = needs a human decision. `en` and `neutral` are left alone.
        offered = {s: c for s, c in counter.items() if classify(s) in ("fr", "unknown")}
        total_offered += len(offered)
        payload["namespaces"][namespace] = {
            "distinct": len(counter),
            "occurrences": sum(counter.values()),
            "offered": [
                s for s, _ in sorted(offered.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        }
        print(
            f"{namespace:12}{len(counter):>9}{sum(counter.values()):>8}"
            f"{classes['fr']:>7}{classes['unknown']:>9}{len(offered):>9}"
        )
    print(f"{'TOTAL':12}{'':>9}{'':>8}{'':>7}{'':>9}{total_offered:>9}")

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    print(f"\nwrote {out_path}")


def cmd_build(tree, locale, source_dir, out_dir):
    """Hash authored `{source: translation}` files into a runtime bundle."""
    os.makedirs(out_dir, exist_ok=True)
    bundle = {}
    counts = {}
    collisions = []

    for namespace in NAMESPACES:
        path = os.path.join(source_dir, f"{namespace}.json")
        if not os.path.exists(path):
            continue
        authored = json.load(open(path, encoding="utf-8"))
        kept = 0
        for source, target in authored.items():
            # `_`-prefixed keys are notes to the next translator, not strings.
            if source.startswith("_"):
                continue
            # An empty translation means "not done yet"; leaving it out lets the
            # runtime fall through to French rather than render a blank.
            if not isinstance(target, str) or target.strip() == "":
                continue
            key = f"{namespace}:{digest(source)}"
            if key in bundle and bundle[key] != target:
                collisions.append((namespace, source, bundle[key], target))
            bundle[key] = target
            kept += 1
        counts[namespace] = kept

    if collisions:
        print(f"WARNING: {len(collisions)} hash collisions with differing targets:")
        for ns, src, a, b in collisions[:5]:
            print(f"  {ns} {src!r}: {a!r} vs {b!r}")

    with open(os.path.join(out_dir, "bundle.json"), "w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    manifest = {"format": 1, "locale": locale, "counts": counts}
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=1)

    total = sum(counts.values())
    print(f"{locale}: {total} translations across {len(counts)} namespaces")
    for namespace, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {namespace:12}{count:>7}")
    print(f"wrote {out_dir}/bundle.json")


def cmd_coverage(tree, codes, source_dir):
    """How much of a vehicle's visible text is translated?"""
    slugs, _ = ecus_for(tree, codes)
    found = collect(tree, slugs)
    authored = {}
    for namespace in NAMESPACES:
        path = os.path.join(source_dir, f"{namespace}.json")
        if os.path.exists(path):
            authored[namespace] = {
                k: v for k, v in json.load(open(path, encoding="utf-8")).items()
                if not k.startswith("_") and isinstance(v, str) and v.strip()
            }

    print(f"{'namespace':12}{'distinct':>9}{'done':>7}{'%':>6}{'occurs':>9}{'occ %':>7}")
    td = tdone = to = todone = 0
    for namespace in NAMESPACES:
        counter = found[namespace]
        if not counter:
            continue
        have = authored.get(namespace, {})
        # A string that needs no translation counts as covered: the point is what
        # a reader sees in English, not how many entries exist.
        def covered(s):
            return s in have or classify(s) in ("en", "neutral", "empty")
        done = sum(1 for s in counter if covered(s))
        occ = sum(counter.values())
        occ_done = sum(c for s, c in counter.items() if covered(s))
        td += len(counter); tdone += done; to += occ; todone += occ_done
        print(
            f"{namespace:12}{len(counter):>9}{done:>7}{100*done/len(counter):>5.0f}%"
            f"{occ:>9}{100*occ_done/occ:>6.0f}%"
        )
    print(
        f"{'TOTAL':12}{td:>9}{tdone:>7}{100*tdone/td:>5.0f}%{to:>9}{100*todone/to:>6.0f}%"
    )


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    command = sys.argv[1]
    if command == "extract":
        tree, out = sys.argv[2], sys.argv[3]
        cmd_extract(tree, sys.argv[4:], out)
    elif command == "build":
        tree, locale, source_dir, out_dir = sys.argv[2:6]
        cmd_build(tree, locale, source_dir, out_dir)
    elif command == "coverage":
        tree, source_dir = sys.argv[2], sys.argv[3]
        cmd_coverage(tree, sys.argv[4:], source_dir)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
