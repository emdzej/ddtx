#!/usr/bin/env python3
"""Generate golden vectors for the @ddtx/codec port by running the original
DDT4All Python codec.

The TypeScript port of `ecu_data.py` is a literal translation, so the only
convincing test is a differential one: feed both implementations the same
inputs and require identical output, including on the quirky paths (lowercase
hex, unclamped overflow, the three-step little-endian layout).

Two vector sets are produced:

  synthetic.json  Hand-built cross product of bit widths, offsets, endianness,
                  scaling and enum cases. Committed — no database content in it.
  db.json         Every receive field of a sample of real ECU files, decoded
                  from deterministic pseudo-random frames. NOT committed: it
                  would embed database strings we don't redistribute.

Where the Python raises (it has several paths that die on malformed input), the
vector records "raises": true and the port is expected to return null instead —
a deliberate divergence, documented in ecuData.ts.

Usage:
    PYTHONPATH=<stub>:<ddt4all>/src python3 generate.py OUTDIR [ECU_ZIP]
"""

import json
import os
import random
import sys
import zipfile

from ddt4all.core.ecu.ecu_data import EcuData
from ddt4all.core.ecu.data_item import DataItem

SENTINEL = object()


def decode_vector(data_def, item_def, endian, resp):
    """Run both codec entry points, recording a raise as `raises: true`."""
    d = EcuData(dict(data_def), "t")
    it = DataItem(dict(item_def), endian or "")
    v = {"data": data_def, "item": item_def, "endian": endian, "resp": resp}
    try:
        v["hex"] = d.getHexValue(resp, it, endian or "")
        v["display"] = d.getDisplayValue(resp, it, endian or "")
    except Exception:
        v["raises"] = True
    return v


def encode_vector(data_def, item_def, endian, value, byte_list):
    d = EcuData(dict(data_def), "t")
    it = DataItem(dict(item_def), endian or "")
    v = {
        "data": data_def,
        "item": item_def,
        "endian": endian,
        "value": value,
        "bytes": list(byte_list),
    }
    work = list(byte_list)
    try:
        out = d.setValue(value, work, it, endian or "")
        v["result"] = None if out is None else list(out)
    except Exception:
        v["raises"] = True
    return v


