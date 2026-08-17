# Golden vectors

Differential test harness for `@ddtx/codec`. `generate.py` imports the **real
DDT4All Python codec** and records its output; `packages/codec/src/golden.test.ts`
replays those inputs through the TypeScript port and requires identical results.

This exists because the codec is a literal translation of `ecu_data.py`,
quirks included, and the only convincing proof of a literal translation is a
byte-for-byte comparison against the thing it was translated from.

## Running it

`ddt4all` imports `platformdirs` transitively via `options.py`, which isn't
needed for the codec, so a stub keeps the dependency out:

```sh
mkdir -p /tmp/pystub/platformdirs
cat > /tmp/pystub/platformdirs/__init__.py <<'EOF'
import os, tempfile
_BASE = os.path.join(tempfile.gettempdir(), "ddt4all-stub")
class PlatformDirs:
    def __init__(self, *a, **k): pass
    @property
    def user_log_dir(self): return os.path.join(_BASE, "log")
    @property
    def user_config_dir(self): return os.path.join(_BASE, "config")
    @property
    def user_data_dir(self): return os.path.join(_BASE, "data")
    @property
    def user_cache_dir(self): return os.path.join(_BASE, "cache")
def _d(*a, **k): return _BASE
user_log_dir = user_config_dir = user_data_dir = user_cache_dir = _d
EOF

PYTHONPATH=/tmp/pystub:../ext-ddt4all/src \
  python3 tools/golden/generate.py tools/golden/vectors data/ecu.zip
pnpm test
```

## Vector sets

| File | Committed | Contents |
|---|---|---|
| `synthetic.json` | yes | Cross product of bit widths (1–80), offsets, `firstbyte`, both endiannesses plus per-item overrides, sign handling, the scaling transform, enum maps, ASCII fields, and malformed frames |
| `db.json` | **no** | Real fields from a sample of ECU files. Excluded from git because it would embed database strings we don't redistribute |

## Widening the sample

The defaults (40 ECUs, 25k vectors per direction) keep the working tree small.
For a release-gating run:

```sh
GOLDEN_ECUS=400 GOLDEN_MAX=250000 PYTHONPATH=… python3 tools/golden/generate.py …
NODE_OPTIONS=--max-old-space-size=8192 pnpm test
```

That produces ~258 MB of vectors and takes a few seconds to verify.

## What it has already caught

Every one of these passed a reading of the code and failed the diff. They are
the reason this harness exists rather than a handful of hand-written unit tests:

1. **`Number("")` is `0`, `float("")` raises.** An empty input to a scaled field
   encoded as zero and would have been written to a live ECU.
2. **`toFixed` rounds ties away from zero; Python `%.Nf` rounds to even.**
   Wrong last digit on any value whose step is a negative power of two — which
   is most of them.
3. **`TextDecoder` substitutes U+FFFD where `errors="ignore"` drops bytes.**
   ASCII fields read out of partly-binary frames showed `����`.
4. **`String(n)` prints the shortest round-trip; `str(int(x))` prints the
   double's exact value.** Diverges above 2^53, which 64-bit scaled fields reach.
5. **Python switches to scientific notation at `1e-5`, JavaScript at `1e-7`,
   and pads the exponent to two digits.** `4e-05` vs `0.00004`.

Items 4 and 5 only appeared after widening from 40 to 400 ECUs, so treat the
wide run as mandatory before trusting a codec change.
