# User guide

For operating ddtx on a car. The rest of `docs/` explains how it works inside; this
one only covers what you click and what it means.

**Live at [ddtx.emdzej.pl](https://ddtx.emdzej.pl/).** Nothing is uploaded anywhere —
the database lives in your browser and the adapter talks straight to the page.

> **Before a vehicle.** Nothing has been written to a real car by this port. Reads are
> verified on a Renault Master II; writes are gated, and the thirteen ported procedures
> are marked unverified because they are. An airbag reset or an EEPROM erase is not
> something to try speculatively on a car you need to drive.

---

## 1. First run: get the database in

ddtx ships without ECU definitions. They are 1,580 ECUs and 1.19 GB unpacked, and they
are not ours to redistribute, so the first screen asks for them.

**Choose `ecu.zip`** — the recommended path, and the only one that never asks again.
The archive is unpacked into the browser's private storage, which takes about fifteen
seconds. Reload and it is simply there.

Two other routes sit behind *I already have a split tree*:

| | |
| --- | --- |
| **A folder on disk** | A tree produced by `db-split`. Nothing is copied, but the browser drops file permission on every reload, so you re-grant it each time. Chromium-based browsers only |
| **A URL** | A static host serving the tree, or this project's dev server |

Whatever you pick is checked before anything is installed: the archive must actually
be a zip, must contain `db.json`, and that file must parse. If it does not, you get a
list of what is wrong rather than a broken install — and your existing database is
left untouched. Details in [`database-install.md`](database-install.md).

To change or remove it later: **Database** in the toolbar.

## 2. Demo mode, and a real car

Out of the box you are in **demo mode**. Every ECU and every screen is browsable and
values are produced from the database itself — no adapter, no car. It is the right
place to learn where things are.

The **Demo** badge opens what those values are made of:

| Fill | |
| --- | --- |
| **Stored replies only** | Just what the database recorded. Many fields stay empty |
| **Stored, padded** | Stored replies extended so every field decodes. The default |
| **All generated** | Everything synthesised — useful for checking layout and text length |

**Vary values between reads** makes *Read now* return something different each time, so
you can tell a live-looking screen from a frozen one.

### Connecting

**Connect vehicle** asks the browser for the serial port your ELM327 is on. This needs
Web Serial, so **Chrome or Edge** — Firefox and Safari have no such API and the button
will not appear.

Once connected the toolbar turns **red** and the badge reads `LIVE`. That colour is the
only thing you need to check before doing anything: red means a real car is on the
other end. **Measure link** reports the round-trip time to the adapter if you want to
know the link is healthy.

## 3. Finding the module

The left column is the catalogue — all 1,580 ECUs, narrowed top to bottom:

1. **Vehicle** first, because it makes everything below it smaller. Typing `Master`
   cuts 171 groups down to the handful that car actually has.
2. **Group** and **Bus** to narrow further.

Each row shows the ECU's address, its name, and the vehicles it appears on. Pick one
and the middle column fills with its screens.

### Or let the car tell you

**Fitted ECUs → Sweep** asks each address who it is and reports which ones answer. It
only appears once a vehicle is connected, because there is nothing to sweep otherwise,
and it is read-only — nothing is written. This is faster and more honest than guessing
from the catalogue: a module that answers is fitted, one that does not is not there.

Pick a vehicle first and it sweeps the addresses that car uses; with no vehicle chosen
the button reads *Sweep every mapped address* and does exactly that, which takes longer.

The sweep matches each reply against the catalogue. Three outcomes:

- an **exact** match — identity bytes agree, this is the definition to use;
- an **approximate** match — close enough to be useful, not identical;
- **answered, but no catalogue entry describes it** — the module is real, the database
  has no definition for this exact build.

Bus matters here: a Master II is fifteen K-line modules to two on CAN, so looking only
at CAN on one finds almost nothing. The **Bus** filter in the catalogue is the same
distinction.

## 4. Reading a screen

Screens come from the database exactly as DDT4All authored them — fixed-size canvases
with absolutely-positioned widgets. Pick one from the middle column.

- **Read now** sends that screen's requests once and decodes the replies.
- **Keep reading** polls continuously, for watching something change.
- **Bus trace**, along the bottom, shows the actual exchanges — request, reply, timing.
  Closed by default; it answers "is this screen really talking to the ECU", which is an
  occasional question, and the canvas is worth the third of the height.

Expect a real module to take its time: **299 ms** per exchange on the Master II's ABS,
**885 ms** on its airbag module. That is the ECU, not the link, and not a fault.

### Making a big screen fit

Some screens are far wider than a laptop window, and they cannot reflow — the canvas
size is the database's, not ours.

| | |
| --- | --- |
| **Full screen** (toolbar, or `F`) | Drops the catalogue and screen list, giving the canvas their width — 532 px, or 240 px of height on a narrow window. `Esc` returns |
| **Collapse** (the icon in the catalogue header) | Keeps the screen list, hides the catalogue |
| **Zoom** (View ▾) | Percentages, or **Fit width** to shrink the whole canvas into the column |
| Scrollbars | Both directions, always drawn, on the canvas itself |

Full screen is remembered between visits, but only applies while a screen is open —
deselect and the panels come back, so you are never left without a catalogue.

## 5. Fault codes

With an ECU selected, **Read faults** asks it for what it has stored. Each fault is one
line; click it to see every field the definition decodes.

Reading the fields:

- The **name** is the fault. Where the definition has a label for that code, that label
  *is* the explanation — there is no separate description to fetch.
- Codes the definition's enum does not cover are looked up in the ECU's own catalogue,
  which covers a further 95,135 codes across 1,020 modules. Those are tagged `cat`.
- A code nothing names is tagged `unnamed` and shown as a raw number. That is the
  truth of it: the database has no name for that value on that module.
- **Historical** means it happened; **Current** means it is happening now. A fault that
  is both is worth acting on; historical-only may be long fixed.

Demo mode shows bare numbers here, because simulated values are generated rather than
recorded — read a real module to see real labels.

**Erase** clears stored codes, then reads back to confirm. It is a write, so it needs
the gates below. Codes for faults that are still present will come straight back —
that is the ECU working correctly, not a failed erase.

## 6. Writing to a vehicle

Writes are off by default and stay off until you turn them on. When you do, every write
still has to pass:

| Refusal | What to do |
| --- | --- |
| Writing is turned off | **Allow writing** in the toolbar |
| No vehicle is connected | Demo mode has nothing to write to |
| This tab is in the background | Bring it to the front. A hidden tab's timers are throttled and can stall a write part-way |
| Another ddtx tab is using this adapter | Close it, or disconnect there first |

The middle two exist because a browser tab can be backgrounded, duplicated or closed
mid-write, which a desktop app never has to survive. They are not ceremony.

Widgets you cannot use are marked as blocked with the reason attached, rather than
failing when clicked.

## 7. Procedures

**Procedures** holds the DDT4All service routines, ported to WebAssembly and run in a
sandbox with no imports at all — a procedure can ask the host to send a request and to
log, and can do nothing else.

Fourteen ship: **thirteen procedures** against real modules — UCH, EPS and airbag
resets, card programming, the Zoe water-pump counter — plus a **VIN CRC calculator**
that needs no car and no adapter.

Each declares what it needs before it runs, and the log shows every exchange as it
happens. **All thirteen procedures are unverified against a real vehicle.** The
calculator is arithmetic and safe to use.
[`plugins.md`](plugins.md) covers why the ABI is shaped this way.

## 8. Language

The database is authored in French, and its French strings are also its internal keys,
so translation is an overlay rather than a rewrite. **View ▾ → Language**:

- **Original — as authored** — French, exactly as the database has it.
- **English** — the overlay, where it has an entry.

Coverage is partial and uneven by module. **Mark untranslated gaps** shows you exactly
where it runs out, so a half-translated screen is obvious rather than misleading.
Never assume a missing translation means a missing value.

## 9. When something looks wrong

**Everything reads empty on a real car.** Wrong bus, most likely. Check the sweep found
the module at all, and that the definition you picked matches what answered.

**A value looks absurd** — 63,500 km to the next service, 228 % of something. Very
often that is an all-ones filler byte, meaning "no reading", decoded literally. Compare
against the bus trace: if the raw bytes are `FF`, the module is telling you it has
nothing, not that the value is large.

**A screen is blank or half-drawn.** Some widget captions are genuinely empty in the
database — 1,421 of them — and are decoration, not breakage. **View ▾ → Inspect
layout** outlines every widget so you can see what is there.

**The service light stays on after a reset.** Check the car actually has a maintenance
schedule configured — on some builds `Type de maintenance` reads *Pas de maintenance*,
in which case there is no counter to reset and the light is coming from elsewhere. Not
every car has a cluster definition in the database.

**No Connect vehicle button.** Not Chrome or Edge. Web Serial does not exist elsewhere.

## 10. Keyboard

| | |
| --- | --- |
| `F` | Full screen on/off (ignored while typing) |
| `Esc` | Leave full screen; close a dialog or a dropdown |

---

Found something wrong, or a car this does not cover?
[Open an issue](https://github.com/emdzej/ddtx/issues) — reports from vehicles other
than a Master II are the most useful thing anyone can contribute right now.