def synthetic(rng):
    """Cross product of the dimensions that change the algorithm's shape."""
    vectors = {"decode": [], "encode": []}

    widths = [1, 2, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17, 24, 31, 32, 33, 48, 64, 65, 80]
    offsets = [0, 1, 3, 4, 7]
    firstbytes = [1, 2, 3, 5]
    endians = [None, "Big", "Little"]
    item_endians = [None, "Big", "Little"]

    frames = [
        "61 80 1A 3C",
        "6180 1a3c 00FF 8000 7FFF DEADBEEF",
        "00",
        "",
        "FF" * 32,
        "0123456789ABCDEF" * 3,
        "61 80 1A 3",           # odd nibble — Python widens it to a full byte
        "61 80 ZZ 3C",          # non-hex invalidates the whole response
        "   ",
    ]

    # Bit geometry against every frame, both endiannesses.
    for bits in widths:
        for off in offsets:
            for fb in firstbytes:
                for ecu_e in endians:
                    for item_e in item_endians:
                        data = {"bitscount": bits, "bytescount": max(1, (bits + 7) // 8)}
                        item = {"firstbyte": fb, "bitoffset": off}
                        if item_e:
                            item["endian"] = item_e
                        vectors["decode"].append(
                            decode_vector(data, item, ecu_e, rng.choice(frames))
                        )

    # Signed handling, which only applies at bytescount 1 and 2.
    for bc in [1, 2, 3, 4]:
        for signed in [True, False]:
            for frame in ["FF FF FF FF", "80 00 7F FF", "00 01 02 03"]:
                data = {"bitscount": bc * 8, "bytescount": bc, "signed": signed}
                vectors["decode"].append(
                    decode_vector(data, {"firstbyte": 1}, "Big", frame)
                )

    # Scaling: the linear transform plus format-driven precision.
    for step in [1, 0.25, 0.1, 2, 0.0078125, -1]:
        for offset in [0, -40, 100.5]:
            for divideby in [1, 10, 100, 0]:
                for fmt in ["", "#0.00", "#0.0", "0.000", "#0", "bin"]:
                    data = {
                        "bitscount": 16,
                        "bytescount": 2,
                        "scaled": True,
                        "step": step,
                        "offset": offset,
                        "divideby": divideby,
                        "format": fmt,
                    }
                    for frame in ["12 34", "FF FF", "00 00", "7F FF"]:
                        vectors["decode"].append(
                            decode_vector(data, {"firstbyte": 1}, "Big", frame)
                        )

    # Enum maps — including a value with no entry, which falls back to hex.
    for lists in [{"0": "OFF", "1": "ON"}, {"18": "Panne", "255": "Non contrôlé"}]:
        for frame in ["00", "01", "12", "FF"]:
            data = {"bitscount": 8, "bytescount": 1, "lists": lists}
            vectors["decode"].append(decode_vector(data, {"firstbyte": 1}, "Big", frame))

    # ASCII fields, including one wide enough to exceed float64 precision.
    for bc in [1, 4, 8, 17]:
        data = {"bitscount": bc * 8, "bytescount": bc, "byte": True, "bytesascii": True}
        for frame in ["41424344454647484950515253545556575859", "00FF41", "20202020"]:
            vectors["decode"].append(decode_vector(data, {"firstbyte": 1}, "Big", frame))

    # ── encode ──────────────────────────────────────────────────────────────
    blank4 = ["00", "00", "00", "00"]
    blank8 = ["00"] * 8
    prefilled = ["31", "A0", "01", "FF"]

    for bits in [1, 3, 4, 8, 12, 16, 24, 32, 64]:
        for off in [0, 1, 4, 7]:
            for fb in [1, 2, 3]:
                for ecu_e in [None, "Big", "Little"]:
                    data = {"bitscount": bits, "bytescount": max(1, (bits + 7) // 8)}
                    item = {"firstbyte": fb, "bitoffset": off}
                    for value in ["0", "1", "FF", "AB", "FFFF", "123456", "", "ZZ"]:
                        vectors["encode"].append(
                            encode_vector(data, item, ecu_e, value, blank8)
                        )

    # Scaled writes, including a negative result (Python dies; we return null).
    for step in [1, 0.25, 0.1]:
        for offset in [0, -40]:
            for divideby in [1, 10]:
                data = {
                    "bitscount": 16,
                    "bytescount": 2,
                    "scaled": True,
                    "step": step,
                    "offset": offset,
                    "divideby": divideby,
                }
                for value in ["0", "1", "100", "-50", "12.5", "abc", ""]:
                    vectors["encode"].append(
                        encode_vector(data, {"firstbyte": 1}, "Big", value, blank4)
                    )

    # Hex-list input form, and writes into a pre-filled frame.
    for value in [["FF"], ["AB", "CD"], ["A"], ["ABC"], ["GG"]]:
        data = {"bitscount": 16, "bytescount": 2}
        vectors["encode"].append(
            encode_vector(data, {"firstbyte": 2}, "Big", value, prefilled)
        )

    # ASCII writes, including truncation and space padding.
    for bc in [2, 4, 8]:
        data = {"bitscount": bc * 8, "bytescount": bc, "byte": True, "bytesascii": True}
        for value in ["AB", "HELLO", "", "A"]:
            vectors["encode"].append(
                encode_vector(data, {"firstbyte": 1}, "Big", value, blank8)
            )

    # Field running off the end of the frame — Python raises IndexError.
    vectors["encode"].append(
        encode_vector({"bitscount": 32, "bytescount": 4}, {"firstbyte": 3}, "Big", "FF", blank4)
    )

    return vectors


def from_database(zip_path, rng, ecu_sample=40, max_fields=25000):
    """Exercise every field of a sample of real ECUs, both directions.

    Decode frames are deterministic pseudo-random hex, long enough that most
    fields land inside them; the ones that don't exercise the short-frame path,
    which is worth covering too.

    Encode vectors matter more than their count suggests: the write path is the
    one that puts bytes on a live car, and its enum reverse-lookup and overflow
    behaviour have no read-side equivalent. Values are drawn per field type so
    scaled fields get decimals, ASCII fields get text, and the rest get hex.
    """
    z = zipfile.ZipFile(zip_path)
    names = [n for n in z.namelist() if n.endswith(".json") and n != "db.json"]
    picked = rng.sample(names, min(ecu_sample, len(names)))

    decode, encode = [], []
    for name in picked:
        ecu = json.loads(z.read(name))
        endian = ecu.get("endian")
        data_defs = ecu.get("data", {})
        for req in ecu.get("requests", []):
            for data_name, item in (req.get("receivebyte_dataitems") or {}).items():
                if data_name not in data_defs:
                    continue  # the DB has dangling references; skip, don't assert
                frame = "".join(rng.choice("0123456789ABCDEF") for _ in range(64))
                decode.append(decode_vector(data_defs[data_name], item, endian, frame))

            sent = req.get("sentbytes") or ""
            byte_list = [sent[i:i + 2] for i in range(0, len(sent), 2)]
            for data_name, item in (req.get("sendbyte_dataitems") or {}).items():
                if data_name not in data_defs:
                    continue
                d = data_defs[data_name]
                if d.get("bytesascii"):
                    values = ["A", "TEST", "0123456789ABCDEFGH", ""]
                elif d.get("scaled"):
                    values = ["0", "1", "12.5", "-3", "1e3", "", "abc"]
                elif d.get("lists"):
                    # Enum labels feed the reverse lookup — the write-path trap.
                    values = list(d["lists"].values())[:3] + ["0", "FF"]
                else:
                    values = ["0", "1", "FF", "ABCD", "", "ZZ"]
                for value in values:
                    encode.append(
                        encode_vector(d, item, endian, value, byte_list)
                    )

            if len(decode) >= max_fields and len(encode) >= max_fields:
                return decode[:max_fields], encode[:max_fields]

    return decode[:max_fields], encode[:max_fields]


def main():
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)

    rng = random.Random(20260817)
    syn = synthetic(rng)
    with open(os.path.join(outdir, "synthetic.json"), "w") as f:
        json.dump(syn, f, ensure_ascii=False, separators=(",", ":"))
    print(f"synthetic.json: {len(syn['decode'])} decode, {len(syn['encode'])} encode")

    if len(sys.argv) > 2:
        ecus = int(os.environ.get("GOLDEN_ECUS", "40"))
        cap = int(os.environ.get("GOLDEN_MAX", "25000"))
        decode, encode = from_database(
            sys.argv[2], random.Random(20260817), ecu_sample=ecus, max_fields=cap
        )
        with open(os.path.join(outdir, "db.json"), "w") as f:
            json.dump(
                {"decode": decode, "encode": encode}, f, ensure_ascii=False, separators=(",", ":")
            )
        print(f"db.json: {len(decode)} decode, {len(encode)} encode, from {ecus} ECUs")


if __name__ == "__main__":
    main()
